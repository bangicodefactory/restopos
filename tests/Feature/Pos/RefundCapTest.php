<?php

declare(strict_types=1);

use App\Enums\OrderState;
use App\Models\Audit\AuditLog;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Support\Audit\AuditEvent;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-406 — a device could refund a ten-euro order ten times.
 *
 * `refunded_quantity` was tracked in the browser and nowhere else, so nothing on the server counted
 * what had already been given back. Probed before a line of this was written, and all three of these
 * were true:
 *
 *   - `refunded_order_line_id` was **null on every refund ever taken**. `createLine` resolved it
 *     through a helper that returns null unless handed an order, and called it without one — so the
 *     link a cap would have to count against did not exist.
 *   - A line sold twice accepted four units of refunds, and the original's `refunded_quantity`
 *     stayed at zero throughout.
 *   - One refund order could name two different original orders at once.
 *
 * The cap is counted under a row lock on the *original line* — the row two tills contend for — and
 * a refund that names nothing is refused outright, because otherwise omitting the field is itself a
 * way to refund without limit.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();
});

function capSync(PosFixtures $fx, array $orders): TestResponse
{
    return test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'employee_id' => $fx->cashier->getKey(),
        'orders' => $orders,
    ]);
}

/** Sell `$qty` units at €10, paid. @return array{0: string, 1: string} */
function capSell(PosFixtures $fx, string $qty = '2'): array
{
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    capSync($fx, [$fx->orderCommand($orderUuid, [[
        'op' => 'create', 'uuid' => $lineUuid, 'variant_id' => $fx->variant->getKey(),
        'qty' => $qty, 'price_unit' => '10.00', 'discount' => '0',
    ]], ['state' => OrderState::Paid->value], [
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'payment_method_id' => $fx->cash->getKey(),
            'amount' => bcmul($qty, '12.10', 2)],
    ])])->assertOk()->assertJsonPath('results.0.status', 'ok');

    return [$orderUuid, $lineUuid];
}

/** Push a refund of `$qty` units against `$lineUuid`. */
function capRefund(PosFixtures $fx, string $originalUuid, string $lineUuid, string $qty, ?string $refundUuid = null): TestResponse
{
    return capSync($fx, [$fx->orderCommand($refundUuid ?? (string) Str::uuid(), [[
        'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
        'qty' => '-'.$qty, 'price_unit' => '10.00', 'discount' => '0',
        'refunded_line_uuid' => $lineUuid,
    ]], [
        'state' => OrderState::Paid->value,
        'is_refund' => true,
        'refunded_order_uuid' => $originalUuid,
    ])]);
}

/** Units given back against a line, as the database sees them. */
function refundedUnits(string $lineUuid): string
{
    $original = OrderLine::query()->where('uuid', $lineUuid)->firstOrFail();

    return (string) OrderLine::query()
        ->where('refunded_order_line_id', $original->getKey())
        ->sum('quantity');
}

// ---------------------------------------------------------------- the cap

it('links a refund line to the line it refunds', function (): void {
    // Nothing else here can work until this does, and it had never once happened.
    [$originalUuid, $lineUuid] = capSell($this->fx);

    capRefund($this->fx, $originalUuid, $lineUuid, '1')->assertOk()->assertJsonPath('results.0.status', 'ok');

    $original = OrderLine::query()->where('uuid', $lineUuid)->firstOrFail();
    $refundLine = OrderLine::query()->where('quantity', '<', 0)->firstOrFail();

    expect((int) $refundLine->refunded_order_line_id)->toBe((int) $original->getKey());
});

it('refuses to give back more than was sold', function (): void {
    [$originalUuid, $lineUuid] = capSell($this->fx, '2');

    capRefund($this->fx, $originalUuid, $lineUuid, '2')->assertOk()->assertJsonPath('results.0.status', 'ok');

    capRefund($this->fx, $originalUuid, $lineUuid, '2')
        ->assertOk()
        ->assertJsonPath('results.0.status', 'rejected')
        ->assertJsonPath('results.0.error.code', 'refund_exceeds_sold');

    expect(refundedUnits($lineUuid))->toBe('-2');
});

it('lets a refund be taken in instalments up to the amount sold', function (): void {
    // Refunding one now and one later is ordinary; the cap counts the total, not the attempt.
    [$originalUuid, $lineUuid] = capSell($this->fx, '3');

    foreach (['1', '1', '1'] as $each) {
        capRefund($this->fx, $originalUuid, $lineUuid, $each)->assertOk()->assertJsonPath('results.0.status', 'ok');
    }

    capRefund($this->fx, $originalUuid, $lineUuid, '1')
        ->assertOk()
        ->assertJsonPath('results.0.error.code', 'refund_exceeds_sold');

    expect(refundedUnits($lineUuid))->toBe('-3');
});

