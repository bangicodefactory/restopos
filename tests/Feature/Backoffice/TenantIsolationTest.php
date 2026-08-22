<?php

declare(strict_types=1);

use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use App\Models\Pos\PosConfig;
use App\Models\User;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * A user of `$company` who may configure the register.
 *
 * These tests are about *tenancy*, not authorization — but since BAN-422 the category endpoints are
 * policy-gated, so a user with a company and no abilities is refused before the scope is ever
 * consulted, and a 403 would read as "isolation works".
 */
function tenantUser(int $companyId): User
{
    $role = Role::query()->create([
        'name' => 'Config manager',
        'slug' => 'config-manager-'.Str::random(6),
        'is_system' => false,
    ]);

    foreach (['config.view', 'config.manage'] as $slug) {
        $permission = Permission::query()
            ->firstOrCreate(['slug' => $slug], ['group' => 'config']);
        DB::table('permission_role')->insertOrIgnore([
            'role_id' => $role->getKey(),
            'permission_id' => $permission->getKey(),
        ]);
    }

    $user = User::factory()->create(['company_id' => $companyId, 'is_super_admin' => false]);
    DB::table('role_user')->insert(['role_id' => $role->getKey(), 'user_id' => $user->getKey()]);

    return $user;
}

/**
 * XCT-101 — tenant isolation.
 *
 * There was none: `scopeForCompany` existed and was called from nowhere, so a second tenant signing
 * into the back office saw the first tenant's registers, products, orders and cash. These assert the
 * boundary from the outside — as a signed-in user of company A — rather than trusting that every
 * query site remembered to scope.
 */
beforeEach(function (): void {
    // Two of these render the Inertia root view, and the PHP CI job builds no front-end assets — so
    // without this they fail on a missing Vite manifest *only in CI*, where nobody was looking.
    // `RouteBindingTest` has said exactly this since it was written; this file renders the same
    // views and never picked it up. Master's Tests workflow had been red on it for days while the
    // suite passed locally, because a local checkout has `public/build` lying around from a build.
    $this->withoutVite();

    $this->alpha = PosFixtures::make()->withSession();
    $this->beta = PosFixtures::make()->withSession();

    $this->alphaUser = User::factory()->create(['company_id' => $this->alpha->company->getKey()]);
});

it('shows a user none of the other company records', function (): void {
    $this->actingAs($this->alphaUser);

    $configs = PosConfig::query()->pluck('company_id')->unique()->all();
    $products = Product::query()->pluck('company_id')->unique()->all();

    expect($configs)->toBe([$this->alpha->company->getKey()])
        ->and($products)->toBe([$this->alpha->company->getKey()]);

    // …and the other tenant's rows do exist — the assertion above is isolation, not an empty table.
    $this->actingAs(User::factory()->create(['is_super_admin' => true]));
    expect(PosConfig::query()->pluck('company_id')->unique()->count())->toBe(2);
});

it('404s rather than returning another company record by id', function (): void {
    $this->actingAs($this->alphaUser);

    expect(PosConfig::query()->find($this->beta->config->getKey()))->toBeNull()
        ->and(PosConfig::query()->find($this->alpha->config->getKey()))->not->toBeNull();

    // Route-model binding resolves through the same query, so the editor 404s instead of opening
    // another tenant's register.
    $this->get('/pos-configs/'.$this->beta->config->uuid.'/edit')->assertNotFound();
});

it('sees nothing at all when the account belongs to no company', function (): void {
    // Treating "no company" as "every company" is how an under-configured account becomes a breach.
    $this->actingAs(User::factory()->create(['company_id' => null]));

    expect(PosConfig::query()->count())->toBe(0);
});

it('lets a super admin cross companies, as it does everywhere else', function (): void {
    $this->actingAs(User::factory()->create(['is_super_admin' => true]));

    expect(PosConfig::query()->count())->toBeGreaterThanOrEqual(2);
});

