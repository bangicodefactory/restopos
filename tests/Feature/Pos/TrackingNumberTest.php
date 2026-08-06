<?php

declare(strict_types=1);

use App\Enums\OrderState;
use App\Models\Pos\Order;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-506 — a till must not lose a sale to a tracking number someone else already used.
 *
 * A register mints its tracking number from its **own** local counter, offline, where nothing can be
 * checked. So a till paired into a session that already holds `001` proposes `001`. Since BAN-470
 * added `pos_orders_session_tracking_unique` that rejected the order outright — and the trigger is
 * the ordinary one of bringing a second till onto the counter mid-service, which then loses every
 * sale until its counter happens to walk past whatever the session holds.
 *
 * The number is a proposal. The server decides, and says so in the ack.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();
});

/** Push an order with a chosen tracking number, exactly as a till would. */
function pushWithTracking(PosFixtures $fx, string $tracking, ?string $uuid = null): array
{
    $uuid ??= (string) Str::uuid();

    $response = test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [], [
            'state' => OrderState::Paid->value,
            'tracking_number' => $tracking,
        ])],
    ]);

    return ['uuid' => $uuid, 'response' => $response];
}

it('accepts an order whose proposed number is already taken, and renumbers it', function (): void {
    // The exact production scenario: the session already holds 001, a freshly paired till proposes
    // 001 because its own counter starts there.
    $first = pushWithTracking($this->fx, '001');
    $first['response']->assertOk()->assertJsonPath('results.0.status', 'ok');

    $second = pushWithTracking($this->fx, '001');
    $second['response']->assertOk()->assertJsonPath('results.0.status', 'ok');

    $numbers = Order::query()->pluck('tracking_number', 'uuid');

    expect($numbers[$first['uuid']])->toBe('001')
        ->and($numbers[$second['uuid']])->not->toBe('001')
        ->and($numbers[$second['uuid']])->toBe('002');
});

it('tells the till which number it actually got', function (): void {
    // The kitchen prints this and the counter calls it. A till still showing its own guess would be
    // calling a number nobody else has.
    pushWithTracking($this->fx, '001');

    $second = pushWithTracking($this->fx, '001');

    $second['response']->assertOk()->assertJsonPath('results.0.order.tracking_number', '002');
});

it('keeps the number the till asked for when it is free', function (): void {
    // Renumbering is a fallback, not a policy. A till that proposes something free keeps it, so the
    // number a cashier already read out loud does not change under them.
    $pushed = pushWithTracking($this->fx, '047');

    $pushed['response']->assertOk()->assertJsonPath('results.0.order.tracking_number', '047');
    expect(Order::query()->where('uuid', $pushed['uuid'])->value('tracking_number'))->toBe('047');
});

it('fills the lowest gap in the numbers it can use', function (): void {
    // A hole left by a number that was never issued is filled, so a busy service does not walk its
    // numbers up to three digits by mid-afternoon.
    foreach (['001', '003'] as $number) {
        pushWithTracking($this->fx, $number);
    }

    $next = pushWithTracking($this->fx, '009');

    // 009 is free, so it is honoured — renumbering is a fallback, not a policy.
    $next['response']->assertOk()->assertJsonPath('results.0.order.tracking_number', '009');

    $collide = pushWithTracking($this->fx, '001');

    $collide['response']->assertOk()->assertJsonPath('results.0.order.tracking_number', '002');
});

it('does not reuse a soft-deleted order number', function (): void {
    // Not a nicety — a requirement. `pos_orders_session_tracking_unique` is a plain unique index
    // over (session, tracking_number) with no `deleted_at` term, so a soft-deleted row still holds
    // its number at the database level. Handing it out again would violate the index and lose the
    // sale, which is the exact bug this ticket fixes.
    //
    // This is worth a test because the "obvious optimisation" — filtering deleted rows out of the
    // used set so numbers can be recycled — reintroduces it.
    pushWithTracking($this->fx, '001');
    Order::query()->where('tracking_number', '001')->delete();

    $next = pushWithTracking($this->fx, '001');

    $next['response']->assertOk()->assertJsonPath('results.0.status', 'ok');
    expect($next['response']->json('results.0.order.tracking_number'))->not->toBe('001');
});

it('does not hand a register the number a kiosk is already using', function (): void {
    // Availability is keyed on the bare number, so kiosk `K001` reserves register `001`. The counter
    // calls "001", and two customers answering the same call is the failure the index prevents.
    Order::query()->create([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'pos_config_id' => $this->fx->config->getKey(),
        'pos_session_id' => $this->fx->session->getKey(),
        'name' => 'K/0001',
        'access_token' => (string) Str::uuid(),
        'currency_id' => $this->fx->config->currency_id,
        'tracking_number' => 'K001',
        'state' => 'paid',
        'ordered_at' => now(),
        'amount_total' => '5.0000',
    ]);

    $pushed = pushWithTracking($this->fx, '001');

    $pushed['response']->assertOk()->assertJsonPath('results.0.order.tracking_number', '002');
});

it('survives another writer taking the number between the read and the insert', function (): void {
    // The real race, forced. Allocation reads the used set and then inserts; two tills submitting in
    // the same moment both read the same free number. Sequential requests cannot exercise this — the
    // second read always sees the first's committed row — so a competing order is inserted from
    // inside the create itself, which is exactly what the losing till experiences.
    $session = $this->fx->session;
    $stolen = false;

    Order::creating(function (Order $order) use ($session, &$stolen): void {
        if ($stolen || $order->tracking_number === null) {
            return;
        }

        $stolen = true;

        // Another till gets there first with the number this one just picked.
        Order::query()->create([
            'uuid' => (string) Str::uuid(),
            'company_id' => $this->fx->company->getKey(),
            'pos_config_id' => $this->fx->config->getKey(),
            'pos_session_id' => $session->getKey(),
            'name' => 'RACE/0001',
            'access_token' => (string) Str::uuid(),
            'currency_id' => $this->fx->config->currency_id,
            'tracking_number' => $order->tracking_number,
            'state' => 'paid',
            'ordered_at' => now(),
            'amount_total' => '1.0000',
        ]);
    });

    $pushed = pushWithTracking($this->fx, '001');

    Order::flushEventListeners();

    // The sale is not lost: the retry re-reads and takes the next free number.
    $pushed['response']->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect($stolen)->toBeTrue('the race never happened, so this test proved nothing');

    $mine = Order::query()->where('uuid', $pushed['uuid'])->value('tracking_number');
    $theirs = Order::query()->where('name', 'RACE/0001')->value('tracking_number');

    expect($mine)->not->toBeNull()->and($mine)->not->toBe($theirs);
});

it('numbers an order that proposes nothing at all', function (): void {
    // A till that sends no tracking number still gets one — the kitchen ticket has to say something.
    $uuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid, [], ['state' => OrderState::Paid->value])],
    ])->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect(Order::query()->where('uuid', $uuid)->value('tracking_number'))->toBe('001');
});
