<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\ProductCrud;

use App\Listeners\InvalidateCatalogCache;
use App\Models\Catalog\Product;
use App\Models\Catalog\ProductCategory;
use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use App\Models\User;
use Illuminate\Events\CallQueuedListener;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Bus;
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
function menuActor(PosFixtures $fx, array $permissions): User
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
    $this->actingAs(menuActor($this->fx, ['config.view', 'config.manage']));
});

/** @param array<string, mixed> $payload */
function addProduct(array $payload = []): TestResponse
{
    return test()->postJson(route('products.store'), [
        'name' => 'Soupe du jour',
        'list_price' => '6.50',
        ...$payload,
    ]);
}

function productNamed(string $name): Product
{
    return Product::query()->where('name', $name)->firstOrFail();
}

/** The edit endpoint, addressed by uuid — `HasUuid` binds by uuid and does not override the key name. */
function saveProduct(Product $product, array $payload): TestResponse
{
    return test()->patchJson("/products/{$product->uuid}", $payload);
}

/**
 * BOF-081…BOF-083 (BAN-407) — the menu.
 *
 * Nothing could create or archive a product, so the menu was whatever the seeder produced, and the
 * editor wrote eight of the table's thirty-one columns: weighed items, stock tracking, product type,
 * unit of measure and every description field were configurable only by SQL.
 */
it('adds a product', function (): void {
    addProduct()->assertRedirect();

    expect(Product::query()->where('name', 'Soupe du jour')->exists())->toBeTrue();
});

it('files it against the acting company', function (): void {
    addProduct()->assertRedirect();

    expect((int) productNamed('Soupe du jour')->company_id)->toBe((int) $this->fx->company->getKey());
});

it('gives the new product a variant, without which it cannot be sold', function (): void {
    // `pos_order_lines` references a *variant*, not a product. A product with none is listable,
    // editable and unsellable — it simply cannot be added to an order, with nothing explaining why.
    addProduct()->assertRedirect();

    $product = productNamed('Soupe du jour');

    expect($product->variants()->count())->toBe(1)
        ->and((string) $product->variants()->first()?->display_name)->toBe('Soupe du jour');
});

// ───────────────────────────────────────────── the columns that were SQL-only

it('creates a weighed product with a unit of measure and stock tracking', function (): void {
    // The ticket's acceptance criterion. `to_weight` is what makes the register read a quantity
    // from the scale instead of counting units.
    $uom = (int) DB::table('uoms')->value('id');

    addProduct([
        'name' => 'Olives',
        'to_weight' => true,
        'uom_id' => $uom,
        'track_stock' => true,
        'allow_negative_stock' => false,
        'product_type' => 'consumable',
    ])->assertSessionHasNoErrors()->assertRedirect();

    $product = productNamed('Olives');

    expect((bool) $product->to_weight)->toBeTrue()
        ->and((int) $product->uom_id)->toBe($uom)
        ->and((bool) $product->track_stock)->toBeTrue()
        ->and((bool) $product->allow_negative_stock)->toBeFalse();
});

it('round-trips every description field', function (): void {
    addProduct()->assertRedirect();
    $product = productNamed('Soupe du jour');

    saveProduct($product, [
        'description_sale' => 'Servie avec du pain.',
        'public_description' => 'Soupe maison, change chaque jour.',
        'internal_note' => 'Reste de la veille.',
    ])->assertSessionHasNoErrors()->assertRedirect();

    $saved = productNamed('Soupe du jour');

    expect((string) $saved->description_sale)->toBe('Servie avec du pain.')
        ->and((string) $saved->public_description)->toBe('Soupe maison, change chaque jour.')
        ->and((string) $saved->internal_note)->toBe('Reste de la veille.');
});

it('round-trips the display fields the register renders', function (): void {
    addProduct()->assertRedirect();
    $product = productNamed('Soupe du jour');

    saveProduct($product, ['color' => 7, 'pos_sequence' => 42, 'is_favorite' => true])
        ->assertSessionHasNoErrors()->assertRedirect();

    $saved = productNamed('Soupe du jour');

    expect((int) $saved->color)->toBe(7)
        ->and((int) $saved->pos_sequence)->toBe(42)
        ->and((bool) $saved->is_favorite)->toBeTrue();
});

