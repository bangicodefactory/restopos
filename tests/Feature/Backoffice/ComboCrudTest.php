<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\ComboCrud;

use App\Models\Catalog\Combo;
use App\Models\Catalog\ComboItem;
use App\Models\Catalog\Product;
use App\Services\Pos\ComboCartPricer;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * Set menus and their courses (BOF-088, BAN-416).
 *
 * A `combos` row is one **course** — "Starters", "Mains" — and the menu is a product with those
 * courses attached through `combo_product`. The register has known how to sell one since it was
 * written and `ComboPriceDistributor` exists on both sides; there was no way to build one. A formule
 * could only be created by seeder or by SQL.
 */
beforeEach(function (): void {
    $this->other = PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs($this->fx->userWith('backoffice.access', 'catalog.view', 'catalog.manage_products'));
});

function ourCourse(array $overrides = []): Combo
{
    return Combo::query()->create([
        'company_id' => test()->fx->company->getKey(),
        'name' => 'Entrées',
        'base_price' => '5.0000',
        ...$overrides,
    ]);
}

/** @param array<string, mixed> $payload */
function addDish(Combo $combo, array $payload = []): TestResponse
{
    return test()->post("/combos/{$combo->getKey()}/items", [
        'product_variant_id' => test()->fx->variant->getKey(),
        ...$payload,
    ]);
}

it('creates a course', function (): void {
    test()->post('/combos', ['name' => 'Entrées', 'base_price' => '5.00'])
        ->assertSessionHasNoErrors()
        ->assertRedirect();

    expect(Combo::query()->where('name', 'Entrées')->exists())->toBeTrue();
});

it('refuses a course that includes more choices than it accepts', function (): void {
    // Both columns are unsigned with a default of 1, so the database takes every wrong value. This
    // one gives away choices that cannot be made — it reads on screen as a generous menu and is
    // arithmetic that never runs.
    $course = ourCourse();

    test()->patch("/combos/{$course->getKey()}", ['qty_free' => 3, 'qty_max' => 2])
        ->assertSessionHasErrors('qty_free');
});

it('refuses a course that accepts no choice at all', function (): void {
    // `qty_max` of 0 means the course silently disappears from the menu.
    $course = ourCourse();

    test()->patch("/combos/{$course->getKey()}", ['qty_max' => 0])
        ->assertSessionHasErrors('qty_max');
});

it('adds a dish to a course', function (): void {
    $course = ourCourse();

    addDish($course)->assertSessionHasNoErrors()->assertRedirect();

    expect($course->items()->count())->toBe(1);
});

it('refuses another venue dish in a course', function (): void {
    // This would put their item on our kitchen ticket and price it from their catalogue.
    $course = ourCourse();

    addDish($course, ['product_variant_id' => $this->other->variant->getKey()])
        ->assertSessionHasErrors('product_variant_id');
});

it('refuses the same dish twice in one course', function (): void {
    // `combo_items` has a unique index on (combo_id, product_variant_id), so this arrives from the
    // database as a 500 rather than as a field error — and the picker lists every variant, including
    // the ones already on the course.
    $course = ourCourse();

    addDish($course)->assertSessionHasNoErrors();
    addDish($course)->assertSessionHasErrors('product_variant_id');

    expect($course->items()->count())->toBe(1);
});

it('accepts a supplement that makes one choice cheaper', function (): void {
    // The fish option two euros less than the meat is a real menu. `min:0` would refuse it.
    $course = ourCourse();

    addDish($course, ['extra_price' => '-2.00'])->assertSessionHasNoErrors();

    expect((float) $course->items()->value('extra_price'))->toBe(-2.0);
});

it('does not let a dish be reached through the wrong course', function (): void {
    $ours = ourCourse();
    $second = ourCourse(['name' => 'Plats']);

    addDish($second)->assertRedirect();
    $dish = $second->items()->firstOrFail();

    test()->delete("/combos/{$ours->getKey()}/items/{$dish->getKey()}")->assertNotFound();

    expect(ComboItem::query()->whereKey($dish->getKey())->exists())->toBeTrue();
});

// ─────────────────────────────────────────── the count that makes the till ask

it('makes the menu ask the customer to choose', function (): void {
    // `Product::requiresConfigurator()` reads `combo_count > 0`, and nothing but the seeder has
    // ever written that column. Without the bump the menu is sold as an ordinary item: the customer
    // is charged for it, chooses nothing, and the kitchen gets a ticket for a set menu with no
    // dishes on it. The screen would look entirely correct.
    $course = ourCourse();
    $menu = $this->fx->product;

    expect((bool) $menu->fresh()->requiresConfigurator())->toBeFalse();

    test()->post("/combos/{$course->getKey()}/menus", ['product_id' => $menu->getKey()])
        ->assertSessionHasNoErrors();

    expect((int) Product::query()->whereKey($menu->getKey())->value('combo_count'))->toBe(1)
        ->and((bool) $menu->fresh()->requiresConfigurator())->toBeTrue();
});

