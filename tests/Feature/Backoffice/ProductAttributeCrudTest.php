<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\ProductAttributeCrud;

use App\Models\Catalog\Product;
use App\Models\Catalog\ProductAttribute;
use App\Models\Catalog\ProductAttributeLine;
use App\Models\Catalog\ProductAttributeValue;
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
function optionActor(PosFixtures $fx, array $permissions): User
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
    $this->actingAs(optionActor($this->fx, ['catalog.view', 'catalog.manage_products']));
});

/** @param array<string, mixed> $payload */
function addAttribute(array $payload = []): TestResponse
{
    return test()->postJson(route('product-attributes.store'), ['name' => 'Size', ...$payload]);
}

/** @param array<string, mixed> $payload */
function addValue(ProductAttribute $attribute, array $payload = []): TestResponse
{
    return test()->postJson(route('attribute-values.store', $attribute->getKey()), [
        'name' => 'Large',
        ...$payload,
    ]);
}

function attributeNamed(string $name): ProductAttribute
{
    return ProductAttribute::query()->where('name', $name)->firstOrFail();
}

function valueNamed(string $name): ProductAttributeValue
{
    return ProductAttributeValue::query()->where('name', $name)->firstOrFail();
}

/**
 * BOF-085 (BAN-412) — the options behind "Large / extra cheese / no onions".
 *
 * The consuming half has always worked: the register bootstraps attributes, values, lines and
 * exclusions, `VariantDialog` renders the picker and disables incompatible pairs, and
 * `LinePriceAuthority` verifies the per-value supplement server-side. What did not exist was any way
 * to *author* them — no route, no controller, no page — so every option in every venue came from
 * the seeder.
 */
it('creates an attribute', function (): void {
    addAttribute()->assertSessionHasNoErrors()->assertRedirect();

    expect(ProductAttribute::query()->where('name', 'Size')->exists())->toBeTrue();
});

it('files it against the acting company', function (): void {
    addAttribute()->assertRedirect();

    expect((int) attributeNamed('Size')->company_id)->toBe((int) $this->fx->company->getKey());
});

it('sets the display type, which decides what control the till renders', function (): void {
    // Not cosmetic: `multi` is the only type that lets a guest pick more than one topping.
    addAttribute(['name' => 'Toppings', 'display_type' => 'multi'])->assertRedirect();

    expect(attributeNamed('Toppings')->display_type->value)->toBe('multi');
});

it('refuses a display type the register cannot render', function (): void {
    addAttribute(['display_type' => 'carousel'])->assertStatus(422);
});

it('refuses a second attribute with the same name, in any casing', function (): void {
    // No index forbids it, and it is not a database problem — it is an operator one: the product
    // editor offers both, half the menu ends up on each, and the till renders two identical pickers.
    addAttribute()->assertRedirect();

    addAttribute(['name' => 'SIZE'])->assertStatus(422);
});

// ─────────────────────────────────────────────────────────────────── values

it('adds values to an attribute', function (): void {
    addAttribute()->assertRedirect();
    addValue(attributeNamed('Size'))->assertSessionHasNoErrors()->assertRedirect();

    expect(valueNamed('Large')->product_attribute_id)->toBe(attributeNamed('Size')->getKey());
});

it('refuses two identical values on one attribute', function (): void {
    addAttribute()->assertRedirect();
    addValue(attributeNamed('Size'))->assertRedirect();

    addValue(attributeNamed('Size'), ['name' => 'large'])->assertStatus(422);
});

it('lets two different attributes share a value name', function (): void {
    // "Large" on Size and "Large" on Portion are different questions, and the uniqueness is per
    // attribute for exactly that reason.
    addAttribute()->assertRedirect();
    addAttribute(['name' => 'Portion'])->assertRedirect();

    addValue(attributeNamed('Size'))->assertRedirect();
    addValue(attributeNamed('Portion'))->assertSessionHasNoErrors()->assertRedirect();

    expect(ProductAttributeValue::query()->where('name', 'Large')->count())->toBe(2);
});