it('derives refunded_quantity on the original rather than trusting the till', function (): void {
    // The column the ticket screen reads as "still refundable". Derived from the refunds that
    // exist, so a second till's refund is visible to the first.
    [$originalUuid, $lineUuid] = capSell($this->fx, '3');

    capRefund($this->fx, $originalUuid, $lineUuid, '2')->assertOk();

    expect((string) OrderLine::query()->where('uuid', $lineUuid)->value('refunded_quantity'))->toBe('2.000');
});

it('gives the quantity back when a draft refund is abandoned', function (): void {
    // Otherwise one mistaken refund permanently reduces what the customer can still be given.
    //
    // A *draft* refund, because BAN-410 refuses to cancel one that is already settled — and that is
    // the right answer: money handed back cannot be un-handed by editing the record of it. So this
    // window is exactly the one that exists, the refund keyed in and abandoned before validation.
    [$originalUuid, $lineUuid] = capSell($this->fx, '2');
    $refundUuid = (string) Str::uuid();

    capSync($this->fx, [$this->fx->orderCommand($refundUuid, [[
        'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '-2', 'price_unit' => '10.00', 'discount' => '0', 'refunded_line_uuid' => $lineUuid,
    ]], ['is_refund' => true, 'refunded_order_uuid' => $originalUuid])])
        ->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect((string) OrderLine::query()->where('uuid', $lineUuid)->value('refunded_quantity'))->toBe('2.000');

    $cancel = $this->fx->orderCommand($refundUuid, [], ['is_refund' => true, 'refunded_order_uuid' => $originalUuid]);
    $cancel['lines'] = [];
    $cancel['op'] = 'cancel';
    capSync($this->fx, [$cancel])->assertOk()->assertJsonPath('results.0.status', 'ok');

    // …and the full quantity is refundable again.
    capRefund($this->fx, $originalUuid, $lineUuid, '2')->assertOk()->assertJsonPath('results.0.status', 'ok');
});

it('counts two refund lines against the same original within one push', function (): void {
    // Each line measured against the same starting point would let a single push refund twice over.
    [$originalUuid, $lineUuid] = capSell($this->fx, '2');

    capSync($this->fx, [$this->fx->orderCommand((string) Str::uuid(), [
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
            'qty' => '-2', 'price_unit' => '10.00', 'discount' => '0', 'refunded_line_uuid' => $lineUuid],
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
            'qty' => '-2', 'price_unit' => '10.00', 'discount' => '0', 'refunded_line_uuid' => $lineUuid],
    ], [
        'state' => OrderState::Paid->value,
        'is_refund' => true,
        'refunded_order_uuid' => $originalUuid,
    ])])
        ->assertOk()
        ->assertJsonPath('results.0.error.code', 'refund_exceeds_sold');

    expect(refundedUnits($lineUuid))->toBe('0');
});

it('holds the cap when an accepted refund is edited upward', function (): void {
    // A draft refund can be edited, so a device could have one unit accepted and then raise it to
    // ten. Measured as a replacement, not as an addition — correcting 1 to 2 is scored as 2.
    [$originalUuid, $lineUuid] = capSell($this->fx, '2');

    $refundUuid = (string) Str::uuid();
    $refundLineUuid = (string) Str::uuid();

    capSync($this->fx, [$this->fx->orderCommand($refundUuid, [[
        'op' => 'create', 'uuid' => $refundLineUuid, 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '-1', 'price_unit' => '10.00', 'discount' => '0', 'refunded_line_uuid' => $lineUuid,
    ]], ['is_refund' => true, 'refunded_order_uuid' => $originalUuid])])
        ->assertOk()->assertJsonPath('results.0.status', 'ok');

    // 2 is legal (it replaces the 1)…
    capSync($this->fx, [$this->fx->orderCommand($refundUuid, [
        ['op' => 'update', 'uuid' => $refundLineUuid, 'qty' => '-2'],
    ], ['is_refund' => true, 'refunded_order_uuid' => $originalUuid])])
        ->assertOk()->assertJsonPath('results.0.status', 'ok');

    // …and 10 is not.
    capSync($this->fx, [$this->fx->orderCommand($refundUuid, [
        ['op' => 'update', 'uuid' => $refundLineUuid, 'qty' => '-10'],
    ], ['is_refund' => true, 'refunded_order_uuid' => $originalUuid])])
        ->assertOk()->assertJsonPath('results.0.error.code', 'refund_exceeds_sold');

    expect((string) OrderLine::query()->where('uuid', $refundLineUuid)->value('quantity'))->toBe('-2.000');
});

// ---------------------------------------------------------------- the race

