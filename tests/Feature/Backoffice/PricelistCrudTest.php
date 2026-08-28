<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\PricelistCrud;

use App\Models\Pos\PosConfig;
use App\Models\Pricing\Currency;
use App\Models\Pricing\Pricelist;
use App\Models\Pricing\PricelistItem;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * Price lists and their rules (BOF-037, BAN-401).
 *
 * "Change a price rule" is the most common back-office task in a restaurant and it had no endpoint
 * at all: the header could be edited, the rules were a read-only explorer, and a list could not be
 * created or removed. Happy hour, a member rate, a category markdown — none of it was reachable.
 */
beforeEach(function (): void {
    $this->other = PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs($this->fx->userWith('backoffice.access', 'catalog.view', 'catalog.manage_pricelists'));
});

function ourList(): Pricelist
{
    return Pricelist::query()->create([
        'company_id' => test()->fx->company->getKey(),
        'currency_id' => test()->fx->currency->getKey(),
        'name' => 'Happy hour',
    ]);
}

/** @param array<string, mixed> $payload */
function addRule(Pricelist $list, array $payload = []): TestResponse
{
    return test()->post("/pricelists/{$list->getKey()}/items", [
        'applied_on' => 'global',
        'compute_price' => 'percentage',
        'percent_price' => '20',
        ...$payload,
    ]);
}

it('creates a price list', function (): void {
    test()->post('/pricelists', [
        'name' => 'Tarif membre',
        'currency_id' => $this->fx->currency->getKey(),
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect(Pricelist::query()->where('name', 'Tarif membre')->exists())->toBeTrue();
});

it('adds a percentage rule', function (): void {
    $list = ourList();

    addRule($list)->assertSessionHasNoErrors()->assertRedirect();

    expect(PricelistItem::query()->where('pricelist_id', $list->getKey())->count())->toBe(1);
});

it('refuses a rule that says it targets a product and names none', function (): void {
    // Every id column is nullable with a null default, so this is accepted by the database and then
    // matches nothing. The operator sees a saved rule and an unchanged price.
    $list = ourList();

    addRule($list, ['applied_on' => 'product'])->assertSessionHasErrors('product_id');

    expect(PricelistItem::query()->where('pricelist_id', $list->getKey())->count())->toBe(0);
});

it('refuses a rule that targets a category and names none', function (): void {
    $list = ourList();

    addRule($list, ['applied_on' => 'pos_category'])->assertSessionHasErrors('pos_category_id');
});

it('refuses a percentage rule with no percentage', function (): void {
    // A zero-per-cent discount saves cleanly and changes no price.
    $list = ourList();

    addRule($list, ['percent_price' => '0'])->assertSessionHasErrors('percent_price');
});

it('refuses a fixed rule with no price, which would sell for nothing', function (): void {
    $list = ourList();

    addRule($list, ['compute_price' => 'fixed', 'fixed_price' => '0'])
        ->assertSessionHasErrors('fixed_price');
});

it('refuses a formula computed from a price list it does not name', function (): void {
    $list = ourList();

    addRule($list, [
        'compute_price' => 'formula',
        'base' => 'pricelist',
        'base_pricelist_id' => null,
    ])->assertSessionHasErrors('base_pricelist_id');
});

it('refuses a price list computed from itself', function (): void {
    // `PricingService::ancestryFor` walks the base chain with a guard that stops after ten hops, so
    // this does not hang — it silently gives up and prices from the wrong thing.
    $list = ourList();

    addRule($list, [
        'compute_price' => 'formula',
        'base' => 'pricelist',
        'base_pricelist_id' => $list->getKey(),
    ])->assertSessionHasErrors('base_pricelist_id');
});

it('refuses a window that closes before it opens', function (): void {
    $list = ourList();

    addRule($list, [
        'date_start' => '2026-06-01 18:00:00',
        'date_end' => '2026-06-01 17:00:00',
    ])->assertSessionHasErrors('date_end');
});

it('refuses another venue product in a rule', function (): void {
    // A rule naming their product would price their item on our till.
    $list = ourList();

    addRule($list, [
        'applied_on' => 'product',
        'product_id' => $this->other->product->getKey(),
    ])->assertSessionHasErrors('product_id');
});

it('accepts a product of its own venue', function (): void {
    $list = ourList();

    addRule($list, [
        'applied_on' => 'product',
        'product_id' => $this->fx->product->getKey(),
    ])->assertSessionHasNoErrors();

    expect((int) PricelistItem::query()->where('pricelist_id', $list->getKey())->value('product_id'))
        ->toBe((int) $this->fx->product->getKey());
});

it('orders new rules after the ones already there', function (): void {
    $list = ourList();

    addRule($list)->assertRedirect();
    addRule($list, ['applied_on' => 'product', 'product_id' => $this->fx->product->getKey()])->assertRedirect();

    $sequences = PricelistItem::query()
        ->where('pricelist_id', $list->getKey())
        ->orderBy('id')
        ->pluck('sequence')
        ->all();

    expect($sequences[1])->toBeGreaterThan($sequences[0]);
});

it('does not let a rule be reached through the wrong price list', function (): void {
    $ours = ourList();
    $second = Pricelist::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'currency_id' => $this->fx->currency->getKey(),
        'name' => 'Autre',
    ]);

    addRule($second)->assertRedirect();
    $rule = PricelistItem::query()->where('pricelist_id', $second->getKey())->firstOrFail();

    test()->delete("/pricelists/{$ours->getKey()}/items/{$rule->getKey()}")->assertNotFound();

    expect(PricelistItem::query()->whereKey($rule->getKey())->exists())->toBeTrue();
});