it('refuses a value of a different attribute', function (): void {
    addAttribute()->assertRedirect();
    addAttribute(['name' => 'Portion'])->assertRedirect();
    addValue(attributeNamed('Size'))->assertRedirect();

    test()->patchJson(
        route('attribute-values.update', [attributeNamed('Portion')->getKey(), valueNamed('Large')->getKey()]),
        ['name' => 'Hijacked'],
    )->assertStatus(422);

    expect(ProductAttributeValue::query()->where('name', 'Hijacked')->exists())->toBeFalse();
});

// ───────────────────────────────────────────── attaching options to a product

/** @param array<string, mixed> $payload */
function attachLine(PosFixtures $fx, array $payload): TestResponse
{
    return test()->postJson("/products/{$fx->product->uuid}/attribute-lines", $payload);
}

it('offers an attribute on a product with a per-value supplement', function (): void {
    // The ticket's acceptance criterion. The supplement lives on the *line* because "large" is
    // +2.00 on a coffee and +6.00 on a pizza — a venue forced to pick one number stops using this.
    addAttribute()->assertRedirect();
    addValue(attributeNamed('Size'))->assertRedirect();

    attachLine($this->fx, [
        'product_attribute_id' => attributeNamed('Size')->getKey(),
        'values' => [['product_attribute_value_id' => valueNamed('Large')->getKey(), 'price_extra' => '2.00']],
    ])->assertSessionHasNoErrors()->assertRedirect();

    $row = DB::table('product_attribute_line_values')
        ->where('product_id', $this->fx->product->getKey())->first();

    expect($row)->not->toBeNull()
        ->and((string) $row->price_extra)->toStartWith('2');
});

it('refuses a second line for the same attribute', function (): void {
    addAttribute()->assertRedirect();

    $payload = ['product_attribute_id' => attributeNamed('Size')->getKey()];

    attachLine($this->fx, $payload)->assertRedirect();
    attachLine($this->fx, $payload)->assertStatus(422);

    expect(ProductAttributeLine::query()->where('product_id', $this->fx->product->getKey())->count())->toBe(1);
});

it('refuses values that belong to a different attribute', function (): void {
    // Not merely "must exist": offering Size's "Large" while attaching Spice level renders a picker
    // whose options answer two different questions.
    addAttribute()->assertRedirect();
    addAttribute(['name' => 'Spice'])->assertRedirect();
    addValue(attributeNamed('Size'))->assertRedirect();

    attachLine($this->fx, [
        'product_attribute_id' => attributeNamed('Spice')->getKey(),
        'values' => [['product_attribute_value_id' => valueNamed('Large')->getKey()]],
    ])->assertStatus(422);

    expect(DB::table('product_attribute_line_values')->count())->toBe(0);
});

it('never offers another company attribute', function (): void {
    $other = PosFixtures::make();
    $foreign = ProductAttribute::query()->create([
        'company_id' => $other->company->getKey(),
        'name' => 'Theirs',
        'sequence' => 10,
    ]);

    attachLine($this->fx, ['product_attribute_id' => $foreign->getKey()])->assertStatus(422);

    expect(ProductAttributeLine::query()->where('product_id', $this->fx->product->getKey())->count())->toBe(0);
});

it('keeps a value row id across a supplement edit, so orders are not orphaned', function (): void {
    // `pos_order_lines` points at a `product_attribute_line_values` row. Recreating them on every
    // save would break every order that referenced the old ids, which is why the sync upserts.
    addAttribute()->assertRedirect();
    addValue(attributeNamed('Size'))->assertRedirect();

    $line = ['product_attribute_id' => attributeNamed('Size')->getKey()];
    $value = valueNamed('Large')->getKey();

    attachLine($this->fx, [...$line, 'values' => [['product_attribute_value_id' => $value, 'price_extra' => '2.00']]])
        ->assertRedirect();

    $before = (int) DB::table('product_attribute_line_values')->value('id');
    $lineId = (int) ProductAttributeLine::query()->where('product_id', $this->fx->product->getKey())->value('id');

    test()->patchJson("/products/{$this->fx->product->uuid}/attribute-lines/{$lineId}", [
        'values' => [['product_attribute_value_id' => $value, 'price_extra' => '3.50']],
    ])->assertSessionHasNoErrors()->assertRedirect();

    $after = DB::table('product_attribute_line_values')->first();

    expect((int) $after->id)->toBe($before)
        ->and((string) $after->price_extra)->toStartWith('3.5');
});