it('leaves the device and console paths alone', function (): void {
    // No web guard is authenticated for an API request — devices authenticate through their own
    // middleware and are already scoped by their config. A global scope that reached into those
    // would break every register's catalogue pull.
    $this->alpha->config->forceFill(['use_cash_rounding' => false])->save();

    $this->withHeaders($this->alpha->headers())
        ->getJson('/api/pos/bootstrap')
        ->assertOk();

    // And with nobody signed in at all (console, queues, seeders) everything is visible.
    expect(PosConfig::query()->count())->toBeGreaterThanOrEqual(2);
});

/**
 * Reads are only half of it. A write path that derives the tenant from a constant rather than from
 * the signed-in user hands one company's row to another — and once the read scope lands, the creator
 * cannot even see what they made.
 */
it('stamps a new category with the creating user company, not a default', function (): void {
    $betaUser = tenantUser((int) $this->beta->company->getKey());

    $this->actingAs($betaUser)
        ->post('/categories', ['name' => 'Desserts'])
        ->assertRedirect();

    $this->actingAs(User::factory()->create(['is_super_admin' => true]));

    expect(PosCategory::query()->where('name', 'Desserts')->value('company_id'))
        ->toBe($this->beta->company->getKey());
});

it('refuses to root a category under another company parent', function (): void {
    $parent = PosCategory::query()->create([
        'company_id' => $this->alpha->company->getKey(),
        'name' => 'Alpha only',
        'depth' => 0,
        'path' => '/Alpha only',
    ]);

    $betaUser = tenantUser((int) $this->beta->company->getKey());

    // `exists:` validation passes — it does not know about tenants — so without the check the child
    // would be created as a root of company beta, quietly detached from the parent it named.
    // Refused on the `parent_id` field rather than as a page-level flash since BAN-422, so the
    // message lands next to the control that caused it.
    $this->actingAs($betaUser)
        ->post('/categories', ['name' => 'Stolen', 'parent_id' => $parent->getKey()])
        ->assertSessionHasErrors('parent_id');

    $this->actingAs(User::factory()->create(['is_super_admin' => true]));
    expect(PosCategory::query()->where('name', 'Stolen')->exists())->toBeFalse();
});

/**
 * The query builder is a second query surface that no Eloquent scope can reach, and the back office
 * uses it for exactly the figures that matter — the dashboard totals and the sales reports. These
 * were still cross-tenant after the global scope landed: with one paid order belonging to beta, an
 * alpha user's dashboard read `revenue: 999`.
 */
