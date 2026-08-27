<?php

declare(strict_types=1);

use App\Enums\AccountingExportState;
use App\Enums\OrderState;
use App\Models\Catalog\ProductCategory;
use App\Models\Identity\MediaFile;
use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use App\Models\Pos\AccountingExport;
use App\Models\Pricing\CashRounding;
use App\Models\User;
use App\Services\Pos\AccountingExportService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-448 — the accounting export must not hand the ledger the same month twice.
 *
 * The original service inserted `accounting_export_session` rows and never read them back, so a
 * second run over the same period produced a second export at full value. Fed to a real ledger
 * that books the month twice, and nothing downstream can tell the two copies apart.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();
    Storage::fake();
});

/** Ring up one order and close the session, leaving frozen summaries behind. */
function closeSessionWith(PosFixtures $fx, string $tender = '24.20'): int
{
    $id = $fx->session->getKey();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand((string) Str::uuid(), [], ['state' => OrderState::Paid->value], [[
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'payment_method_id' => $fx->cash->getKey(),
            'amount' => $tender,
        ]])],
    ])->assertOk();

    test()->withHeaders($fx->headers())
        ->postJson("/api/pos/sessions/{$id}/close", ['counted_cash' => $tender])
        ->assertOk();

    return (int) $id;
}

/**
 * The export's CSV keyed by row kind, each row an associative array of its columns.
 *
 * @return array<string, array<string, string>>
 */
function csvRows(AccountingExport $export): array
{
    $lines = array_values(array_filter(explode("\n", (string) Storage::disk($export->file->disk)->get($export->file->path))));
    $header = str_getcsv(array_shift($lines));

    $out = [];
    foreach ($lines as $line) {
        $row = array_combine($header, str_getcsv($line));
        $out[$row['kind']] = $row;
    }

    return $out;
}

function buildExport(PosFixtures $fx): AccountingExport
{
    return app(AccountingExportService::class)->build(
        companyId: (int) $fx->company->getKey(),
        periodStart: (string) $fx->session->business_date,
        periodEnd: (string) $fx->session->business_date,
    );
}

it('refuses a second export of the same period instead of duplicating its value', function (): void {
    closeSessionWith($this->fx);

    $first = buildExport($this->fx);

    expect($first->state)->toBe(AccountingExportState::Exported)
        ->and((int) $first->session_count)->toBe(1)
        ->and((float) $first->total_sales)->toBe(20.0);

    // The session is spoken for, so there is nothing left to export.
    expect(fn () => buildExport($this->fx))
        ->toThrow(DomainException::class, 'No closed, unexported sessions in that period.');

    // And crucially: no second export row carrying the same money.
    expect(AccountingExport::query()->where('state', AccountingExportState::Exported->value)->count())->toBe(1);
});

it('answers a re-export over the API with 409, not a 500', function (): void {
    $sessionId = closeSessionWith($this->fx);

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$sessionId}/accounting-export")
        ->assertCreated()
        ->assertJsonPath('state', 'exported');

    // Asking again is an ordinary operator action, so it gets an ordinary answer.
    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$sessionId}/accounting-export")
        ->assertStatus(409)
        ->assertJsonPath('error.code', 'conflict');
});

it('reports the rounding term on the export row', function (): void {
    closeSessionWith($this->fx);
    $export = buildExport($this->fx);

    // Present even when zero: sales + tax + rounding − payments is the identity the reader checks,
    // and a missing term makes a balanced export look like it does not add up.
    expect($export->total_rounding)->not->toBeNull()
        ->and((float) $export->total_rounding)->toBe(0.0);
});

it('lets the database refuse a session two exports race for', function (): void {
    $sessionId = closeSessionWith($this->fx);

    // Stand in for the concurrent build that committed a fraction of a second earlier: the read
    // this service does before inserting cannot see it, so only the constraint can stop the second.
    $winner = AccountingExport::query()->create([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'period_start' => $this->fx->session->business_date,
        'period_end' => $this->fx->session->business_date,
        'format' => 'csv',
        'state' => AccountingExportState::Exported->value,
        'session_count' => 1,
    ]);
    DB::table('accounting_export_session')->insert([
        'accounting_export_id' => $winner->getKey(),
        'pos_session_id' => $sessionId,
    ]);

    // Force the loser past the read-time guard the way a real race would.
    DB::table('accounting_exports')->where('id', $winner->getKey())
        ->update(['state' => AccountingExportState::Draft->value]);

    $loser = buildExport($this->fx);

    DB::table('accounting_exports')->where('id', $winner->getKey())
        ->update(['state' => AccountingExportState::Exported->value]);

    expect($loser->state)->toBe(AccountingExportState::Failed)
        // Told what actually happened, not handed a raw constraint name.
        ->and($loser->error_message)->toContain('Another export claimed these sessions first')
        // And the winner still owns the session, exactly once.
        ->and(DB::table('accounting_export_session')->where('pos_session_id', $sessionId)->count())->toBe(1);
});

