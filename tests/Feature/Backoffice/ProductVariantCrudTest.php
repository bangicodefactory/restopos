<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\ProductVariantCrud;

use App\Models\Catalog\Product;
use App\Models\Catalog\ProductVariant;
use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * A real permissioned user rather than a super-admin, which bypasses the policy entirely.
 *
 * @param  list<string>  $permissions
 */
function variantActor(PosFixtures $fx, array $permissions): User
{
    $role = Role::query()->create([
        'name' => 'Config manager',
        'slug' => 'config-manager-'.Str::random(6),
        'is_system' => false,
    ]);

    foreach ($permissions as $slug) {
        $permission = Permission::query()->firstOrCreate(['slug' => $slug], ['group' => 'config']);
        DB::table('permission_role')->insertOrIgnore([
            'role_id' => $role->getKey(),
            'permission_id' => $permission->getKey(),
        ]);
    }

    $user = User::factory()->create(['company_id' => $fx->company->getKey(), 'is_super_admin' => false]);
    DB::table('role_user')->insert(['role_id' => $role->getKey(), 'user_id' => $user->getKey()]);

    return $user;
}

beforeEach(function (): void {
    // A decoy venue first, so the acting company is not id 1.
    PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs(variantActor($this->fx, ['catalog.view', 'catalog.manage_products']));
});

/** @param array<string, mixed> $payload */
function addVariant(Product $product, array $payload = []): TestResponse
{
    return test()->postJson("/products/{$product->uuid}/variants", [
        'name_suffix' => 'Large',
        ...$payload,
    ]);
}

/**
 * @param  array<string, mixed>  $payload
 *
 * Addressed by uuid: `ProductVariant` uses `HasUuid`, which binds by uuid without overriding
 * `getRouteKeyName()` — so a route helper built from the id 404s (the BAN-499 contract).
 */
function saveVariant(Product $product, ProductVariant $variant, array $payload): TestResponse
{
    return test()->patchJson("/products/{$product->uuid}/variants/{$variant->uuid}", $payload);
}

function variantSuffixed(string $suffix): ProductVariant
{
    return ProductVariant::query()->where('name_suffix', $suffix)->firstOrFail();
}

/**
 * BOF-087 (BAN-409) — variants.
 *
 * `pos_order_lines.product_variant_id` is what a sale references, so a variant is not a decoration
 * on a product: it *is* the sellable unit. They were listed read-only and every variant in the
 * system came from a seeder, so a venue could not add a large size, give one its own barcode, or
 * set a price supplement.
 */
it('adds a variant', function (): void {
    addVariant($this->fx->product)->assertSessionHasNoErrors()->assertRedirect();

    expect(ProductVariant::query()->where('name_suffix', 'Large')->exists())->toBeTrue();
});

it('names it after the product, so the till button reads properly', function (): void {
    addVariant($this->fx->product)->assertRedirect();

    expect((string) variantSuffixed('Large')->display_name)
        ->toBe($this->fx->product->name.' Large');
});

it('carries a price supplement rather than an absolute price', function (): void {
    // The ticket's acceptance criterion. A supplement is what a venue means by "large is two euros
    // more": reprice the product and every size follows, which an absolute per-variant price would
    // silently stop doing.
    addVariant($this->fx->product, ['price_extra' => '2.00'])->assertRedirect();

    expect((string) variantSuffixed('Large')->price_extra)->toStartWith('2');
});

it('files it against the product company, not the request', function (): void {
    addVariant($this->fx->product)->assertRedirect();

    expect((int) variantSuffixed('Large')->company_id)->toBe((int) $this->fx->company->getKey());
});

