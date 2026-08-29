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

// ── (g) the merchant slip — a field with a reader, a column and no writer (BAN-414) ──
//
// The ninth instance of this file's failure, and the longest: `terminal_ticket` is a column, is in
// the model's `$fillable`, is declared on `PaymentRow`, and is read straight back into the register's
// replica at `order-lookup.ts:361`. Between those two ends there was nothing at all — the register's
// payment command did not send it, OrderSyncService did not persist it, and OrderPaymentResource did
// not emit it. So the read resolved to null on every order that had ever been near the server, and
// REG-213's "the terminal's own ticket text is printed on the customer receipt" could not happen.

it('carries the terminal ticket all the way from the register command back onto the resource', function (): void {
    $uuid = (string) Str::uuid();
    $slip = "MERCHANT COPY\nVISA ****4242\nAUTH A12345\nAPPROVED";

    pushOrders([orderOnSession($uuid, ['state' => 'paid'], [[
        'op' => 'create',
        'uuid' => (string) Str::uuid(),
        'payment_method_id' => $this->fx->card->getKey(),
        'amount' => '24.20',
        'payment_status' => 'done',
        'card_last4' => '4242',
        'terminal_ticket' => $slip,
    ]])])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();
    $payment = Payment::query()->where('pos_order_id', $order->getKey())->firstOrFail();

    // Persisted…
    expect($payment->terminal_ticket)->toBe($slip);

    // …and handed back, which is the half that was missing. Asserted through the real endpoint
    // rather than the resource in isolation: the client reads it off this payload.
    $this->withHeaders($this->fx->headers())
        ->getJson("/api/pos/orders/{$uuid}")
        ->assertOk()
        ->assertJsonPath('payments.0.terminal_ticket', $slip);
});

it('accepts the slip nested under `terminal` like every other field on that object', function (): void {
    $uuid = (string) Str::uuid();

    pushOrders([orderOnSession($uuid, ['state' => 'paid'], [[
        'op' => 'create',
        'uuid' => (string) Str::uuid(),
        'payment_method_id' => $this->fx->card->getKey(),
        'amount' => '24.20',
        'payment_status' => 'done',
        'terminal' => ['terminal_ticket' => 'NESTED SLIP'],
    ]])])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $payment = Payment::query()
        ->where('pos_order_id', Order::query()->where('uuid', $uuid)->value('id'))
        ->firstOrFail();

    expect($payment->terminal_ticket)->toBe('NESTED SLIP');
});

it('leaves the slip null when the terminal did not hand one back', function (): void {
    // The control. A cash sale must not acquire an empty-string slip that a receipt would then
    // print a blank block for.
    $uuid = (string) Str::uuid();

    pushOrders([orderOnSession($uuid, ['state' => 'paid'], [[
        'op' => 'create',
        'uuid' => (string) Str::uuid(),
        'payment_method_id' => $this->fx->card->getKey(),
        'amount' => '24.20',
        'payment_status' => 'done',
    ]])])->assertOk();

    $payment = $this->withHeaders($this->fx->headers())
        ->getJson("/api/pos/orders/{$uuid}")
        ->assertOk()
        ->json('payments.0');

    // `assertJsonPath(..., null)` would NOT do here: a missing key resolves to null through
    // `data_get`, so it passes just as happily with the resource emitting no `terminal_ticket`
    // at all — which is the exact defect this section exists to catch. The key has to be
    // present AND null: the register reads it back into the replica unconditionally
    // (order-lookup.ts:361), so an absent key and a null one are different bugs.
    expect($payment)->toHaveKey('terminal_ticket')
        ->and($payment['terminal_ticket'])->toBeNull();
});

