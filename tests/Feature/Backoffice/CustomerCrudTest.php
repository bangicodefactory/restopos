<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\CustomerCrud;

use App\Models\Identity\Customer;
use App\Models\Pos\CustomerAccountMove;
use App\Models\Pos\Order;
use App\Models\Pricing\Pricelist;
use App\Services\Pos\PricingService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * The customer base (BOF-119, BAN-453).
 *
 * There was no customer route and no customer page of any kind. Customers ship in the bootstrap
 * payload and can be attached to an order at the till, and that inline picker was the only customer
 * surface in the product — a phone number could not be corrected.
 */
beforeEach(function (): void {
    $this->other = PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_customers'));
});

function ourCustomer(array $overrides = []): Customer
{
    return Customer::query()->create([
        'company_id' => test()->fx->company->getKey(),
        'name' => 'Marie Dupont',
        ...$overrides,
    ]);
}

function bookOrder(Customer $customer, string $total = '20.0000', ?string $at = null): int
{
    // `pos_sessions.pos_config_id` is unique, so the session is opened once and reused.
    $fx = test()->fx->session === null ? test()->fx->withSession() : test()->fx;

    return (int) DB::table('pos_orders')->insertGetId([
        'uuid' => (string) Str::uuid(),
        'company_id' => $fx->company->getKey(),
        'pos_config_id' => $fx->config->getKey(),
        'pos_session_id' => $fx->session->getKey(),
        'currency_id' => $fx->currency->getKey(),
        'customer_id' => $customer->getKey(),
        'tracking_number' => 'T-'.Str::random(5),
        'access_token' => Str::random(32),
        'state' => 'paid',
        'amount_total' => $total,
        'ordered_at' => $at ?? now(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

function bookAccountMove(Customer $customer, string $amount): void
{
    DB::table('customer_account_moves')->insert([
        'uuid' => (string) Str::uuid(),
        'company_id' => test()->fx->company->getKey(),
        'customer_id' => $customer->getKey(),
        'move_type' => 'charge',
        'amount' => $amount,
        'balance_after' => $amount,
        'occurred_at' => now(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $customer->forceFill([
        'account_balance' => bcadd((string) $customer->account_balance, $amount, 4),
    ])->save();
}

it('creates a customer', function (): void {
    test()->post('/customers', ['name' => 'Marie Dupont', 'email' => 'marie@example.test'])
        ->assertSessionHasNoErrors()
        ->assertRedirect();

    expect(Customer::query()->where('name', 'Marie Dupont')->exists())->toBeTrue();
});

it('refuses a price list from another venue', function (): void {
    // The customer's price list is read at the till the moment they are attached to an order, so
    // this would quote another venue's prices on ours.
    $theirs = Pricelist::query()->create([
        'company_id' => $this->other->company->getKey(),
        'currency_id' => $this->other->currency->getKey(),
        'name' => 'Leur tarif',
    ]);

    test()->post('/customers', ['name' => 'Marie', 'pricelist_id' => $theirs->getKey()])
        ->assertSessionHasErrors('pricelist_id');
});

it('refuses a customer filed under itself', function (): void {
    $customer = ourCustomer();

    test()->patch("/customers/{$customer->uuid}", ['parent_id' => $customer->getKey()])
        ->assertSessionHasErrors('parent_id');
});

it('refuses marketing consent that could never be acted on', function (): void {
    // Consent with no email and no mobile cannot be used, and reads as a contactable customer in
    // any count of the marketable base.
    test()->post('/customers', ['name' => 'Marie', 'marketing_opt_in' => true])
        ->assertSessionHasErrors('marketing_opt_in');

    test()->post('/customers', ['name' => 'Marie', 'mobile' => '0600000000', 'marketing_opt_in' => true])
        ->assertSessionHasNoErrors();
});

it('refuses a loyalty card another customer already carries', function (): void {
    ourCustomer(['barcode' => 'CARD-1']);

    test()->post('/customers', ['name' => 'Autre', 'barcode' => 'CARD-1'])
        ->assertSessionHasErrors('barcode');
});

it('still allows a card another venue happens to use', function (): void {
    // The mirror image of the leak `ScopedExistsTest` guards: `Rule::unique` runs on the query
    // builder, so it would look across every tenant and refuse a card that is free here.
    Customer::query()->create([
        'company_id' => $this->other->company->getKey(),
        'name' => 'Leur client',
        'barcode' => 'CARD-1',
    ]);

    test()->post('/customers', ['name' => 'Notre client', 'barcode' => 'CARD-1'])
        ->assertSessionHasNoErrors();
});

it('will not let the form type over a balance the ledger owns', function (): void {
    // `account_balance` is a cache of the moves. A form that could write it would let an operator
    // clear a debt by typing over it, with the ledger still saying otherwise.
    $customer = ourCustomer();
    bookAccountMove($customer, '40.0000');

    test()->patch("/customers/{$customer->uuid}", ['account_balance' => '0'])
        ->assertSessionHasNoErrors();

    expect((float) Customer::query()->whereKey($customer->getKey())->value('account_balance'))
        ->toBe(40.0);
});

it('applies the customer price list at the till', function (): void {
    // The acceptance criterion, and the wire this project keeps finding broken:
    // `PricingService::resolvePricelistId` walks order -> preset -> customer -> config, so a default
    // set here has to reach the register.
    $list = Pricelist::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'currency_id' => $this->fx->currency->getKey(),
        'name' => 'Tarif membre',
    ]);

    test()->post('/customers', ['name' => 'Marie', 'pricelist_id' => $list->getKey()])
        ->assertSessionHasNoErrors();

    $customer = Customer::query()->where('name', 'Marie')->firstOrFail();
    $this->fx->config->forceFill(['use_pricelists' => true])->save();

    expect(app(PricingService::class)
        ->resolvePricelistId($this->fx->config->fresh(), null, null, (int) $customer->getKey()))
        ->toBe((int) $list->getKey());
});

it('ignores the customer price list on a register that does not use price lists', function (): void {
    // The negative half, and it is deliberate rather than an oversight: `use_pricelists` is the
    // switch that says this register quotes one price. A customer default that overrode it would
    // reintroduce variable pricing on a register configured not to have any.
    $list = Pricelist::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'currency_id' => $this->fx->currency->getKey(),
        'name' => 'Tarif membre',
    ]);

    $customer = ourCustomer(['pricelist_id' => $list->getKey()]);
    $this->fx->config->forceFill(['use_pricelists' => false])->save();

    expect(app(PricingService::class)
        ->resolvePricelistId($this->fx->config->fresh(), null, null, (int) $customer->getKey()))
        ->not->toBe((int) $list->getKey());
});

it('archives a customer who has ordered rather than removing them', function (): void {
    // `pos_invoices` and `customer_account_moves` are `restrictOnDelete`, so the database refuses
    // anyway — with a 500 rather than a message. And a customer who has ordered is part of the
    // record of those orders.
    $customer = ourCustomer();
    bookOrder($customer);

    test()->delete("/customers/{$customer->uuid}")->assertSessionHasNoErrors()->assertRedirect();

    $row = Customer::query()->withoutGlobalScopes()->whereKey($customer->getKey())->first();

    expect($row)->not->toBeNull()
        ->and((bool) $row->active)->toBeFalse();
});

it('removes a customer with no history at all', function (): void {
    $customer = ourCustomer();

    test()->delete("/customers/{$customer->uuid}")->assertSessionHasNoErrors();

    expect(Customer::query()->whereKey($customer->getKey())->exists())->toBeFalse();
});

it('refuses everything to someone who may only look', function (): void {
    $this->actingAs($this->fx->userWith('backoffice.access'));

    test()->post('/customers', ['name' => 'Marie'])->assertForbidden();
});

// ───────────────────────────────────────────────────────────────────── merging

it('moves both order histories onto the surviving record', function (): void {
    $survivor = ourCustomer(['name' => 'Marie Dupont']);
    $loser = ourCustomer(['name' => 'M. Dupond']);

    bookOrder($survivor);
    bookOrder($loser);
    bookOrder($loser);

    test()->post("/customers/{$survivor->uuid}/merge", ['loser_id' => $loser->getKey()])
        ->assertSessionHasNoErrors();

    expect(Order::query()->where('customer_id', $survivor->getKey())->count())->toBe(3)
        ->and(Order::query()->where('customer_id', $loser->getKey())->count())->toBe(0);
});

it('carries the balance of the record it absorbed', function (): void {
    // The one that costs money. `account_balance` is a cache of `sum(customer_account_moves.amount)`,
    // so moving the moves without restating the cache leaves the survivor's balance describing half
    // its own ledger — a regular who owed 40 EUR on the duplicate would owe nothing, and the venue
    // would never know to ask.
    $survivor = ourCustomer(['name' => 'Marie Dupont']);
    $loser = ourCustomer(['name' => 'M. Dupond']);

    bookAccountMove($survivor, '15.0000');
    bookAccountMove($loser, '40.0000');

    test()->post("/customers/{$survivor->uuid}/merge", ['loser_id' => $loser->getKey()])
        ->assertSessionHasNoErrors();

    expect((float) Customer::query()->whereKey($survivor->getKey())->value('account_balance'))
        ->toBe(55.0)
        ->and((float) CustomerAccountMove::query()->where('customer_id', $survivor->getKey())->sum('amount'))
        ->toBe(55.0);
});

it('leaves the cached balance equal to the ledger, which is the invariant', function (): void {
    // Stated separately from the sum above because it is the thing `CustomerAccountLedgerTest`
    // guards everywhere else: the column and the moves must agree, whatever happened in between.
    $survivor = ourCustomer(['name' => 'Marie Dupont']);
    $loser = ourCustomer(['name' => 'M. Dupond']);

    bookAccountMove($survivor, '15.0000');
    bookAccountMove($loser, '40.0000');

    // Drift the cache first: the recount must correct it rather than add to it.
    $survivor->forceFill(['account_balance' => '999.0000'])->save();

    test()->post("/customers/{$survivor->uuid}/merge", ['loser_id' => $loser->getKey()])
        ->assertSessionHasNoErrors();

    $fresh = Customer::query()->whereKey($survivor->getKey())->firstOrFail();

    expect((float) $fresh->account_balance)
        ->toBe((float) CustomerAccountMove::query()->where('customer_id', $fresh->getKey())->sum('amount'));
});

it('leaves nothing on the archived record that reads as owed', function (): void {
    $survivor = ourCustomer(['name' => 'Marie Dupont']);
    $loser = ourCustomer(['name' => 'M. Dupond']);

    bookAccountMove($loser, '40.0000');

    test()->post("/customers/{$survivor->uuid}/merge", ['loser_id' => $loser->getKey()])
        ->assertSessionHasNoErrors();

    $archived = Customer::query()->withoutGlobalScopes()->whereKey($loser->getKey())->firstOrFail();

    expect((float) $archived->account_balance)->toBe(0.0)
        ->and((bool) $archived->active)->toBeFalse()
        ->and((string) $archived->note)->toContain('Merged into');
});

it('restates the order count and the last visit', function (): void {
    $survivor = ourCustomer(['name' => 'Marie Dupont']);
    $loser = ourCustomer(['name' => 'M. Dupond']);

    bookOrder($survivor, '20.0000', '2026-01-01 12:00:00');
    bookOrder($loser, '20.0000', '2026-06-01 12:00:00');

    test()->post("/customers/{$survivor->uuid}/merge", ['loser_id' => $loser->getKey()])
        ->assertSessionHasNoErrors();

    $fresh = Customer::query()->whereKey($survivor->getKey())->firstOrFail();

    expect((int) $fresh->order_count)->toBe(2)
        ->and($fresh->last_order_at?->format('Y-m-d'))->toBe('2026-06-01');
});

it('moves the child addresses of the record it absorbed', function (): void {
    // `parent_id` is how a company's delivery addresses hang off the company record. Left behind,
    // they point at an archived record and disappear from the surviving one.
    $survivor = ourCustomer(['name' => 'Traiteur SA', 'is_company' => true]);
    $loser = ourCustomer(['name' => 'Traiteur S.A.', 'is_company' => true]);
    $address = ourCustomer(['name' => 'Entrepôt', 'parent_id' => $loser->getKey()]);

    test()->post("/customers/{$survivor->uuid}/merge", ['loser_id' => $loser->getKey()])
        ->assertSessionHasNoErrors();

    expect((int) Customer::query()->whereKey($address->getKey())->value('parent_id'))
        ->toBe((int) $survivor->getKey());
});

it('refuses to merge in another venue customer', function (): void {
    // This would move their orders and their account balance onto ours.
    $survivor = ourCustomer();
    $theirs = Customer::query()->create([
        'company_id' => $this->other->company->getKey(),
        'name' => 'Leur client',
    ]);

    test()->post("/customers/{$survivor->uuid}/merge", ['loser_id' => $theirs->getKey()])
        ->assertSessionHasErrors('loser_id');

    expect((int) Customer::query()->withoutGlobalScopes()->whereKey($theirs->getKey())->value('company_id'))
        ->toBe((int) $this->other->company->getKey());
});

it('refuses to merge a record into itself', function (): void {
    $customer = ourCustomer();

    test()->post("/customers/{$customer->uuid}/merge", ['loser_id' => $customer->getKey()])
        ->assertSessionHasErrors('loser_id');

    expect((bool) Customer::query()->whereKey($customer->getKey())->value('active'))->toBeTrue();
});

it('refuses merging to someone who may only look', function (): void {
    $survivor = ourCustomer();
    $loser = ourCustomer(['name' => 'M. Dupond']);

    $this->actingAs($this->fx->userWith('backoffice.access'));

    test()->post("/customers/{$survivor->uuid}/merge", ['loser_id' => $loser->getKey()])
        ->assertForbidden();
});

// ─────────────────────────────────────────────────────────── the list and the record

it('finds a customer by something other than their name', function (): void {
    test()->withoutVite();

    ourCustomer(['name' => 'Marie Dupont', 'phone' => '0102030405']);
    ourCustomer(['name' => 'Autre personne', 'phone' => '0999999999']);

    test()->get('/customers?q=0102030405')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->where('customers', fn ($rows) => count($rows) === 1
                && $rows[0]['name'] === 'Marie Dupont')
            ->etc());
});

it('says how many customers there are, not only how many it drew', function (): void {
    // A list that silently stops at its page size reads as the whole base. Asserting the prop merely
    // exists is not enough: a total of zero satisfies `has()` and is the shape of the bug.
    test()->withoutVite();

    ourCustomer(['name' => 'Marie Dupont']);
    ourCustomer(['name' => 'Autre personne']);

    test()->get('/customers?q=Marie')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            // One row drawn by the search, two customers in the base — they have to be different
            // numbers, or the count is measuring the page rather than the base.
            ->where('customers', fn ($rows) => count($rows) === 1)
            ->where('total', 2)
            ->where('shown_limit', 500)
            ->etc());
});

it('surfaces two records sharing a phone number as a likely duplicate', function (): void {
    // Duplicates are made at the till, under slightly different names — so the match is on what a
    // duplicate shares, not on the one field that differs.
    test()->withoutVite();

    ourCustomer(['name' => 'Marie Dupont', 'phone' => '0102030405']);
    ourCustomer(['name' => 'M. Dupond', 'phone' => '0102030405']);

    test()->get('/customers')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->where('duplicates', fn ($rows) => collect($rows)
                ->contains(fn (array $row): bool => $row['value'] === '0102030405' && count($row['ids']) === 2))
            ->etc());
});

it('does not call every customer without an email a duplicate of every other', function (): void {
    test()->withoutVite();

    ourCustomer(['name' => 'Marie Dupont']);
    ourCustomer(['name' => 'Autre personne']);

    test()->get('/customers')
        ->assertOk()
        ->assertInertia(fn ($page) => $page->where('duplicates', fn ($rows) => count($rows) === 0)->etc());
});

it('shows the record its order history and its account moves', function (): void {
    test()->withoutVite();

    $customer = ourCustomer();
    bookOrder($customer);
    bookAccountMove($customer, '40.0000');

    test()->get("/customers/{$customer->uuid}/edit")
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->where('orders', fn ($rows) => count($rows) === 1)
            ->where('accountMoves', fn ($rows) => count($rows) === 1)
            ->has('pricelists')
            ->etc());
});
