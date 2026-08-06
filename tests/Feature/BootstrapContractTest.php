<?php

declare(strict_types=1);

// Own namespace so the `pushOrders` / `orderOnSession` helpers below stay out of the global function
// table Pest shares across every test file (the Pest DSL resolves via the global-namespace fallback).

namespace Tests\Feature\BootstrapContract;

use App\Http\Resources\Pos\SessionResource;
use App\Models\Audit\SyncConflict;
use App\Models\Pos\Order;
use App\Models\Pos\Payment;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/*
|--------------------------------------------------------------------------
| PHP↔TS field-name contract (BAN-400)
|--------------------------------------------------------------------------
|
| Seven fields were named differently on the two sides of the boundary and every
| one dropped its value silently — an empty floor plan, a lost table transfer, an
| unlinked refund, a vanished tip, null card details, an empty opening float, and a
| sync_conflicts row for every order. Nothing errored; the data just disappeared.
|
| These tests push real rows through the real services (BootstrapService on the way
| out, OrderSyncService on the way in) and assert the emitted / persisted keys match
| the client contract in packages/domain/src/types.ts. A rename on either side that
| re-breaks the pairing fails here.
*/

beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession()->withFloor();
});

/** Push order commands through the real sync endpoint. Named to avoid colliding with SyncTest's `sync()`. */
function pushOrders(array $orders): TestResponse
{
    /** @var PosFixtures $fx */
    $fx = test()->fx;

    return test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'client_version' => '1.0.0',
        'employee_id' => $fx->cashier->getKey(),
        'orders' => $orders,
    ]);
}

/** An order that carries only `pos_session_id` — the key the register actually sends (BAN-400 f). */
function orderOnSession(string $uuid, array $order = [], array $payments = []): array
{
    /** @var PosFixtures $fx */
    $fx = test()->fx;

    return $fx->orderCommand($uuid, [], [
        // Drop the fixture's legacy `session_id` so resolution must succeed on `pos_session_id`
        // alone; without the server-side fix that reaches resolveForIngest(null) → reroute.
        'session_id' => null,
        'pos_session_id' => $fx->session->getKey(),
        ...$order,
    ], $payments);
}

// ── (a) floor plan — BootstrapService serialises tables into the client shape ──