it('files a product under an accounting category, which is what its sales export as', function (): void {
    $category = ProductCategory::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Cuisine',
        'path' => '/',
        'ledger_code' => '7011',
    ]);

    addProduct(['product_category_id' => $category->getKey()])->assertRedirect();

    expect((int) productNamed('Soupe du jour')->product_category_id)->toBe((int) $category->getKey());
});

it('refuses a product type the register cannot render', function (): void {
    addProduct(['product_type' => 'sculpture'])->assertStatus(422);
});

// ───────────────────────────────────────────────────────── the pivots

it('refuses a tax that does not exist rather than 500ing', function (): void {
    // Probed on master: `tax_ids: [999999]` was a 500 — the FK violation surfacing as a server error
    // with nothing naming the cause.
    addProduct()->assertRedirect();

    saveProduct(productNamed('Soupe du jour'), ['tax_ids' => [999999]])->assertStatus(422);
});

it('never applies another company tax to this venue sales', function (): void {
    // Probed on master: it attached. That is not a data leak so much as a money one — this venue's
    // sales are then computed at another venue's rate and exported under their tax.
    $other = PosFixtures::make();
    $foreign = (int) $other->tax->getKey();

    addProduct()->assertRedirect();
    $product = productNamed('Soupe du jour');

    saveProduct($product, ['tax_ids' => [$foreign]])->assertStatus(422);

    expect(DB::table('product_tax')->where('product_id', $product->getKey())
        ->where('tax_id', $foreign)->exists())->toBeFalse();
});

it('never files a product under another company menu category', function (): void {
    $other = PosFixtures::make();

    addProduct()->assertRedirect();
    $product = productNamed('Soupe du jour');

    saveProduct($product, ['pos_category_ids' => [$other->category->getKey()]])->assertStatus(422);

    expect(DB::table('pos_category_product')->where('product_id', $product->getKey())->count())->toBe(0);
});

it('applies a tax the venue owns', function (): void {
    addProduct()->assertRedirect();
    $product = productNamed('Soupe du jour');

    saveProduct($product, ['tax_ids' => [$this->fx->tax->getKey()]])
        ->assertSessionHasNoErrors()->assertRedirect();

    expect(DB::table('product_tax')->where('product_id', $product->getKey())
        ->where('tax_id', $this->fx->tax->getKey())->exists())->toBeTrue();
});

it('clears the taxes when an empty list is sent', function (): void {
    addProduct(['tax_ids' => [$this->fx->tax->getKey()]])->assertRedirect();
    $product = productNamed('Soupe du jour');

    expect(DB::table('product_tax')->where('product_id', $product->getKey())->count())->toBe(1);

    saveProduct($product, ['tax_ids' => []])->assertRedirect();

    expect(DB::table('product_tax')->where('product_id', $product->getKey())->count())->toBe(0);
});

// ────────────────────────────────────── what the editor must never write

it('does not let the form rewrite the sales counters', function (): void {
    // `sale_count` and `last_sold_at` are maintained by the code that causes them. A form that can
    // write them is a form that can make the reports disagree with the orders.
    addProduct()->assertRedirect();
    $product = productNamed('Soupe du jour');

    saveProduct($product, ['sale_count' => 9999, 'last_sold_at' => '2020-01-01 00:00:00'])
        ->assertRedirect();

    expect((int) productNamed('Soupe du jour')->sale_count)->toBe(0);
});

it('does not let the form hand pricing authority to the till', function (): void {
    // `LinePriceAuthority` gives the *client* the price for anything whose `special_kind` is not
    // `none`, because tips, deposits and loyalty rewards carry amounts computed elsewhere. Marking
    // an ordinary product `tip` would switch server-side price verification off for it, and a till
    // could then send any amount and be believed.
    addProduct()->assertRedirect();
    $product = productNamed('Soupe du jour');

    saveProduct($product, ['special_kind' => 'tip', 'is_special' => true])->assertRedirect();

    $saved = productNamed('Soupe du jour');

    expect($saved->special_kind->value)->toBe('none')
        ->and((bool) $saved->is_special)->toBeFalse();
});

