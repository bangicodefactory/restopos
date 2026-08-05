<?php

declare(strict_types=1);

use App\Models\Identity\Customer;
use App\Models\Pos\Order;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-465 — `GET /api/pos/orders`, the ticket screen's lookup.
 *
 * The route shipped and had never been called, so nothing had ever asserted its behaviour. These
 * cover the contract the two-step cache-diff depends on: a cheap index the client can compare
 * against its replica, a cursor that pages, and a search that finds what a cashier is actually
 * holding — a receipt, an invoice, a card slip, or a name shouted across the counter.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();
});

/** Push an order through the sync endpoint so it exists exactly as a real till would have left it. */
function pushOrder(PosFixtures $fx, array $order = [], array $payments = []): string
{
    $uuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [], $order, $payments)],
    ])->assertOk();

    return $uuid;
}

it('returns the cheap index shape the cache diff needs', function (): void {
    $uuid = pushOrder($this->fx);

    $response = $this->withHeaders($this->fx->headers())->getJson('/api/pos/orders');

    $response->assertOk()
        ->assertJsonPath('records.0.uuid', $uuid)
        ->assertJsonPath('total', 1)
        ->assertJsonPath('next_cursor', null);

    // The whole point of the index is that it is *not* the order graph — no lines, no payments.
    expect(array_keys($response->json('records.0')))
        ->toBe(['id', 'uuid', 'name', 'receipt_number', 'state', 'amount_total', 'ordered_at', 'updated_at']);
});

it('finds an order taken on a trusted peer till', function (): void {
    // The acceptance criterion this route could not meet: pinned to one `pos_config_id`, a cashier
    // on the second register could not look up what the first register rang through.
    $peer = PosFixtures::make(['company_id' => $this->fx->company->getKey()]);
    $peerOrder = Order::query()->create([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'pos_config_id' => $peer->config->getKey(),
        'pos_session_id' => $this->fx->session->getKey(),
        'name' => 'Peer/0001',
        'access_token' => (string) Str::uuid(),
        'currency_id' => $this->fx->config->currency_id,
        'tracking_number' => 900,
        'state' => 'paid',
        'ordered_at' => now(),
        'amount_total' => '12.0000',
    ]);

    $this->withHeaders($this->fx->headers())->getJson('/api/pos/orders')
        ->assertOk()
        ->assertJsonMissing(['uuid' => $peerOrder->uuid]);

    $this->fx->config->trustedConfigs()->attach($peer->config->getKey());

    $this->withHeaders($this->fx->headers())->getJson('/api/pos/orders')
        ->assertOk()
        ->assertJsonFragment(['uuid' => (string) $peerOrder->uuid]);
});

it('refuses a trusted-config row that points across companies', function (): void {
    // `pos_config_trusted_config` is application-written data, so it is not a tenant boundary on its
    // own. One row pointing at another company's register used to hand over that company's orders —
    // index and full graph, payments and cardholder names included. `CompanyScope` does not cover
    // this: it keys on the `web` guard, and a device request has no web user.
    $stranger = PosFixtures::make()->withSession();
    $this->fx->config->trustedConfigs()->attach($stranger->config->getKey());

    $theirs = Order::query()->create([
        'uuid' => (string) Str::uuid(),
        'company_id' => $stranger->company->getKey(),
        'pos_config_id' => $stranger->config->getKey(),
        'pos_session_id' => $stranger->session->getKey(),
        'name' => 'THEIRS/0001',
        'access_token' => (string) Str::uuid(),
        'currency_id' => $stranger->config->currency_id,
        'tracking_number' => 5,
        'state' => 'paid',
        'ordered_at' => now(),
        'amount_total' => '999.0000',
    ]);

    expect($this->withHeaders($this->fx->headers())->getJson('/api/pos/orders')->assertOk()->json('records'))
        ->toHaveCount(0);

    $this->withHeaders($this->fx->headers())->getJson('/api/pos/orders/'.$theirs->uuid)->assertNotFound();

    // …while a peer inside the same company is still visible, so the guard has not simply
    // re-broken the multi-till lookup it was added to enable.
    $peer = PosFixtures::make(['company_id' => $this->fx->company->getKey()]);
    $this->fx->config->trustedConfigs()->attach($peer->config->getKey());

    Order::query()->create([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'pos_config_id' => $peer->config->getKey(),
        'pos_session_id' => $this->fx->session->getKey(),
        'name' => 'PEER/0001',
        'access_token' => (string) Str::uuid(),
        'currency_id' => $this->fx->config->currency_id,
        'tracking_number' => 6,
        'state' => 'paid',
        'ordered_at' => now(),
        'amount_total' => '12.0000',
    ]);

    expect($this->withHeaders($this->fx->headers())->getJson('/api/pos/orders')->assertOk()->json('records.0.name'))
        ->toBe('PEER/0001');
});

