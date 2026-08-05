<?php

declare(strict_types=1);

use App\Models\Pos\Order;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-465 / REG-295 — cancelling or deleting an order must tell the kitchen.
 *
 * It did not. Both paths wrote to `pos_orders` and stopped there, so a fired order vanished from the
 * till while the pass kept the ticket and kept plating it. The delta cannot express this on its own:
 * it compares the snapshot against the order's lines, and cancelling an order does not remove its
 * lines, so the diff comes back empty and nothing is sent.
 *
 * The failure is invisible from the register, which is why it survived — the only place it shows up
 * is food nobody is going to pay for.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession()->withFloor()->withPrepDisplay();
});

function firedOrder(PosFixtures $fx, string $qty = '2'): string
{
    $uuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [[
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'variant_id' => $fx->variant->getKey(),
            'qty' => $qty,
            'price_unit' => '10.00',
            'discount' => '0',
        ]], ['table_id' => $fx->tableOne?->getKey()])],
    ])->assertOk();

    test()->withHeaders($fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    return $uuid;
}

/** Quantities the pass still believes it has to make. */
function pendingPrepQuantity(string $orderUuid): string
{
    $orderId = (int) Order::query()->withTrashed()->where('uuid', $orderUuid)->value('id');

    return (string) DB::table('prep_order_lines')
        ->join('prep_orders', 'prep_orders.id', '=', 'prep_order_lines.prep_order_id')
        ->where('prep_orders.pos_order_id', $orderId)
        ->sum('prep_order_lines.quantity');
}

it('withdraws the kitchen ticket when an order is cancelled', function (): void {
    $uuid = firedOrder($this->fx);

    expect(pendingPrepQuantity($uuid))->toBe('2');

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [['uuid' => $uuid, 'op' => 'cancel', 'order' => ['cancel_reason' => 'Walked out']]],
    ])->assertOk();

    // The cancellation is *added* as a negative line rather than deleting the original, which is how
    // every other kitchen change is recorded — so the net is what the pass should still make.
    expect(pendingPrepQuantity($uuid))->toBe('0');
});

it('withdraws the kitchen ticket when a fired draft is deleted', function (): void {
    // "Send to kitchen, then the table walks out before paying" — a draft absolutely can be fired.
    $uuid = firedOrder($this->fx);

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [['uuid' => $uuid, 'op' => 'delete_draft']],
    ])->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect(pendingPrepQuantity($uuid))->toBe('0')
        ->and(Order::query()->where('uuid', $uuid)->exists())->toBeFalse();
});

it('leaves an order that never reached the kitchen alone', function (): void {
    $uuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid)],
    ])->assertOk();

    // Nothing was fired, so there is nothing to withdraw — and no cancellation ticket should print
    // for food nobody was ever asked to make.
    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [['uuid' => $uuid, 'op' => 'cancel', 'order' => []]],
    ])->assertOk();

    expect(DB::table('prep_orders')->count())->toBe(0)
        ->and(DB::table('preparation_print_jobs')->where('job_type', 'prep_cancelled')->count())->toBe(0);
});

it('does not re-cancel on a second cancel of the same order', function (): void {
    $uuid = firedOrder($this->fx);

    $cancel = ['orders' => [['uuid' => $uuid, 'op' => 'cancel', 'order' => []]]];

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', $cancel)->assertOk();
    $afterFirst = (int) DB::table('prep_order_lines')->count();

    // The snapshot is emptied by the withdrawal, so the second pass has nothing left to negate.
    // Without that, a retried sync would drive the pending quantity negative.
    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', $cancel)->assertOk();

    expect(DB::table('prep_order_lines')->count())->toBe($afterFirst)
        ->and(pendingPrepQuantity($uuid))->toBe('0');
});

it('completes the cancellation even when the kitchen withdrawal fails', function (): void {
    // The sale is already cancelled by the time the withdrawal runs. Throwing would roll that back
    // and hand the till a sync error for an order it has correctly finished with — a kitchen ticket
    // that outlives its order is the smaller of the two problems.
    $uuid = firedOrder($this->fx);

    // A real failure rather than a mock: `PreparationService` is final, so the snapshot is corrupted
    // instead. `bccomp` on a non-numeric quantity throws, which is as close to "the kitchen path
    // blew up" as this can get without inventing a seam that exists only for the test.
    $orderId = (int) Order::query()->where('uuid', $uuid)->value('id');
    DB::table('order_preparation_snapshots')->where('pos_order_id', $orderId)->update([
        'snapshot' => json_encode(['lines' => [['uuid' => 'x', 'quantity' => 'not-a-number']]]),
    ]);

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [['uuid' => $uuid, 'op' => 'cancel', 'order' => []]],
    ])->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect(Order::query()->where('uuid', $uuid)->value('state')->value)->toBe('cancelled');
});
