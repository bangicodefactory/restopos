<?php

declare(strict_types=1);

use App\Enums\OrderState;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-406 / REG-271 — what a refund is allowed to point at.
 *
 * The order-level link was fixed in BAN-465: the client sends `refunded_order_uuid` and the server
 * resolves it. The *line*-level link had never been written at all, and the two together are what
 * make a refund auditable — "which sale is this credit against, and which line of it".
 *
 * Spec 01 §1807 sets the rule these pin: a refund references exactly one original order.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();
});

function linkSync(PosFixtures $fx, array $orders): TestResponse
{
    return test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'employee_id' => $fx->cashier->getKey(),
        'orders' => $orders,
    ]);
}

/** @return array{0: string, 1: string} */
function linkSell(PosFixtures $fx): array
{
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    linkSync($fx, [$fx->orderCommand($orderUuid, [[
        'op' => 'create', 'uuid' => $lineUuid, 'variant_id' => $fx->variant->getKey(),
        'qty' => '2', 'price_unit' => '10.00', 'discount' => '0',
    ]], ['state' => OrderState::Paid->value], [
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'payment_method_id' => $fx->cash->getKey(), 'amount' => '24.20'],
    ])])->assertOk()->assertJsonPath('results.0.status', 'ok');

    return [$orderUuid, $lineUuid];
}

it('populates refunded_order_id on the refund order', function (): void {
    // BAN-465's half, kept pinned here: the client sends a uuid and the column is an id.
    [$originalUuid, $lineUuid] = linkSell($this->fx);
    $refundUuid = (string) Str::uuid();

    linkSync($this->fx, [$this->fx->orderCommand($refundUuid, [[
        'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '-1', 'price_unit' => '10.00', 'discount' => '0', 'refunded_line_uuid' => $lineUuid,
    ]], ['state' => OrderState::Paid->value, 'is_refund' => true, 'refunded_order_uuid' => $originalUuid])])
        ->assertOk()->assertJsonPath('results.0.status', 'ok');

    $original = Order::query()->where('uuid', $originalUuid)->firstOrFail();
    $refund = Order::query()->where('uuid', $refundUuid)->firstOrFail();

    expect((int) $refund->refunded_order_id)->toBe((int) $original->getKey())
        ->and((bool) $refund->is_refund)->toBeTrue();
});

it('refuses a refund that names no line', function (): void {
    // Required, not optional. Without the link the cap has nothing to count against, so omitting
    // the field would itself be a way to refund without limit — which is why this is refused rather
    // than accepted-and-unlinked.
    [$originalUuid] = linkSell($this->fx);

    linkSync($this->fx, [$this->fx->orderCommand((string) Str::uuid(), [[
        'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '-1', 'price_unit' => '10.00', 'discount' => '0',
    ]], ['state' => OrderState::Paid->value, 'is_refund' => true, 'refunded_order_uuid' => $originalUuid])])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'rejected')
        ->assertJsonPath('results.0.error.code', 'refund_unlinked');

    expect(OrderLine::query()->where('quantity', '<', 0)->count())->toBe(0);
});

it('refuses a refund spanning two original orders', function (): void {
    // Only visible when the lines are looked at together — each one alone is perfectly ordinary.
    // A mixed refund posts credits against an order the customer never bought from.
    [$firstUuid, $firstLine] = linkSell($this->fx);
    [, $secondLine] = linkSell($this->fx);

    linkSync($this->fx, [$this->fx->orderCommand((string) Str::uuid(), [
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
            'qty' => '-1', 'price_unit' => '10.00', 'discount' => '0', 'refunded_line_uuid' => $firstLine],
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
            'qty' => '-1', 'price_unit' => '10.00', 'discount' => '0', 'refunded_line_uuid' => $secondLine],
    ], ['state' => OrderState::Paid->value, 'is_refund' => true, 'refunded_order_uuid' => $firstUuid])])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'rejected')
        ->assertJsonPath('results.0.error.code', 'refund_spans_orders');

    expect(OrderLine::query()->where('quantity', '<', 0)->count())->toBe(0);
});

it('refuses a refund pointing at a line on a different order than it claims', function (): void {
    // The link is resolved *within* the order named by `refunded_order_uuid`, so a line uuid from
    // elsewhere resolves to nothing rather than to itself.
    //
    // Answered `refund_unlinked` rather than `refund_spans_orders`, and that is the accurate one:
    // one line means one original order, so the span rule has nothing to object to — the refund
    // simply names an order and points at a line that is not on it.
    [$firstUuid] = linkSell($this->fx);
    [, $otherLine] = linkSell($this->fx);

    linkSync($this->fx, [$this->fx->orderCommand((string) Str::uuid(), [[
        'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '-1', 'price_unit' => '10.00', 'discount' => '0', 'refunded_line_uuid' => $otherLine,
    ]], ['state' => OrderState::Paid->value, 'is_refund' => true, 'refunded_order_uuid' => $firstUuid])])
        ->assertOk()
        ->assertJsonPath('results.0.error.code', 'refund_unlinked');

    expect(OrderLine::query()->where('quantity', '<', 0)->count())->toBe(0);
});

it('refuses a refund against another venue order', function (): void {
    // Tenancy, from the refund direction. `refunded_order_uuid` resolves through a scoped lookup,
    // so a line uuid merely observed elsewhere buys nothing.
    $other = PosFixtures::make()->withSession();
    [$theirOrder, $theirLine] = linkSell($other);

    linkSync($this->fx, [$this->fx->orderCommand((string) Str::uuid(), [[
        'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '-1', 'price_unit' => '10.00', 'discount' => '0', 'refunded_line_uuid' => $theirLine,
    ]], ['state' => OrderState::Paid->value, 'is_refund' => true, 'refunded_order_uuid' => $theirOrder])])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'rejected');

    expect(OrderLine::query()->where('quantity', '<', 0)->count())->toBe(0);
});

it('accepts several refund lines against one original order', function (): void {
    // The rule is one *order*, not one line — refunding two of a table's dishes is ordinary.
    $orderUuid = (string) Str::uuid();
    $first = (string) Str::uuid();
    $second = (string) Str::uuid();

    linkSync($this->fx, [$this->fx->orderCommand($orderUuid, [
        ['op' => 'create', 'uuid' => $first, 'variant_id' => $this->fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0'],
        ['op' => 'create', 'uuid' => $second, 'variant_id' => $this->fx->drinkVariant->getKey(),
            'qty' => '1', 'price_unit' => '2.50', 'discount' => '0'],
    ], ['state' => OrderState::Paid->value], [
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '15.13'],
    ])])->assertOk();

    linkSync($this->fx, [$this->fx->orderCommand((string) Str::uuid(), [
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
            'qty' => '-1', 'price_unit' => '10.00', 'discount' => '0', 'refunded_line_uuid' => $first],
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->drinkVariant->getKey(),
            'qty' => '-1', 'price_unit' => '2.50', 'discount' => '0', 'refunded_line_uuid' => $second],
    ], ['state' => OrderState::Paid->value, 'is_refund' => true, 'refunded_order_uuid' => $orderUuid])])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    expect(OrderLine::query()->where('quantity', '<', 0)->count())->toBe(2);
});
