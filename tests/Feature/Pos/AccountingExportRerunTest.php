<?php

declare(strict_types=1);

use App\Enums\AccountingExportState;
use App\Enums\OrderState;
use App\Models\Catalog\ProductCategory;
use App\Models\Identity\MediaFile;
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

    $csv = Storage::disk($export->file->disk)->get($export->file->path);
    $lines = array_values(array_filter(explode("\n", (string) $csv)));

    expect($lines)->toHaveCount(4); // header + sales + tax + payment

    // Column 5 is `label`. Every data row carries one — the revenue account for sales, the tax
    // group's label for tax, the payment method's ledger code for payments.
    foreach (array_slice($lines, 1) as $line) {
        $label = str_getcsv($line)[4] ?? '';
        expect($label)->not->toBe('');
    }

    expect(str_getcsv($lines[1])[4])->toBe('7011'); // Plats principaux → PCG food revenue
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
            'price_unit' => '10.13',
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