it('round-trips the per-variant fields that were seeder-only', function (): void {
    addVariant($this->fx->product)->assertRedirect();
    $variant = variantSuffixed('Large');

    saveVariant($this->fx->product, $variant, [
        'default_code' => 'SOUP-L',
        'barcode' => '5901234123457',
        'price_extra' => '2.50',
        'standard_price' => '1.10',
        'on_hand_qty' => '12',
        'self_order_available' => false,
    ])->assertSessionHasNoErrors()->assertRedirect();

    $saved = variantSuffixed('Large');

    expect((string) $saved->default_code)->toBe('SOUP-L')
        ->and((string) $saved->barcode)->toBe('5901234123457')
        ->and((string) $saved->price_extra)->toStartWith('2.5')
        ->and((string) $saved->on_hand_qty)->toStartWith('12')
        ->and((bool) $saved->self_order_available)->toBeFalse();
});

it('renames the display name when the suffix changes', function (): void {
    addVariant($this->fx->product)->assertRedirect();
    $variant = variantSuffixed('Large');

    saveVariant($this->fx->product, $variant, ['name_suffix' => 'Extra large'])->assertRedirect();

    expect((string) variantSuffixed('Extra large')->display_name)
        ->toBe($this->fx->product->name.' Extra large');
});

// ────────────────────────────────────────────────────────────── barcodes

it('refuses a barcode another variant already owns', function (): void {
    // `product_variants` carries a `unique(company_id, barcode)`, so without the check this is an
    // SQLSTATE 23000 reaching the operator as a 500 that names nothing.
    addVariant($this->fx->product, ['name_suffix' => 'Large', 'barcode' => '5901234123457'])
        ->assertRedirect();

    $response = addVariant($this->fx->product, ['name_suffix' => 'Small', 'barcode' => '5901234123457'])
        ->assertStatus(422);

    expect((string) json_encode($response->json('errors')))->toContain('Large');
});

it('refuses a barcode that already belongs to a product, which the database allows', function (): void {
    // `products` and `product_variants` each carry their *own* unique index, so a variant may legally
    // take a barcode a product already uses. The register's scan index resolves a product barcode
    // only when no variant has claimed it, so the collision silently redirects the scan: the same
    // barcode rings up a different item than it did yesterday and nothing reports a conflict.
    $this->fx->product->forceFill(['barcode' => '5901234123457'])->save();

    $other = Product::query()->create([
        ...$this->fx->product->replicate(['uuid', 'barcode'])->getAttributes(),
        'uuid' => (string) Str::uuid(),
        'name' => 'Autre plat',
        'barcode' => null,
    ]);

    $response = addVariant($other, ['barcode' => '5901234123457'])->assertStatus(422);

    expect((string) json_encode($response->json('errors')))->toContain('product barcode');
});

it('lets a variant keep its own barcode when saved again', function (): void {
    // The self-exclusion the uniqueness check needs, or a variant can never be saved twice.
    addVariant($this->fx->product, ['barcode' => '5901234123457'])->assertRedirect();
    $variant = variantSuffixed('Large');

    saveVariant($this->fx->product, $variant, ['barcode' => '5901234123457', 'price_extra' => '3.00'])
        ->assertSessionHasNoErrors()->assertRedirect();

    expect((string) variantSuffixed('Large')->price_extra)->toStartWith('3');
});

it('lets two variants have no barcode at all', function (): void {
    // A unique index tolerates repeated NULLs, and most variants never get a barcode. Checking a
    // blank as if it were a value would make the second variant impossible to create.
    addVariant($this->fx->product, ['name_suffix' => 'Large'])->assertRedirect();
    addVariant($this->fx->product, ['name_suffix' => 'Small'])->assertSessionHasNoErrors()->assertRedirect();

    expect(ProductVariant::query()->where('product_id', $this->fx->product->getKey())->count())
        ->toBeGreaterThanOrEqual(2);
});

// ────────────────────────────────────────────────────────── archiving

it('archives a variant rather than erasing it', function (): void {
    // Every sold line points at a variant, so a history that cannot say *which* size was sold is
    // worse than a catalogue carrying a discontinued one.
    addVariant($this->fx->product)->assertRedirect();
    $variant = variantSuffixed('Large');

    test()->deleteJson("/products/{$this->fx->product->uuid}/variants/{$variant->uuid}")
        ->assertRedirect();

    expect(ProductVariant::query()->whereKey($variant->getKey())->exists())->toBeFalse()
        ->and(ProductVariant::query()->withTrashed()->whereKey($variant->getKey())->exists())->toBeTrue();
});