// ───────────────────────────────────────────── the open-session guard (BOF-083)

it('freezes availability while a session is open', function (): void {
    // The register holds a bootstrapped catalogue. Pull a product mid-service and it is still on the
    // till in front of the cashier, still addable, and the order that includes it then names a
    // product the back office says is gone.
    addProduct()->assertRedirect();
    $product = productNamed('Soupe du jour');

    $this->fx->withSession();

    saveProduct($product, ['available_in_pos' => false])->assertStatus(422);

    expect((bool) productNamed('Soupe du jour')->available_in_pos)->toBeTrue();
});

it('still lets the name and the price change mid-service', function (): void {
    // The control, and the reason the freeze is a list rather than a blanket: a sold line records
    // what it charged, so renaming and re-pricing are safe. A manager fixing a typo at 8pm should
    // not have to close every till.
    addProduct()->assertRedirect();
    $product = productNamed('Soupe du jour');

    $this->fx->withSession();

    saveProduct($product, ['name' => 'Soupe de poisson', 'list_price' => '7.00'])
        ->assertSessionHasNoErrors()->assertRedirect();

    expect(Product::query()->where('name', 'Soupe de poisson')->exists())->toBeTrue();
});

it('does not fire the freeze on a save that changes nothing', function (): void {
    // The editor posts every field on every save, so a guard keyed on which keys *arrived* would
    // refuse an unrelated edit — the defect this project has hit three times now (BAN-396, BAN-424,
    // BAN-483).
    addProduct()->assertRedirect();
    $product = productNamed('Soupe du jour');

    $this->fx->withSession();

    saveProduct($product, [
        'name' => 'Soupe du soir',
        'available_in_pos' => (bool) $product->available_in_pos,
        'active' => (bool) $product->active,
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect(Product::query()->where('name', 'Soupe du soir')->exists())->toBeTrue();
});

// ─────────────────────────────────────────────────────────────── archiving

it('archives a product rather than erasing it', function (): void {
    // Every sold line holds `product_id` under `restrictOnDelete`, so a real delete of anything ever
    // sold is a database refusal. The model soft-deletes and the history stays readable.
    addProduct()->assertRedirect();
    $product = productNamed('Soupe du jour');

    test()->deleteJson("/products/{$product->uuid}")->assertRedirect();

    expect(Product::query()->where('name', 'Soupe du jour')->exists())->toBeFalse()
        ->and(Product::query()->withTrashed()->where('name', 'Soupe du jour')->exists())->toBeTrue();
});

it('takes the variants out of the catalogue with it', function (): void {
    // Leave them active and the register bootstrap ships a sellable variant whose product is
    // archived, which reads on the till as an item that exists and cannot be found.
    addProduct()->assertRedirect();
    $product = productNamed('Soupe du jour');

    test()->deleteJson("/products/{$product->uuid}")->assertRedirect();

    expect(DB::table('product_variants')->where('product_id', $product->getKey())->where('active', true)->count())
        ->toBe(0);
});

it('refuses to archive while a session is open', function (): void {
    addProduct()->assertRedirect();
    $product = productNamed('Soupe du jour');

    $this->fx->withSession();

    test()->deleteJson("/products/{$product->uuid}")->assertStatus(422);

    expect(Product::query()->where('name', 'Soupe du jour')->exists())->toBeTrue();
});

// ────────────────────────────────────────────────────────────── permission

it('refuses a user who may not configure the register', function (): void {
    addProduct()->assertRedirect();
    $product = productNamed('Soupe du jour');

    test()->actingAs(menuActor($this->fx, ['config.view']));

    addProduct(['name' => 'Sneaky'])->assertForbidden();
    saveProduct($product, ['list_price' => '0.01'])->assertForbidden();
    test()->deleteJson("/products/{$product->uuid}")->assertForbidden();

    expect(Product::query()->where('name', 'Sneaky')->exists())->toBeFalse()
        ->and((string) productNamed('Soupe du jour')->list_price)->toStartWith('6.5');
});

it('never touches another company product', function (): void {
    $other = PosFixtures::make();

    test()->patchJson("/products/{$other->product->uuid}", ['name' => 'Mine now'])->assertNotFound();
    test()->deleteJson("/products/{$other->product->uuid}")->assertNotFound();

    expect(Product::query()->withoutGlobalScopes()->whereKey($other->product->getKey())->value('name'))
        ->not->toBe('Mine now');
});

it('never files a product under another company accounting category', function (): void {
    // The scalar FKs need the same treatment as the pivots, and had no test until sabotage said so:
    // removing the ownership check left every other test green. `product_category_id` decides which
    // revenue account the product's sales export under, so a foreign one posts this venue's takings
    // to another venue's books.
    $other = PosFixtures::make();
    $foreign = ProductCategory::query()->create([
        'company_id' => $other->company->getKey(),
        'name' => 'Theirs',
        'path' => '/',
        'ledger_code' => '9999',
    ]);

    addProduct(['product_category_id' => $foreign->getKey()])->assertStatus(422);

    expect(Product::query()->where('name', 'Soupe du jour')->exists())->toBeFalse();
});

it('refuses an accounting category that does not exist', function (): void {
    addProduct(['product_category_id' => 999999])->assertStatus(422);
});

it('refuses a unit of measure that does not exist', function (): void {
    addProduct(['uom_id' => 999999])->assertStatus(422);
});

it('86-ing a dish schedules the catalogue invalidation that reaches the guest menu', function (): void {
    // The ticket's acceptance criterion, and the half that is easy to assume. The button writes
    // `self_order_available`; `Product::saved` is registered against `InvalidateCatalogCache`, which
    // clears the cache and dispatches `BroadcastCatalogChange`, so the guest menu drops the dish
    // without anybody reloading.
    //
    // Asserted on the *listener* rather than on `BroadcastCatalogChange`: the listener is itself
    // `ShouldQueue`, so under a faked bus it is queued and never runs, and the inner job is never
    // reached. Asserting the inner job would have failed for a reason that has nothing to do with
    // whether the wiring exists — which is exactly what it did on the first attempt.
    //
    // Worth pinning at all because nothing in this controller references the listener: it is a
    // registration in a service provider, and removing it would break the guest menu silently.
    addProduct(['self_order_available' => true])->assertRedirect();
    $product = productNamed('Soupe du jour');

    // Faked *after* the create, not before. Creating a product also saves a variant, and
    // `ProductVariant` is on the same invalidation list — so a fake opened earlier is satisfied by
    // the creation and the assertion says nothing about the 86 at all. Caught by sabotage:
    // unregistering `Product` from the list left this test green.
    Bus::fake();

    saveProduct($product, ['self_order_available' => false])->assertRedirect();

    expect((bool) productNamed('Soupe du jour')->self_order_available)->toBeFalse();

    Bus::assertDispatched(
        CallQueuedListener::class,
        static fn (CallQueuedListener $job): bool => $job->class === InvalidateCatalogCache::class,
    );
});

it('lets a dish be 86-ed during service, which is when it happens', function (): void {
    // `self_order_available` is deliberately outside the open-session freeze: taking a dish off the
    // guest menu is a service decision, while pulling it from the tills is a catalogue one. Freezing
    // both would block 86-ing at exactly the moment it is needed.
    addProduct(['self_order_available' => true])->assertRedirect();
    $product = productNamed('Soupe du jour');

    $this->fx->withSession();

    saveProduct($product, ['self_order_available' => false])
        ->assertSessionHasNoErrors()->assertRedirect();

    expect((bool) productNamed('Soupe du jour')->self_order_available)->toBeFalse();
});