// ── (h) printers — the register reads a shape the bootstrap had never sent (BAN-426) ──
//
// The eighth instance of exactly the failure this file was opened for, and the worst of them,
// because it was not a dropped value but a crash. `PosPrinterRow` declared `address`,
// `print_receipt` and `pos_category_ids`; `pos_printers` has `printer_ip`, `is_receipt_printer`
// and a pivot; `posLoadFields()` returned `['*']`. So every printer arrived with every field the
// client reads undefined: the receipt printer was classified `prep`, `categoryIds` was undefined,
// and `resolveTargets` threw a TypeError on the first course sent to the kitchen.
//
// Nothing caught it. `bindingsFromCatalog` had no test, and the printer objects elsewhere in the
// tree were hand-written to the declared type — both sides internally consistent, and disagreeing
// with each other. The register's half of this contract is
// resources/js/register/domain/printing.test.ts, over the same fixture.

/** @return array<int, array<string, mixed>> */
function bootstrapPrinters(): array
{
    /** @var PosFixtures $fx */
    $fx = test()->fx;

    return test()->withHeaders($fx->headers())->getJson('/api/pos/bootstrap')
        ->assertOk()
        ->json('data.pos_printers');
}

it('ships every printer field the register reads, and no column it does not', function (): void {
    $this->fx->withPrinters();

    /** @var array<string, mixed> $contract */
    $contract = json_decode(
        (string) file_get_contents(base_path('tests/fixtures/printing/printer-binding.json')),
        true,
        flags: JSON_THROW_ON_ERROR,
    )['printers'][0];

    $expected = array_values(array_diff(array_keys($contract), ['_why']));
    $rows = bootstrapPrinters();

    expect($rows)->toHaveCount(4);

    foreach ($rows as $row) {
        expect(array_keys($row))->toEqualCanonicalizing($expected);

        // The addressing columns are reassembled into `address`; shipping them too would give the
        // register two sources for one fact, which is how they drifted apart in the first place.
        expect($row)->not->toHaveKey('printer_ip')
            ->and($row)->not->toHaveKey('printer_port')
            ->and($row)->not->toHaveKey('proxy_ip')
            ->and($row)->not->toHaveKey('is_receipt_printer');
    }
});

it('derives one address per transport from the columns the back office edits', function (): void {
    $this->fx->withPrinters();

    $rows = collect(bootstrapPrinters())->keyBy('name');
    $s = $this->fx->suffix;

    expect($rows['Caisse'.$s]['address'])->toBe('192.168.1.51')            // ePOS, no port
        ->and($rows['Cuisine'.$s]['address'])->toBe('192.168.1.52:9100')   // network ESC/POS, port joined
        ->and($rows['Agent'.$s]['address'])->toBe('192.168.1.10');         // IoT/agent, the proxy host
});

it('names the receipt printer as one, so the register does not invent a placeholder', function (): void {
    $this->fx->withPrinters();

    $rows = collect(bootstrapPrinters())->keyBy('name');

    expect($rows['Caisse'.$this->fx->suffix]['print_receipt'])->toBeTrue()
        ->and($rows['Cuisine'.$this->fx->suffix]['print_receipt'])->toBeFalse();
});

it('materialises the category pivot, and keeps print-all distinct from an empty list', function (): void {
    $this->fx->withPrinters();

    $rows = collect(bootstrapPrinters())->keyBy('name');
    $s = $this->fx->suffix;

    // Routed by category: the pivot has to arrive as ids, or prep routing has nothing to match on.
    expect($rows['Cuisine'.$s]['pos_category_ids'])->toBe([$this->fx->category->getKey()])
        ->and($rows['Agent'.$s]['pos_category_ids'])->toBe([$this->fx->barCategory->getKey()]);

    // The pass prints everything. An empty `pos_category_ids` would make it the *fallback*
    // printer instead — used only when nothing else matched — so a drink the bar already prints
    // would never reach the pass. The two must stay separately expressible.
    expect($rows['Passe'.$s]['print_all_categories'])->toBeTrue()
        ->and($rows['Passe'.$s]['pos_category_ids'])->toBe([])
        ->and($rows['Cuisine'.$s]['print_all_categories'])->toBeFalse();
});