it('refuses to archive the last variant', function (): void {
    // A product with none is listable, editable and unsellable: an order line has nothing to
    // reference, so the item appears on the menu and cannot be added, with nothing explaining why.
    $only = $this->fx->variant;

    $response = test()->deleteJson("/products/{$this->fx->product->uuid}/variants/{$only->uuid}")
        ->assertStatus(422);

    expect((string) json_encode($response->json('errors')))->toContain('only variant')
        ->and(ProductVariant::query()->whereKey($only->getKey())->exists())->toBeTrue();
});

it('refuses to archive while a session is open', function (): void {
    addVariant($this->fx->product)->assertRedirect();
    $variant = variantSuffixed('Large');

    $this->fx->withSession();

    test()->deleteJson("/products/{$this->fx->product->uuid}/variants/{$variant->uuid}")
        ->assertStatus(422);

    expect(ProductVariant::query()->whereKey($variant->getKey())->exists())->toBeTrue();
});

it('freezes availability while a session is open, but not the price', function (): void {
    // Same rule as the product: the till holds a bootstrapped catalogue, so existence may not move
    // mid-service. A price may — a sold line records what it charged.
    addVariant($this->fx->product)->assertRedirect();
    $variant = variantSuffixed('Large');

    $this->fx->withSession();

    saveVariant($this->fx->product, $variant, ['active' => false])->assertStatus(422);
    saveVariant($this->fx->product, $variant, ['price_extra' => '4.00'])
        ->assertSessionHasNoErrors()->assertRedirect();

    expect((bool) variantSuffixed('Large')->active)->toBeTrue()
        ->and((string) variantSuffixed('Large')->price_extra)->toStartWith('4');
});

// ────────────────────────────────────────────────────── the wrong product

it('refuses to edit a variant of a different product', function (): void {
    // Both are resolved through the scoped model, so neither can be another tenant's — but nothing
    // stops a request naming product A and a variant of product B, and the write would then land on
    // a variant the operator is not looking at.
    addVariant($this->fx->product)->assertRedirect();
    $variant = variantSuffixed('Large');

    $other = Product::query()->create([
        ...$this->fx->product->replicate(['uuid', 'barcode'])->getAttributes(),
        'uuid' => (string) Str::uuid(),
        'name' => 'Autre plat',
        'barcode' => null,
    ]);

    saveVariant($other, $variant, ['price_extra' => '99.00'])->assertStatus(422);

    expect((string) variantSuffixed('Large')->price_extra)->not->toStartWith('99');
});

it('never touches another company variant', function (): void {
    $other = PosFixtures::make();

    test()->patchJson("/products/{$other->product->uuid}/variants/{$other->variant->uuid}", [
        'price_extra' => '99.00',
    ])->assertNotFound();

    expect((string) ProductVariant::query()->withoutGlobalScopes()
        ->whereKey($other->variant->getKey())->value('price_extra'))->not->toStartWith('99');
});

// ────────────────────────────────────────────────────────────── permission

it('refuses a user who may not configure the register', function (): void {
    addVariant($this->fx->product)->assertRedirect();
    $variant = variantSuffixed('Large');

    test()->actingAs(variantActor($this->fx, ['catalog.view']));

    addVariant($this->fx->product, ['name_suffix' => 'Sneaky'])->assertForbidden();
    saveVariant($this->fx->product, $variant, ['price_extra' => '99.00'])->assertForbidden();
    test()->deleteJson("/products/{$this->fx->product->uuid}/variants/{$variant->uuid}")
        ->assertForbidden();

    expect(ProductVariant::query()->where('name_suffix', 'Sneaky')->exists())->toBeFalse();
});