it('bootstrap serialises restaurant tables into the client field names, positions as numbers', function (): void {
    $table = $this->fx->table(7);
    $table->forceFill(['shape' => 'round', 'position_x' => '12.50', 'position_y' => '34.25', 'width' => '80.00', 'height' => '80.00'])->save();

    $row = collect($this->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap')->assertOk()->json('data.restaurant_tables'))
        ->firstWhere('id', $table->getKey());

    expect($row)->not->toBeNull()
        ->and($row)->toHaveKeys(['id', 'floor_id', 'parent_id', 'table_number', 'identifier', 'seats', 'shape', 'position_h', 'position_v', 'width', 'height', 'active'])
        // The database column names must never reach the client.
        ->and($row)->not->toHaveKey('restaurant_floor_id')
        ->and($row)->not->toHaveKey('position_x')
        ->and($row)->not->toHaveKey('position_y')
        // Positions must be numbers — the floor plan feeds them to inline styles and React only
        // appends `px` to numeric values; the `decimal:2` cast would otherwise emit strings.
        ->and($row['position_h'])->not->toBeString()
        ->and($row['position_h'])->toBe(12.5)
        ->and($row['position_v'])->toBe(34.25)
        ->and($row['floor_id'])->toBe($this->fx->floor->getKey());
});

// ── (g) opening float — both bootstrap and the session endpoint expose opening_float ──

it('bootstrap exposes the session opening_float, not the raw column name', function (): void {
    $session = $this->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap')->assertOk()->json('data.pos_session');

    expect($session)->toHaveKey('opening_float')
        ->and($session['opening_float'])->toBe((string) $this->fx->session->cash_balance_opening);
});

it('bootstrap and the session endpoint agree on every renamed opening field', function (): void {
    // A session reaches the register down two paths. A rename applied to one of them is worse than
    // none at all: the field is simply absent on whichever path was missed, and the screen reading
    // it shows nothing — which is how `opening_float` came to be renamed on bootstrap only.
    $bootstrap = $this->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap')->assertOk()->json('data.pos_session');
    $endpoint = $this->withHeaders($this->fx->headers())->getJson('/api/pos/sessions/current')->assertOk()->json('session');

    foreach (['opening_float', 'expected_opening_float'] as $field) {
        expect($bootstrap)->toHaveKey($field)
            ->and($endpoint)->toHaveKey($field)
            ->and($bootstrap[$field])->toBe($endpoint[$field]);
    }

    // …and neither path leaks the column names those replace.
    foreach (SessionResource::RenamedColumns as $column) {
        expect($bootstrap)->not->toHaveKey($column)
            ->and($endpoint)->not->toHaveKey($column);
    }
});

// ── (b) table transfer + (f) no reroute/conflict ──

it('a table transfer survives an update, with no session reroute or conflict row', function (): void {
    $uuid = (string) Str::uuid();
    $tableA = $this->fx->table(1);
    $tableB = $this->fx->table(2);

    $create = pushOrders([orderOnSession($uuid, ['restaurant_table_id' => $tableA->getKey()])]);
    $create->assertOk()->assertJsonPath('results.0.status', 'ok');

    // The transfer arrives as an update carrying `restaurant_table_id` (not `table_id`).
    $update = pushOrders([orderOnSession($uuid, ['restaurant_table_id' => $tableB->getKey()])]);
    $update->assertOk()->assertJsonPath('results.0.status', 'ok');

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();
    expect((int) $order->restaurant_table_id)->toBe($tableB->getKey());

    foreach ([$create, $update] as $response) {
        expect(collect($response->json('results.0.warnings'))->pluck('code'))->not->toContain('session_rerouted', 'session_rescued');
    }
    expect(SyncConflict::query()->count())->toBe(0);
});

// ── (c) refund linkage by uuid ──

it('links a refund to the original order resolved from refunded_order_uuid', function (): void {
    $originalUuid = (string) Str::uuid();
    pushOrders([orderOnSession($originalUuid, ['state' => 'paid'])])->assertOk()->assertJsonPath('results.0.status', 'ok');
    $original = Order::query()->where('uuid', $originalUuid)->firstOrFail();

    $refundUuid = (string) Str::uuid();
    pushOrders([orderOnSession($refundUuid, ['is_refund' => true, 'refunded_order_uuid' => $originalUuid])])
        ->assertOk()->assertJsonPath('results.0.status', 'ok');

    $refund = Order::query()->where('uuid', $refundUuid)->firstOrFail();
    expect((int) $refund->refunded_order_id)->toBe($original->getKey())
        ->and((bool) $refund->is_refund)->toBeTrue();
});

it('resolves a refund against an original earlier in the same batch', function (): void {
    $originalUuid = (string) Str::uuid();
    $refundUuid = (string) Str::uuid();

    // One push, original before refund: each command is persisted before the next is ingested.
    pushOrders([
        orderOnSession($originalUuid, ['state' => 'paid']),
        orderOnSession($refundUuid, ['is_refund' => true, 'refunded_order_uuid' => $originalUuid]),
    ])->assertOk()
        ->assertJsonPath('results.0.status', 'ok')
        ->assertJsonPath('results.1.status', 'ok');

    $original = Order::query()->where('uuid', $originalUuid)->firstOrFail();
    $refund = Order::query()->where('uuid', $refundUuid)->firstOrFail();
    expect((int) $refund->refunded_order_id)->toBe($original->getKey());
});

// ── (d) tips persist, and a zero tip stays distinct from "not asked" ──

it('persists a tip and keeps an explicit zero tip distinct from not-asked', function (): void {
    $tipped = (string) Str::uuid();
    pushOrders([orderOnSession($tipped, ['is_tipped' => true, 'tip_amount' => '2.50'])])->assertOk();
    $order = Order::query()->where('uuid', $tipped)->firstOrFail();
    expect((bool) $order->is_tipped)->toBeTrue()
        ->and((string) $order->tip_amount)->toBe('2.5000');

    // Explicit zero tip: tipped, amount 0.
    $zero = (string) Str::uuid();
    pushOrders([orderOnSession($zero, ['is_tipped' => true, 'tip_amount' => '0'])])->assertOk();
    $zeroOrder = Order::query()->where('uuid', $zero)->firstOrFail();
    expect((bool) $zeroOrder->is_tipped)->toBeTrue()
        ->and((float) $zeroOrder->tip_amount)->toBe(0.0);

    // Not asked: the default.
    $none = (string) Str::uuid();
    pushOrders([orderOnSession($none)])->assertOk();
    expect((bool) Order::query()->where('uuid', $none)->firstOrFail()->is_tipped)->toBeFalse();
});

// ── (e) flat terminal card details on the payment command ──

it('stores the flat card details the register sends on a payment command', function (): void {
    $uuid = (string) Str::uuid();

    pushOrders([orderOnSession($uuid, ['state' => 'paid'], [[
        'op' => 'create',
        'uuid' => (string) Str::uuid(),
        'payment_method_id' => $this->fx->card->getKey(),
        'amount' => '24.20',
        'is_change' => false,
        'is_refund' => false,
        'payment_status' => 'done',
        // Flat on the command — not nested under `terminal`.
        'card_brand' => 'visa',
        'card_last4' => '4242',
        'auth_code' => 'A12345',
        'transaction_reference' => 'txn_987',
    ]])])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();
    $payment = Payment::query()->where('pos_order_id', $order->getKey())->firstOrFail();

    expect($payment->card_brand)->toBe('visa')
        ->and($payment->card_last4)->toBe('4242')
        ->and($payment->auth_code)->toBe('A12345')
        ->and($payment->transaction_reference)->toBe('txn_987');
});

it('lets a nested terminal object win over the flat card fields on overlap', function (): void {
    $uuid = (string) Str::uuid();

    pushOrders([orderOnSession($uuid, ['state' => 'paid'], [[
        'op' => 'create',
        'uuid' => (string) Str::uuid(),
        'payment_method_id' => $this->fx->card->getKey(),
        'amount' => '24.20',
        'payment_status' => 'done',
        'card_brand' => 'visa',                    // flat, overlaps → nested wins
        'auth_code' => 'FLAT01',                    // flat only → preserved
        'terminal' => ['card_brand' => 'amex'],
    ]])])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $payment = Payment::query()
        ->where('pos_order_id', Order::query()->where('uuid', $uuid)->value('id'))
        ->firstOrFail();

    expect($payment->card_brand)->toBe('amex')
        ->and($payment->auth_code)->toBe('FLAT01');
});