function betaOrder(object $beta, string $amount = '999.0000'): void
{
    DB::table('pos_orders')->insert([
        'uuid' => (string) Str::uuid(),
        'company_id' => $beta->company->getKey(),
        'pos_config_id' => $beta->config->getKey(),
        'pos_session_id' => $beta->session->getKey(),
        'name' => 'B/0001',
        'access_token' => (string) Str::uuid(),
        'currency_id' => $beta->config->currency_id,
        'tracking_number' => 1,
        'state' => 'paid',
        'ordered_at' => now(),
        'amount_total' => $amount,
        'amount_paid' => $amount,
        'amount_tax' => '0.0000',
        'amount_untaxed' => $amount,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

/** @return array<string, mixed> */
function inertiaProps(TestCase $test, string $url, string $component, string $only): array
{
    $response = $test->withHeaders([
        'X-Inertia' => 'true',
        // Inertia answers 409 when the asset version does not match, telling the client to hard
        // reload. Sending the current one keeps these tests working whether or not the frontend
        // has been built — without it they pass only on a checkout with no manifest.
        'X-Inertia-Version' => PosFixtures::inertiaVersion(),
        'X-Inertia-Partial-Component' => $component,
        'X-Inertia-Partial-Data' => $only,
    ])->get($url);

    return (array) (json_decode((string) $response->getContent(), true)['props'] ?? []);
}

it('keeps another company trade out of the dashboard totals', function (): void {
    betaOrder($this->beta);

    $this->actingAs($this->alphaUser);
    $props = inertiaProps($this, '/', 'Dashboard/Index', 'today,rescueSessions');

    expect($props['today']['revenue'])->toBe('0')
        ->and($props['today']['order_count'])->toBe(0)
        ->and($props['today']['open_sessions'])->toBe(1);

    // The order is real and does count — for the company that took it.
    $this->actingAs(User::factory()->create(['company_id' => $this->beta->company->getKey()]));
    $betaProps = inertiaProps($this, '/', 'Dashboard/Index', 'today');

    expect($betaProps['today']['revenue'])->toBe('999')
        ->and($betaProps['today']['order_count'])->toBe(1);
});

it('keeps another company sales out of the sales report', function (): void {
    // `session_sales_summaries` carries no `company_id` of its own — it hangs off a session — so
    // the only thing isolating this report is the session id list it is keyed by. Driving the real
    // endpoint is what proves the controller asks for that scoping, rather than proving the helper
    // works when called directly.
    DB::table('session_sales_summaries')->insert([
        'pos_session_id' => $this->beta->session->getKey(),
        'pos_category_id' => null,
        'product_id' => null,
        'tax_signature' => '',
        'is_refund' => false,
        'quantity' => '1.0000',
        'base_amount' => '999.0000',
        'discount_amount' => '0.0000',
        'tax_amount' => '0.0000',
        'total_amount' => '999.0000',
        'cost_amount' => '0.0000',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $url = '/reports/sales-details?from=2000-01-01&to=2100-01-01';

    $this->actingAs($this->alphaUser);
    expect(inertiaProps($this, $url, 'Reports/SalesDetails', 'byProduct')['byProduct'])->toBe([]);

    // …and beta does see its own trade, so the emptiness above is isolation, not a broken query.
    $this->actingAs(User::factory()->create(['company_id' => $this->beta->company->getKey()]));
    expect(inertiaProps($this, $url, 'Reports/SalesDetails', 'byProduct')['byProduct'])->toHaveCount(1);
});

it('404s on another company config id in a report filter', function (): void {
    $this->actingAs($this->alphaUser);

    // `nullable|integer` is not a tenancy check — this used to return the named competitor's trade.
    $this->get('/reports/sales-details?config_id='.$this->beta->config->getKey())->assertNotFound();
    $this->get('/reports/order-analytics?config_id='.$this->beta->config->getKey())->assertNotFound();
    $this->get('/reports/sales-details?config_id='.$this->alpha->config->getKey())->assertOk();
});

it('404s on another company session id in the Z-report', function (): void {
    $this->actingAs($this->alphaUser);

    $this->get('/reports/session?session_id='.$this->beta->session->getKey())->assertNotFound();
    $this->get('/reports/session?session_id='.$this->alpha->session->getKey())->assertOk();
});

it('keeps another company print jobs out of the queue', function (): void {
    DB::table('preparation_print_jobs')->insert([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->beta->company->getKey(),
        'pos_config_id' => $this->beta->config->getKey(),
        'job_type' => 'test',
        'payload' => '{}',
        'copies' => 1,
        'state' => 'queued',
        'queued_at' => now(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $this->actingAs($this->alphaUser);

    expect(inertiaProps($this, '/printers', 'Printers/Index', 'queue')['queue'])->toBe([]);
});

/**
 * The second guard, for the surface the first one cannot see.
 *
 * `CompanyScope` isolates models. Nothing isolates `$connection->table(...)`, and the review of this
 * change found four leaks there after the model scope was already in place — including the dashboard
 * revenue figure. So every raw query against a company-owned table has to say how it is scoped.
 *
 * Granularity is per method, not per statement: a method is satisfied if it scopes a query or stamps
 * a `company_id` anywhere in its body. That will not catch a method that scopes one query and
 * forgets a second one beside it. It is a tripwire for the common case — someone adds a raw
 * aggregate to a controller — not a proof.
 */
it('scopes every raw back-office query against a company-owned table', function (): void {
    /**
     * Methods that reach a company-owned table without scoping it themselves, because they have
     * already resolved a scoped parent and every query below keys off its id. Scoping again would
     * be harmless but misleading — it would imply the id could have come from anywhere.
     */
    $keyedOffAScopedParent = [
        // `$session` is `PosSession::findOrFail`, which 404s outside the acting company.
        'ReportController::sessionReport',
        // `$session` is route-model bound, and binding resolves through the global scope.
        'SessionController::show',
    ];

    $companyOwned = collect(['pos_orders', 'pos_sessions', 'preparation_print_jobs', 'cash_movements'])
        ->filter(static fn (string $t): bool => Schema::hasColumn($t, 'company_id'))
        ->all();

    expect($companyOwned)->not->toBeEmpty('the table list is stale — none of these carry company_id');

    $unscoped = [];

    foreach (File::allFiles(app_path('Http/Controllers/Backoffice')) as $file) {
        $controller = $file->getFilenameWithoutExtension();
        $source = (string) file_get_contents($file->getRealPath());

        // Split on method declarations; `[0]` is the file preamble and holds no method body.
        $chunks = preg_split('/\n    (?:public|private|protected)[^\n]*function (\w+)/', $source, -1, PREG_SPLIT_DELIM_CAPTURE);

        for ($i = 1; $i < count($chunks); $i += 2) {
            $method = $chunks[$i];
            $body = $chunks[$i + 1] ?? '';

            $touches = collect($companyOwned)
                ->filter(static fn (string $t): bool => str_contains($body, "table('".$t."')"))
                ->all();

            if ($touches === []) {
                continue;
            }

            $scoped = str_contains($body, 'ActingCompany::scope') || str_contains($body, "'company_id' =>");

            if (! $scoped && ! in_array($controller.'::'.$method, $keyedOffAScopedParent, true)) {
                $unscoped[] = $controller.'::'.$method.' ('.implode(', ', $touches).')';
            }
        }
    }

    expect($unscoped)->toBe(
        [],
        "These back-office methods query a company-owned table through the query builder, where the\n"
            ."global scope cannot reach them, without scoping it or stamping a company_id:\n  "
            .implode("\n  ", $unscoped),
    );
});

/**
 * The guard that makes this stick: a company-owned table whose model forgets `BelongsToCompany`
 * would silently leak, and no isolation test written today would notice tomorrow's model.
 */
it('scopes every model that has a company_id column', function (): void {
    /**
     * `User` is deliberately exempt, and cannot be otherwise: CompanyScope asks the `web` guard who
     * is signed in, and resolving that guard queries `User` — so scoping `User` would recurse
     * through itself on every authenticated request. There is no back-office user-management
     * surface today; when one is built it must scope its own query explicitly, and this is why.
     */
    $exempt = [User::class];

    $unscoped = [];

    foreach (File::allFiles(app_path('Models')) as $file) {
        $class = 'App\\Models\\'.str_replace(['/', '.php'], ['\\', ''], $file->getRelativePathname());

        if (! class_exists($class) || ! is_subclass_of($class, Model::class)) {
            continue;
        }

        $reflection = new ReflectionClass($class);

        if ($reflection->isAbstract()) {
            continue;
        }

        $model = new $class;
        $table = $model->getTable();

        if (! Schema::hasTable($table) || ! Schema::hasColumn($table, 'company_id')) {
            continue;
        }

        if (in_array($class, $exempt, true)) {
            continue;
        }

        if (! in_array(BelongsToCompany::class, class_uses_recursive($class), true)) {
            $unscoped[] = $class;
        }
    }

    expect($unscoped)->toBe(
        [],
        "These models own a `company_id` but do not use BelongsToCompany, so they are not tenant-scoped:\n  "
            .implode("\n  ", $unscoped),
    );
});