it('stops the menu asking once its last course is removed', function (): void {
    $course = ourCourse();
    $menu = $this->fx->product;

    test()->post("/combos/{$course->getKey()}/menus", ['product_id' => $menu->getKey()])
        ->assertSessionHasNoErrors();

    test()->delete("/combos/{$course->getKey()}/menus", ['product_id' => $menu->getKey()])
        ->assertSessionHasNoErrors();

    expect((int) Product::query()->whereKey($menu->getKey())->value('combo_count'))->toBe(0);
});

it('counts the courses rather than adding one', function (): void {
    // The column has been written by the seeder alone since the schema was created, so drift is the
    // expected state. An increment would carry it over; a count corrects it.
    $course = ourCourse();
    $menu = $this->fx->product;

    $menu->forceFill(['combo_count' => 7])->save();

    test()->post("/combos/{$course->getKey()}/menus", ['product_id' => $menu->getKey()])
        ->assertSessionHasNoErrors();

    expect((int) Product::query()->whereKey($menu->getKey())->value('combo_count'))->toBe(1);
});

it('refuses to attach a menu from another venue', function (): void {
    $course = ourCourse();

    test()->post("/combos/{$course->getKey()}/menus", ['product_id' => $this->other->product->getKey()])
        ->assertSessionHasErrors('product_id');
});

it('refuses to offer the same course on a menu twice', function (): void {
    $course = ourCourse();
    $menu = $this->fx->product;

    test()->post("/combos/{$course->getKey()}/menus", ['product_id' => $menu->getKey()])
        ->assertSessionHasNoErrors();
    test()->post("/combos/{$course->getKey()}/menus", ['product_id' => $menu->getKey()])
        ->assertSessionHasErrors('product_id');

    expect((int) Product::query()->whereKey($menu->getKey())->value('combo_count'))->toBe(1);
});

// ───────────────────────────────────────────────────────────────── deleting

it('refuses to remove a course a menu still offers', function (): void {
    $course = ourCourse();

    test()->post("/combos/{$course->getKey()}/menus", ['product_id' => $this->fx->product->getKey()])
        ->assertSessionHasNoErrors();

    test()->delete("/combos/{$course->getKey()}")->assertSessionHasErrors('combo');

    expect(Combo::query()->whereKey($course->getKey())->exists())->toBeTrue();
});