it('sends the fields the client writes back, so a reprint cannot erase them', function (): void {
    // A hydrated order is not read-only: the first thing that touches it pushes the whole row up
    // through the outbox, and reprinting a looked-up order is the most ordinary thing a cashier does
    // with one. `is_tipped` and `tip_amount` are client-writable on ingest, so omitting them here
    // made that reprint push `is_tipped=false, tip_amount=0` and wipe the recorded tip.
    $uuid = pushOrder($this->fx, ['state' => 'paid']);

    Order::query()->where('uuid', $uuid)->update([
        'is_tipped' => true,
        'tip_amount' => '3.0000',
        'print_count' => 4,
    ]);

    $body = $this->withHeaders($this->fx->headers())->getJson('/api/pos/orders/'.$uuid)->assertOk()->json();

    expect($body['is_tipped'])->toBeTrue()
        ->and($body['tip_amount'])->toBe('3.0000')
        // Display-only, but wrong-by-default is still wrong: a hydrated order reported "Copy 1" for
        // a receipt already printed four times.
        ->and($body['print_count'])->toBe(4)
        ->and($body['currency_id'])->toBe((int) $this->fx->config->currency_id)
        ->and($body['company_id'])->toBe($this->fx->company->getKey());
});

it('sends the refunded order uuid, not just its id', function (): void {
    // The client links orders by uuid and sends `refunded_order_uuid` back in the command. Without
    // the uuid on the way down it can only send null, unpicking the refund from what it refunds.
    $original = pushOrder($this->fx, ['state' => 'paid']);
    $originalId = (int) Order::query()->where('uuid', $original)->value('id');

    $refund = pushOrder($this->fx, ['state' => 'paid', 'is_refund' => true, 'refunded_order_uuid' => $original]);

    $body = $this->withHeaders($this->fx->headers())->getJson('/api/pos/orders/'.$refund)->assertOk()->json();

    expect($body['refunded_order_id'])->toBe($originalId)
        ->and($body['refunded_order_uuid'])->toBe($original);
});

it('never returns another company orders', function (): void {
    $stranger = PosFixtures::make()->withSession();
    pushOrder($stranger);
    $mine = pushOrder($this->fx);

    $response = $this->withHeaders($this->fx->headers())->getJson('/api/pos/orders')->assertOk();

    expect($response->json('records'))->toHaveCount(1)
        ->and($response->json('records.0.uuid'))->toBe($mine);
});

