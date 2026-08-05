<?php

declare(strict_types=1);

use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Pos\PosConfig;
use App\Models\User;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Schema;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * XCT-101 — tenant isolation.
 *
 * There was none: `scopeForCompany` existed and was called from nowhere, so a second tenant signing
 * into the back office saw the first tenant's registers, products, orders and cash. These assert the
 * boundary from the outside — as a signed-in user of company A — rather than trusting that every
 * query site remembered to scope.
 */
beforeEach(function (): void {
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
    $betaUser = User::factory()->create(['company_id' => $this->beta->company->getKey()]);

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

    $betaUser = User::factory()->create(['company_id' => $this->beta->company->getKey()]);

    // `exists:` validation passes — it does not know about tenants — so without the check the child
    // would be created as a root of company beta, quietly detached from the parent it named.
    $this->actingAs($betaUser)
        ->post('/categories', ['name' => 'Stolen', 'parent_id' => $parent->getKey()])
        ->assertSessionHas('error');

    $this->actingAs(User::factory()->create(['is_super_admin' => true]));
    expect(PosCategory::query()->where('name', 'Stolen')->exists())->toBeFalse();
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