it('refuses to drop an option an order has recorded', function (): void {
    // Past orders must keep saying what was chosen. Both referencing tables are `restrictOnDelete`,
    // so without the guard this is a 500 — and the *custom* value table is the one likelier to be
    // forgotten, because it is the branch nobody thinks about.
    addAttribute()->assertRedirect();
    addValue(attributeNamed('Size'))->assertRedirect();

    attachLine($this->fx, [
        'product_attribute_id' => attributeNamed('Size')->getKey(),
        'values' => [['product_attribute_value_id' => valueNamed('Large')->getKey(), 'price_extra' => '2.00']],
    ])->assertRedirect();

    $lineValueId = (int) DB::table('product_attribute_line_values')->value('id');
    $lineId = (int) ProductAttributeLine::query()->where('product_id', $this->fx->product->getKey())->value('id');

    // An order line that chose it.
    $fx = $this->fx->withSession();
    $uuid = (string) Str::uuid();
    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        ]])],
    ])->assertOk();

    DB::table('pos_order_line_attribute_value')->insert([
        'pos_order_line_id' => DB::table('pos_order_lines')->value('id'),
        'product_attribute_line_value_id' => $lineValueId,
    ]);

    test()->patchJson("/products/{$this->fx->product->uuid}/attribute-lines/{$lineId}", ['values' => []])
        ->assertStatus(422);

    expect(DB::table('product_attribute_line_values')->count())->toBe(1);
});

it('refuses to remove a line whose options an order recorded', function (): void {
    addAttribute()->assertRedirect();
    addValue(attributeNamed('Size'))->assertRedirect();

    attachLine($this->fx, [
        'product_attribute_id' => attributeNamed('Size')->getKey(),
        'values' => [['product_attribute_value_id' => valueNamed('Large')->getKey()]],
    ])->assertRedirect();

    $lineValueId = (int) DB::table('product_attribute_line_values')->value('id');
    $lineId = (int) ProductAttributeLine::query()->where('product_id', $this->fx->product->getKey())->value('id');

    $fx = $this->fx->withSession();
    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand((string) Str::uuid(), [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        ]])],
    ])->assertOk();

    // The *custom* value table this time — the branch the guard is likeliest to miss.
    DB::table('pos_order_line_custom_attribute_values')->insert([
        'uuid' => (string) Str::uuid(),
        'pos_order_line_id' => DB::table('pos_order_lines')->value('id'),
        'product_attribute_line_value_id' => $lineValueId,
        'custom_value' => 'Joyeux anniversaire',
        'created_at' => now(), 'updated_at' => now(),
    ]);

    test()->deleteJson("/products/{$this->fx->product->uuid}/attribute-lines/{$lineId}")
        ->assertStatus(422);

    expect(ProductAttributeLine::query()->whereKey($lineId)->exists())->toBeTrue();
});

it('removes a line nothing has chosen', function (): void {
    addAttribute()->assertRedirect();
    attachLine($this->fx, ['product_attribute_id' => attributeNamed('Size')->getKey()])->assertRedirect();

    $lineId = (int) ProductAttributeLine::query()->where('product_id', $this->fx->product->getKey())->value('id');

    test()->deleteJson("/products/{$this->fx->product->uuid}/attribute-lines/{$lineId}")->assertRedirect();

    expect(ProductAttributeLine::query()->whereKey($lineId)->exists())->toBeFalse();
});

// ─────────────────────────────────────────────────────── deleting definitions

it('refuses to delete an attribute a product offers', function (): void {
    addAttribute()->assertRedirect();
    attachLine($this->fx, ['product_attribute_id' => attributeNamed('Size')->getKey()])->assertRedirect();

    $response = test()->deleteJson(route('product-attributes.destroy', attributeNamed('Size')->getKey()))
        ->assertStatus(422);

    expect((string) json_encode($response->json('errors')))->toContain('product(s)')
        ->and(ProductAttribute::query()->where('name', 'Size')->exists())->toBeTrue();
});