it('pages with a cursor and reports a total that does not shrink', function (): void {
    foreach (range(1, 3) as $i) {
        pushOrder($this->fx);
    }

    $first = $this->withHeaders($this->fx->headers())->getJson('/api/pos/orders?limit=2')->assertOk();

    expect($first->json('records'))->toHaveCount(2)
        ->and($first->json('total'))->toBe(3)
        ->and($first->json('next_cursor'))->not->toBeNull();

    $second = $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/orders?limit=2&cursor='.$first->json('next_cursor'))
        ->assertOk();

    expect($second->json('records'))->toHaveCount(1)
        // Null rather than a number: counting again would re-run the whole match set to answer a
        // question page one already answered, and a count taken *after* the cursor would read 1 —
        // which is worse than not answering, because it looks like a page count and is not one.
        ->and($second->json('total'))->toBeNull()
        ->and($second->json('next_cursor'))->toBeNull();

    // The pages do not overlap — a cursor that used `<=` would repeat a row on every page boundary.
    $seen = array_merge(
        array_column($first->json('records'), 'uuid'),
        array_column($second->json('records'), 'uuid'),
    );
    expect($seen)->toHaveCount(3)->and(array_unique($seen))->toHaveCount(3);
});

it('searches by receipt number, customer and cardholder', function (): void {
    $customer = Customer::query()->create([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Gudrun Fairweather',
        'display_name' => 'Gudrun Fairweather',
    ]);

    $uuid = pushOrder(
        $this->fx,
        ['state' => 'paid', 'customer_id' => $customer->getKey(), 'receipt_number' => 'RC-0042'],
        [[
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'payment_method_id' => $this->fx->card->getKey(),
            'amount' => '20.00',
            'cardholder_name' => 'G FAIRWEATHER',
        ]],
    );

    $receipt = (string) Order::query()->where('uuid', $uuid)->value('receipt_number');
    expect($receipt)->toBe('RC-0042');

    pushOrder($this->fx, ['receipt_number' => 'RC-0043']);

    $find = fn (string $term): array => $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/orders?search='.urlencode($term))->assertOk()->json('records');

    expect($find($receipt))->toHaveCount(1)
        ->and($find($receipt)[0]['uuid'])->toBe($uuid)
        ->and($find('Fairweather'))->toHaveCount(1)
        ->and($find('Fairweather')[0]['uuid'])->toBe($uuid)
        ->and($find('FAIRWEATHER')[0]['uuid'])->toBe($uuid)
        ->and($find('no-such-order'))->toHaveCount(0);
});

it('does not repeat an order that matches on several payments', function (): void {
    // A join would return this order once per matching payment row; `whereHas` returns it once.
    $uuid = pushOrder($this->fx, ['state' => 'paid'], [
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'payment_method_id' => $this->fx->card->getKey(), 'amount' => '10.00', 'cardholder_name' => 'A SMITH'],
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'payment_method_id' => $this->fx->card->getKey(), 'amount' => '10.00', 'cardholder_name' => 'A SMITH'],
    ]);

    $records = $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/orders?search=SMITH')->assertOk()->json('records');

    expect($records)->toHaveCount(1)->and($records[0]['uuid'])->toBe($uuid);
});

it('filters by state and date range', function (): void {
    $paid = pushOrder($this->fx, ['state' => 'paid']);
    pushOrder($this->fx, ['state' => 'draft']);

    $records = $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/orders?state=paid')->assertOk()->json('records');

    expect($records)->toHaveCount(1)->and($records[0]['uuid'])->toBe($paid);

    // A window that ended yesterday holds nothing rung up today.
    expect($this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/orders?to='.now()->subDay()->toDateString())->assertOk()->json('records'))
        ->toHaveCount(0);
});

it('hydrates one order in full, and 404s for a stranger', function (): void {
    $uuid = pushOrder($this->fx);

    $this->withHeaders($this->fx->headers())->getJson('/api/pos/orders/'.$uuid)
        ->assertOk()
        ->assertJsonPath('uuid', $uuid)
        ->assertJsonStructure(['uuid', 'state', 'amount_total', 'lines', 'payments', 'courses']);

    $stranger = PosFixtures::make()->withSession();
    $theirs = pushOrder($stranger);

    $this->withHeaders($this->fx->headers())->getJson('/api/pos/orders/'.$theirs)->assertNotFound();
});