it('lets exactly one of two tills refund the last unit', function (): void {
    // The real race, forced. Both tills read "one remaining" and both are booked unless the read and
    // the insert are serialised on the original line. Sequential requests cannot exercise this — the
    // second read always sees the first's committed row — so a competing refund is inserted from
    // inside the create itself, which is what the losing till experiences.
    [$originalUuid, $lineUuid] = capSell($this->fx, '1');

    $original = OrderLine::query()->where('uuid', $lineUuid)->firstOrFail();
    $raced = false;

    OrderLine::creating(function (OrderLine $line) use ($original, &$raced): void {
        if ($raced || bccomp((string) $line->quantity, '0', 6) >= 0) {
            return;
        }

        $raced = true;

        // Another till gets there first with the last unit.
        OrderLine::query()->create([
            'uuid' => (string) Str::uuid(),
            'pos_order_id' => $line->pos_order_id,
            'company_id' => $line->company_id,
            'line_number' => 99,
            'product_variant_id' => $line->product_variant_id,
            'product_id' => $line->product_id,
            'uom_id' => $line->uom_id,
            'full_product_name' => 'RACE',
            'quantity' => '-1',
            'price_unit' => '10.00',
            'price_extra' => '0',
            'discount_percent' => '0',
            'tax_signature' => '',
            'refunded_order_line_id' => $original->getKey(),
        ]);
    });

    $response = capRefund($this->fx, $originalUuid, $lineUuid, '1');

    OrderLine::flushEventListeners();

    expect($raced)->toBeTrue('the race never happened, so this test proved nothing');

    // Whichever way the race fell, the customer cannot be given back more than the one unit sold.
    //
    // The row lock is what protects a real deployment, and it cannot be demonstrated here: SQLite
    // makes `lockForUpdate` a no-op, so this competitor lands *inside* the window the lock exists
    // to close. That is precisely why the invariant is also re-checked after the write — this
    // asserts the property, not the mechanism, so it holds whichever one is doing the work.
    $total = bcmul(refundedUnits($lineUuid), '-1', 3);

    expect(bccomp($total, '1.000', 3))->toBeLessThanOrEqual(0)
        ->and($response->getStatusCode())->toBe(200);
});

// ---------------------------------------------------------------- the trail

it('records a refused refund with what was asked for', function (): void {
    [$originalUuid, $lineUuid] = capSell($this->fx, '1');

    capRefund($this->fx, $originalUuid, $lineUuid, '1')->assertOk();
    AuditLog::query()->delete();

    capRefund($this->fx, $originalUuid, $lineUuid, '1')->assertOk();

    $log = AuditLog::query()->where('event', AuditEvent::RefundRefused)->firstOrFail();

    expect($log->severity->value)->toBe('critical')
        ->and($log->changes['code']['new'])->toBe('refund_exceeds_sold')
        ->and((int) $log->pos_device_id)->toBe((int) $this->fx->device->getKey());
});

it('records an accepted refund too', function (): void {
    // Money leaving the drawer is worth a row whether or not anything was wrong with it.
    [$originalUuid, $lineUuid] = capSell($this->fx, '2');

    capRefund($this->fx, $originalUuid, $lineUuid, '1')->assertOk();

    expect(AuditLog::query()->where('event', AuditEvent::RefundAccepted)->count())->toBe(1);
});

// ---------------------------------------------------------------- what must still work

it('leaves an ordinary sale alone', function (): void {
    [, $lineUuid] = capSell($this->fx, '2');

    expect((string) OrderLine::query()->where('uuid', $lineUuid)->value('refunded_quantity'))->toBe('0.000')
        ->and(AuditLog::query()->where('event', AuditEvent::RefundRefused)->count())->toBe(0);
});

it('processes a sale and its refund arriving in one batch, whatever order they are listed in', function (): void {
    // A till that sells offline and refunds before either has synced pushes both together, and the
    // outbox does not promise which lands first. Listed refund-first here on purpose: without the
    // server reordering sales ahead of refunds the refund finds nothing to link to and is refused,
    // which quarantines a real refund and loses the money until a manager digs it out.
    $saleUuid = (string) Str::uuid();
    $saleLine = (string) Str::uuid();
    $refundUuid = (string) Str::uuid();

    $sale = $this->fx->orderCommand($saleUuid, [[
        'op' => 'create', 'uuid' => $saleLine, 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
    ]], ['state' => OrderState::Paid->value], [
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '12.10'],
    ]);

    $refund = $this->fx->orderCommand($refundUuid, [[
        'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '-1', 'price_unit' => '10.00', 'discount' => '0', 'refunded_line_uuid' => $saleLine,
    ]], [
        'state' => OrderState::Paid->value,
        'is_refund' => true,
        'refunded_order_uuid' => $saleUuid,
    ]);

    $response = capSync($this->fx, [$refund, $sale]);

    $byUuid = collect($response->json('results'))->keyBy('uuid');

    expect($byUuid[$saleUuid]['status'])->toBe('ok')
        ->and($byUuid[$refundUuid]['status'])->toBe('ok')
        ->and(refundedUnits($saleLine))->toBe('-1');
});