it('refuses to delete a value a product offers', function (): void {
    addAttribute()->assertRedirect();
    addValue(attributeNamed('Size'))->assertRedirect();

    attachLine($this->fx, [
        'product_attribute_id' => attributeNamed('Size')->getKey(),
        'values' => [['product_attribute_value_id' => valueNamed('Large')->getKey()]],
    ])->assertRedirect();

    test()->deleteJson(route('attribute-values.destroy', [attributeNamed('Size')->getKey(), valueNamed('Large')->getKey()]))
        ->assertStatus(422);

    expect(ProductAttributeValue::query()->where('name', 'Large')->exists())->toBeTrue();
});

it('deletes an attribute nothing offers', function (): void {
    addAttribute()->assertRedirect();

    test()->deleteJson(route('product-attributes.destroy', attributeNamed('Size')->getKey()))->assertRedirect();

    expect(ProductAttribute::query()->where('name', 'Size')->exists())->toBeFalse();
});

// ────────────────────────────────────────────────────────────── permission

it('refuses a user who may not configure the register', function (): void {
    addAttribute()->assertRedirect();
    $attribute = attributeNamed('Size');

    test()->actingAs(optionActor($this->fx, ['catalog.view']));

    addAttribute(['name' => 'Sneaky'])->assertForbidden();
    addValue($attribute)->assertForbidden();
    test()->deleteJson(route('product-attributes.destroy', $attribute->getKey()))->assertForbidden();

    expect(ProductAttribute::query()->where('name', 'Sneaky')->exists())->toBeFalse();
});

it('never touches another company attribute', function (): void {
    $other = PosFixtures::make();
    $foreign = ProductAttribute::query()->create([
        'company_id' => $other->company->getKey(),
        'name' => 'Theirs',
        'sequence' => 10,
    ]);

    test()->patchJson(route('product-attributes.update', $foreign->getKey()), ['name' => 'Mine now'])
        ->assertNotFound();

    expect((string) ProductAttribute::query()->withoutGlobalScopes()->whereKey($foreign->getKey())->value('name'))
        ->toBe('Theirs');
});

it('refuses to edit an attribute line belonging to a different product', function (): void {
    // Both are resolved through the scoped model, so neither can be another tenant's — but nothing
    // stops a request naming product A and a line of product B, and the write would then land on
    // options the operator is not looking at, changing what a different dish charges. Found by
    // sabotage: removing the check left every other test green.
    addAttribute()->assertRedirect();
    addValue(attributeNamed('Size'))->assertRedirect();

    attachLine($this->fx, [
        'product_attribute_id' => attributeNamed('Size')->getKey(),
        'values' => [['product_attribute_value_id' => valueNamed('Large')->getKey(), 'price_extra' => '2.00']],
    ])->assertRedirect();

    $lineId = (int) ProductAttributeLine::query()->where('product_id', $this->fx->product->getKey())->value('id');

    // A second product of the same venue — the interesting case, since tenancy would catch the other.
    $other = Product::query()->create([
        ...$this->fx->product->replicate(['uuid', 'barcode'])->getAttributes(),
        'uuid' => (string) Str::uuid(),
        'name' => 'Autre plat',
        'barcode' => null,
    ]);

    test()->patchJson("/products/{$other->uuid}/attribute-lines/{$lineId}", [
        'values' => [['product_attribute_value_id' => valueNamed('Large')->getKey(), 'price_extra' => '99.00']],
    ])->assertStatus(422);

    expect((string) DB::table('product_attribute_line_values')->value('price_extra'))->toStartWith('2');
});

it('refuses to remove an attribute line belonging to a different product', function (): void {
    addAttribute()->assertRedirect();
    attachLine($this->fx, ['product_attribute_id' => attributeNamed('Size')->getKey()])->assertRedirect();

    $lineId = (int) ProductAttributeLine::query()->where('product_id', $this->fx->product->getKey())->value('id');

    $other = Product::query()->create([
        ...$this->fx->product->replicate(['uuid', 'barcode'])->getAttributes(),
        'uuid' => (string) Str::uuid(),
        'name' => 'Autre plat',
        'barcode' => null,
    ]);

    test()->deleteJson("/products/{$other->uuid}/attribute-lines/{$lineId}")->assertStatus(422);

    expect(ProductAttributeLine::query()->whereKey($lineId)->exists())->toBeTrue();
});