it('lets several variants have an emptied barcode field', function (): void {
    // An empty text input arrives as `''` and is stored as NULL, by `ConvertEmptyStringsToNull`
    // rather than by anything here — and a unique index tolerates repeated NULLs but not repeated
    // `''`. So the behaviour is right and the reason is a middleware two layers away.
    //
    // Pinned on the outcome, because "the framework happens to cover this" is exactly what a change
    // to the middleware stack removes quietly. Sabotaging the empty-string guard is a no-op *today*
    // for the same reason, which is why the guard is not what this asserts.
    addVariant($this->fx->product, ['name_suffix' => 'Large', 'barcode' => ''])
        ->assertSessionHasNoErrors()->assertRedirect();
    addVariant($this->fx->product, ['name_suffix' => 'Small', 'barcode' => ''])
        ->assertSessionHasNoErrors()->assertRedirect();

    expect(variantSuffixed('Large')->barcode)->toBeNull()
        ->and(variantSuffixed('Small')->barcode)->toBeNull();
});

it('lets a barcode be cleared once set', function (): void {
    // The other direction: a mis-typed barcode has to be removable, and clearing it must not read as
    // "leave it alone".
    addVariant($this->fx->product, ['barcode' => '5901234123457'])->assertRedirect();
    $variant = variantSuffixed('Large');

    saveVariant($this->fx->product, $variant, ['barcode' => ''])
        ->assertSessionHasNoErrors()->assertRedirect();

    expect(variantSuffixed('Large')->barcode)->toBeNull();
});

it('carries a product rename through to every variant name on the till', function (): void {
    // `display_name` embeds the product name and is in `posLoadFields`, so the register renders it
    // directly rather than joining. Without propagation a rename never reaches the till: the button
    // keeps the old wording on every size, and the only fix is to re-save each variant by hand.
    // Probed before this existed — renaming "Margherita" to "Potage du jour" left both variants
    // reading "Margherita".
    addVariant($this->fx->product, ['name_suffix' => 'Large'])->assertRedirect();
    addVariant($this->fx->product, ['name_suffix' => 'Small'])->assertRedirect();

    test()->patchJson("/products/{$this->fx->product->uuid}", ['name' => 'Potage du jour'])
        ->assertSessionHasNoErrors()->assertRedirect();

    expect((string) variantSuffixed('Large')->display_name)->toBe('Potage du jour Large')
        ->and((string) variantSuffixed('Small')->display_name)->toBe('Potage du jour Small');
});

it('renames archived variants too, so restoring one does not resurrect an old name', function (): void {
    addVariant($this->fx->product, ['name_suffix' => 'Large'])->assertRedirect();
    addVariant($this->fx->product, ['name_suffix' => 'Small'])->assertRedirect();

    $archived = variantSuffixed('Small');
    test()->deleteJson("/products/{$this->fx->product->uuid}/variants/{$archived->uuid}")->assertRedirect();

    test()->patchJson("/products/{$this->fx->product->uuid}", ['name' => 'Potage du jour'])
        ->assertRedirect();

    expect((string) ProductVariant::query()->withTrashed()->whereKey($archived->getKey())->value('display_name'))
        ->toBe('Potage du jour Small');
});

it('leaves the variant names alone when the product is saved without a rename', function (): void {
    // What this pins is the outcome, not the mechanism. Keying the rewrite off which keys *arrived*
    // rather than what actually changed is a no-op here — the rewrite would set the same
    // `display_name`, Eloquent would find nothing dirty and skip the write, and `updated_at` would
    // not move. Sabotage confirmed that, so the `realChanges` call is an avoided query on a product
    // with many variants rather than a guard, and it is not claimed as one.
    addVariant($this->fx->product, ['name_suffix' => 'Large'])->assertRedirect();

    $before = (string) variantSuffixed('Large')->updated_at;

    test()->patchJson("/products/{$this->fx->product->uuid}", [
        'name' => $this->fx->product->name,
        'list_price' => '7.00',
    ])->assertRedirect();

    expect((string) variantSuffixed('Large')->updated_at)->toBe($before);
});