it('refuses to remove a course that has been sold', function (): void {
    // `pos_order_lines.combo_id` records which course a child line came from, which is how the
    // receipt explains what the customer chose.
    $course = ourCourse();
    $fx = $this->fx->withSession();

    $orderId = DB::table('pos_orders')->insertGetId([
        'uuid' => (string) Str::uuid(),
        'company_id' => $fx->company->getKey(),
        'pos_config_id' => $fx->config->getKey(),
        'pos_session_id' => $fx->session->getKey(),
        'currency_id' => $fx->currency->getKey(),
        'tracking_number' => 'T-1',
        'access_token' => Str::random(32),
        'state' => 'paid',
        'ordered_at' => now(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    DB::table('pos_order_lines')->insert([
        'uuid' => (string) Str::uuid(),
        'company_id' => $fx->company->getKey(),
        'pos_order_id' => $orderId,
        'product_variant_id' => $fx->variant->getKey(),
        'product_id' => $fx->product->getKey(),
        'uom_id' => $fx->variant->product->uom_id,
        'full_product_name' => 'Entrée',
        'combo_id' => $course->getKey(),
        'quantity' => '1',
        'price_unit' => '5.0000',
        'tax_signature' => '',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    test()->delete("/combos/{$course->getKey()}")->assertSessionHasErrors('combo');
});

it('removes a course nothing points at', function (): void {
    $course = ourCourse();

    test()->delete("/combos/{$course->getKey()}")->assertSessionHasNoErrors()->assertRedirect();

    expect(Combo::query()->whereKey($course->getKey())->exists())->toBeFalse();
});

it('refuses everything to someone who may only look', function (): void {
    $this->actingAs($this->fx->userWith('backoffice.access', 'catalog.view'));

    test()->post('/combos', ['name' => 'Entrées'])->assertForbidden();
});

// ───────────────────────────────────────── the built menu, priced at the till

it('splits a built menu the way the distributor says', function (): void {
    // The acceptance criterion. A menu built here has to price the same way one built by seeder
    // does: `ComboPriceDistributor` weights each child by its *course's* `base_price`, not by the
    // dish's own price, and the residue lands on the last child. Nothing between this screen and the
    // till is asserted anywhere else.
    $starters = ourCourse(['name' => 'Entrées', 'base_price' => '5.0000']);
    $mains = ourCourse(['name' => 'Plats', 'base_price' => '5.0000']);

    addDish($starters)->assertSessionHasNoErrors();
    addDish($mains, ['product_variant_id' => $this->fx->drinkVariant->getKey()])->assertSessionHasNoErrors();

    $menu = $this->fx->product;
    $this->fx->variant->forceFill(['list_price' => '9.9900'])->save();

    foreach ([$starters, $mains] as $course) {
        test()->post("/combos/{$course->getKey()}/menus", ['product_id' => $menu->getKey()])
            ->assertSessionHasNoErrors();
    }

    $parent = (string) Str::uuid();
    $childA = (string) Str::uuid();
    $childB = (string) Str::uuid();

    // A child names the `combo_items` row it was chosen from, and the pricer reads its course
    // through that — the group's `base_price` is the weight.
    $prices = app(ComboCartPricer::class)->priceCart($this->fx->config->fresh(), null, [
        ['uuid' => $parent, 'variant_id' => $this->fx->variant->getKey(), 'quantity' => '1'],
        ['uuid' => $childA, 'variant_id' => $this->fx->variant->getKey(), 'combo_parent_uuid' => $parent, 'combo_item_id' => $starters->items()->value('id'), 'quantity' => '1'],
        ['uuid' => $childB, 'variant_id' => $this->fx->drinkVariant->getKey(), 'combo_parent_uuid' => $parent, 'combo_item_id' => $mains->items()->value('id'), 'quantity' => '1'],
    ]);

    // Equal weights over 9.99: the half-cent cannot be thrown away, so the residue rides on the
    // last child in stepper order.
    expect(bcadd($prices[$childA], $prices[$childB], 4))->toBe('9.9900')
        ->and($prices[$childA])->toBe('5.0000')
        ->and($prices[$childB])->toBe('4.9900');
});

it('weights the split by the course price, not by what the dish costs alone', function (): void {
    // The distinction that makes a set menu a set menu: a 20 EUR steak inside a 30 EUR menu whose
    // main course is weighted at 20 takes two thirds of it, whatever the steak sells for on its own.
    $starters = ourCourse(['name' => 'Entrées', 'base_price' => '10.0000']);
    $mains = ourCourse(['name' => 'Plats', 'base_price' => '20.0000']);

    addDish($starters)->assertSessionHasNoErrors();
    addDish($mains, ['product_variant_id' => $this->fx->drinkVariant->getKey()])->assertSessionHasNoErrors();

    $menu = $this->fx->product;
    $this->fx->variant->forceFill(['list_price' => '30.0000'])->save();

    foreach ([$starters, $mains] as $course) {
        test()->post("/combos/{$course->getKey()}/menus", ['product_id' => $menu->getKey()])
            ->assertSessionHasNoErrors();
    }

    $parent = (string) Str::uuid();
    $childA = (string) Str::uuid();
    $childB = (string) Str::uuid();

    // A child names the `combo_items` row it was chosen from, and the pricer reads its course
    // through that — the group's `base_price` is the weight.
    $prices = app(ComboCartPricer::class)->priceCart($this->fx->config->fresh(), null, [
        ['uuid' => $parent, 'variant_id' => $this->fx->variant->getKey(), 'quantity' => '1'],
        ['uuid' => $childA, 'variant_id' => $this->fx->variant->getKey(), 'combo_parent_uuid' => $parent, 'combo_item_id' => $starters->items()->value('id'), 'quantity' => '1'],
        ['uuid' => $childB, 'variant_id' => $this->fx->drinkVariant->getKey(), 'combo_parent_uuid' => $parent, 'combo_item_id' => $mains->items()->value('id'), 'quantity' => '1'],
    ]);

    expect($prices[$childA])->toBe('10.0000')
        ->and($prices[$childB])->toBe('20.0000');
});

it('ships the builder something to fill a course with', function (): void {
    test()->withoutVite();

    $course = ourCourse();
    addDish($course)->assertSessionHasNoErrors();

    test()->get("/combos/{$course->getKey()}/edit")
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->where('variants', fn ($rows) => collect($rows)->pluck('id')->contains($this->fx->variant->getKey()))
            ->where('items', fn ($rows) => count($rows) === 1)
            ->has('products')
            ->etc());
});