it('records the pivot row and marks the session exported', function (): void {
    $sessionId = closeSessionWith($this->fx);
    $export = buildExport($this->fx);

    $pivot = DB::table('accounting_export_session')
        ->where('accounting_export_id', $export->getKey())
        ->where('pos_session_id', $sessionId)
        ->count();

    expect($pivot)->toBe(1)
        ->and(DB::table('pos_sessions')->where('id', $sessionId)->value('accounting_exported_at'))->not->toBeNull();
});

it('puts a closed session in exactly one export', function (): void {
    $sessionId = closeSessionWith($this->fx);
    buildExport($this->fx);

    $appearances = DB::table('accounting_export_session')->where('pos_session_id', $sessionId)->count();

    expect($appearances)->toBe(1);
});

it('persists the file and exposes it on an authenticated download route', function (): void {
    closeSessionWith($this->fx);
    $export = buildExport($this->fx);

    expect($export->media_file_id)->not->toBeNull();

    /** @var MediaFile $media */
    $media = $export->file;

    expect($media->collection->value)->toBe('document')
        ->and($media->mime_type)->toBe('text/csv')
        ->and((int) $media->size_bytes)->toBeGreaterThan(0)
        // Never web-served: the takings only come out through the authenticated route.
        ->and($media->is_public)->toBeFalse()
        ->and(Storage::disk($media->disk)->exists($media->path))->toBeTrue();

    $this->actingAs(User::factory()->create(['is_super_admin' => true]))
        ->get(route('accounting-exports.download', ['export' => $export->uuid]))
        ->assertOk()
        ->assertDownload($media->filename);
});

it('refuses the download to an unauthenticated caller', function (): void {
    closeSessionWith($this->fx);
    $export = buildExport($this->fx);

    // The month's takings are never readable without a session.
    $this->get(route('accounting-exports.download', ['export' => $export->uuid]))
        ->assertUnauthorized();
});

it('refuses the download to a user from another company', function (): void {
    closeSessionWith($this->fx);
    $export = buildExport($this->fx);

    // Holding the ability is not enough — the export has to be yours. `BelongsToCompany` is an
    // opt-in scope, so route-model binding resolves any tenant's export from its uuid alone.
    $role = Role::query()->create(['name' => 'Accountant', 'slug' => 'accountant']);
    $permission = Permission::query()->firstOrCreate(
        ['slug' => 'backoffice.export_accounting'],
        ['group' => 'pos'],
    );
    $role->permissions()->syncWithoutDetaching([$permission->getKey()]);

    $outsider = User::factory()->create(['company_id' => (int) $this->fx->company->getKey() + 1]);
    $outsider->roles()->syncWithoutDetaching([$role->getKey()]);

    $this->actingAs($outsider)
        ->get(route('accounting-exports.download', ['export' => $export->uuid]))
        ->assertNotFound();
});

it('lets a super admin cross companies, as it does everywhere else', function (): void {
    closeSessionWith($this->fx);
    $export = buildExport($this->fx);

    $platformOperator = User::factory()->create([
        'is_super_admin' => true,
        'company_id' => (int) $this->fx->company->getKey() + 1,
    ]);

    $this->actingAs($platformOperator)
        ->get(route('accounting-exports.download', ['export' => $export->uuid]))
        ->assertOk();
});

it('carries a ledger code in the CSV label column for every row', function (): void {
    // A configured site: a revenue account on the product's accounting category, a cash account on
    // the payment method. Both are nullable in the schema, so this is what "configured" looks like.
    $category = ProductCategory::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Plats principaux',
        'path' => '/cuisine/plats-principaux',
        'ledger_code' => '7011',
    ]);
    $this->fx->product->forceFill(['product_category_id' => $category->getKey()])->save();
    $this->fx->cash->forceFill(['ledger_code' => '5310'])->save();

    closeSessionWith($this->fx);
    $export = buildExport($this->fx);

    $rows = csvRows($export);

    // Assert on what each row *is*, not on how many the fixture happens to produce.
    expect(array_keys($rows))->toEqualCanonicalizing(['sales', 'tax', 'payment']);

    // Every data row carries a label: the revenue account for sales, the tax group's label for
    // tax, the payment method's ledger code for payments.
    foreach ($rows as $kind => $row) {
        expect($row['label'])->not->toBe('', "the {$kind} row has no label");
    }

    expect($rows['sales']['label'])->toBe('7011')   // Plats principaux → PCG food revenue
        ->and($rows['payment']['label'])->toBe('5310');
});

it('carries the business date on every CSV row', function (): void {
    closeSessionWith($this->fx);
    $export = buildExport($this->fx);

    $expected = (string) $this->fx->session->fresh()->business_date;

    // The header has always promised this column and every row shipped it empty. An export the
    // accountant cannot sort by date is most of the way to useless.
    foreach (csvRows($export) as $kind => $row) {
        expect($row['business_date'])->not->toBe('', "the {$kind} row has no business date")
            ->and($row['business_date'])->toStartWith(substr($expected, 0, 10));
    }
});