it('refuses to re-currency a list a register quotes from', function (): void {
    // BAN-466 refuses attaching a pricelist whose currency disagrees with the register. This is the
    // same rule from the other side: nothing converts, so the till would show these amounts under
    // the wrong symbol.
    $list = ourList();

    PosConfig::query()->whereKey($this->fx->config->getKey())
        ->update(['pricelist_id' => $list->getKey()]);

    $dollar = Currency::query()->create([
        'name' => 'Dollar', 'code' => 'USD', 'symbol' => '$', 'decimal_places' => 2, 'rounding' => '0.01',
    ]);

    test()->patch("/pricelists/{$list->getKey()}", ['currency_id' => $dollar->getKey()])
        ->assertSessionHasErrors('currency_id');

    expect((int) Pricelist::query()->whereKey($list->getKey())->value('currency_id'))
        ->toBe((int) $this->fx->currency->getKey());
});

it('still lets a list nobody quotes from change currency', function (): void {
    // The negative half: the guard is about registers, not about the field being sacred.
    $list = ourList();

    $dollar = Currency::query()->create([
        'name' => 'Dollar', 'code' => 'USD', 'symbol' => '$', 'decimal_places' => 2, 'rounding' => '0.01',
    ]);

    test()->patch("/pricelists/{$list->getKey()}", ['currency_id' => $dollar->getKey()])
        ->assertSessionHasNoErrors();

    expect((int) Pricelist::query()->whereKey($list->getKey())->value('currency_id'))
        ->toBe((int) $dollar->getKey());
});

it('refuses to remove a list that priced orders', function (): void {
    $list = ourList();
    $fx = $this->fx->withSession();

    DB::table('pos_orders')->insert([
        'uuid' => (string) Str::uuid(),
        'company_id' => $fx->company->getKey(),
        'pos_config_id' => $fx->config->getKey(),
        'pos_session_id' => $fx->session->getKey(),
        'currency_id' => $fx->currency->getKey(),
        'pricelist_id' => $list->getKey(),
        'tracking_number' => 'T-1',
        'access_token' => Str::random(32),
        'state' => 'draft',
        'ordered_at' => now(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    test()->delete("/pricelists/{$list->getKey()}")->assertSessionHasErrors('pricelist');

    expect(Pricelist::query()->whereKey($list->getKey())->exists())->toBeTrue();
});

it('refuses to remove a list another list computes from', function (): void {
    // Their prices would quietly fall back to the product price.
    $base = ourList();
    $derived = Pricelist::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'currency_id' => $this->fx->currency->getKey(),
        'name' => 'Dérivé',
    ]);

    addRule($derived, [
        'compute_price' => 'formula',
        'base' => 'pricelist',
        'base_pricelist_id' => $base->getKey(),
    ])->assertSessionHasNoErrors();

    test()->delete("/pricelists/{$base->getKey()}")->assertSessionHasErrors('pricelist');
});

it('removes a list nothing points at', function (): void {
    $list = ourList();

    test()->delete("/pricelists/{$list->getKey()}")->assertSessionHasNoErrors()->assertRedirect();

    expect(Pricelist::query()->whereKey($list->getKey())->exists())->toBeFalse();
});

it('refuses everything to someone who may only look', function (): void {
    $this->actingAs($this->fx->userWith('backoffice.access', 'catalog.view'));

    test()->post('/pricelists', [
        'name' => 'Pas la mienne',
        'currency_id' => $this->fx->currency->getKey(),
    ])->assertForbidden();
});

it('ships the create form what it needs to offer a currency', function (): void {
    // The form cannot be filled in from props that were never sent. `index()` shipped only the rows,
    // so the currency select would have rendered empty and every save would have been refused for a
    // missing `currency_id` — a screen that looks finished and cannot be used.
    test()->get('/pricelists')
        ->assertInertia(fn ($page) => $page->has('currencies', fn ($currencies) => $currencies
            ->has(0, fn ($currency) => $currency->hasAll(['id', 'name', 'code']))
            ->etc()));
});

it('ships the rule editor something to point a rule at', function (): void {
    $list = ourList();

    test()->get("/pricelists/{$list->getKey()}/edit")
        ->assertInertia(fn ($page) => $page->has('products')->has('categories'));
});

it('accepts exactly what the rule form posts', function (): void {
    // The form posts every key on every save, including the ids it is not using and the price field
    // belonging to the other compute mode. A rule that the UI can produce and the server refuses is
    // the same dead end as no endpoint at all.
    $list = ourList();

    test()->post("/pricelists/{$list->getKey()}/items", [
        'applied_on' => 'global',
        'product_id' => null,
        'pos_category_id' => null,
        'compute_price' => 'percentage',
        'fixed_price' => '0',
        'percent_price' => '10',
    ])->assertSessionHasNoErrors();

    expect(PricelistItem::query()->where('pricelist_id', $list->getKey())->count())->toBe(1);
});