it('balances a cash-rounded period to exactly zero', function (): void {
    $rounding = CashRounding::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Nickel',
        'rounding' => '0.05',
        'rounding_method' => 'half_up',
    ]);

    $this->fx->config->forceFill([
        'use_cash_rounding' => true,
        'cash_rounding_id' => $rounding->getKey(),
    ])->save();

    // 3 × 10.00 + 21 % = 36.30 → rounds to 36.30 on the nickel grid; use a quantity that does not.
    $uuid = (string) Str::uuid();
    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid, [[
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'variant_id' => $this->fx->variant->getKey(),
            'qty' => '1',
            // Hand-priced so it lands off the nickel grid; the catalogue price rounds cleanly and
            // would take the rounding this test exists to exercise out of the picture (BAN-502).
            'price_unit' => '10.13',
            'price_type' => 'manual',
            'discount' => '0',
        ]], ['state' => OrderState::Paid->value], [[
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'payment_method_id' => $this->fx->cash->getKey(),
            'amount' => '12.25',
        ]])],
    ])->assertOk();

    $sessionId = (int) $this->fx->session->getKey();
    $order = DB::table('pos_orders')->where('uuid', $uuid)->first();

    // The rounding actually bit, otherwise this test proves nothing.
    expect((float) $order->amount_rounding)->not->toBe(0.0);

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$sessionId}/close", ['counted_cash' => (string) $order->amount_total])
        ->assertOk();

    $export = buildExport($this->fx);

    // sales + tax + rounding − payments. Without the rounding term this period would report a
    // permanent discrepancy that an accountant chases forever.
    expect((float) $export->imbalance_amount)->toBe(0.0)
        // And the term is visible on the row, so the zero is explicable rather than magic.
        ->and((float) $export->total_rounding)->not->toBe(0.0);
});

it('leaves the sessions available when a build blows up', function (): void {
    $sessionId = closeSessionWith($this->fx);

    // A disk that refuses writes fails the build after the pivot rows are inserted.
    //
    // Order matters: this swaps the container's filesystem factory, and the service takes its copy
    // at construction — so it must be resolved *after* the mock, not before.
    Storage::shouldReceive('disk')->andThrow(new RuntimeException('disk is full'));

    $failed = app(AccountingExportService::class)->build(
        companyId: (int) $this->fx->company->getKey(),
        periodStart: (string) $this->fx->session->business_date,
        periodEnd: (string) $this->fx->session->business_date,
    );

    expect($failed->state)->toBe(AccountingExportState::Failed)
        // Rolled back: the session was never claimed, so tomorrow's run still picks it up.
        ->and(DB::table('accounting_export_session')->where('pos_session_id', $sessionId)->count())->toBe(0)
        ->and(DB::table('pos_sessions')->where('id', $sessionId)->value('accounting_exported_at'))->toBeNull();
});

it('carries a ledger code set through the back office, not only one written by hand', function (): void {
    // BAN-501's acceptance criterion, and the link the other tests skip: they build the category
    // with a model call, which proves the export *reads* `ledger_code` but not that anything can
    // *write* it. Until the product-category surface existed, nothing could — the column was
    // settable by the seeder and by direct SQL, so a real venue shipped an export with a blank
    // label on every sales row, which is the column BAN-448 was written to fill.
    $role = Role::query()->create([
        'name' => 'Config manager',
        'slug' => 'config-manager-'.Str::random(6),
        'is_system' => false,
    ]);

    foreach (['backoffice.access', 'backoffice.manage_configs', 'catalog.view', 'catalog.manage_products', 'catalog.manage_categories', 'catalog.manage_taxes', 'restaurant.manage_floors', 'kitchen.view', 'kitchen.manage_displays'] as $slug) {
        $permission = Permission::query()->firstOrCreate(['slug' => $slug], ['group' => 'config']);
        DB::table('permission_role')->insertOrIgnore([
            'role_id' => $role->getKey(),
            'permission_id' => $permission->getKey(),
        ]);
    }

    $manager = User::factory()->create([
        'company_id' => $this->fx->company->getKey(),
        'is_super_admin' => false,
    ]);
    DB::table('role_user')->insert(['role_id' => $role->getKey(), 'user_id' => $manager->getKey()]);

    // Through the endpoint a manager actually uses.
    $this->actingAs($manager)
        ->postJson(route('product-categories.store'), ['name' => 'Plats principaux', 'ledger_code' => '7011'])
        ->assertRedirect();

    $category = ProductCategory::query()->where('name', 'Plats principaux')->firstOrFail();

    $this->fx->product->forceFill(['product_category_id' => $category->getKey()])->save();

    closeSessionWith($this->fx);

    expect(csvRows(buildExport($this->fx))['sales']['label'])->toBe('7011');
});
