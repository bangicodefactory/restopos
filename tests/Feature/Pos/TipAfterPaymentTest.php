<?php

declare(strict_types=1);

namespace Tests\Feature\Pos\TipAfterPayment;

use App\Enums\SpecialKind;
use App\Models\Catalog\Product;
use App\Models\Pos\Order;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make(['enable_tips' => true, 'tip_after_payment' => true])->withSession();
});

/** @param array<int, array<string, mixed>> $commands */
function push(array $commands): TestResponse
{
    return test()->withHeaders(test()->fx->headers())->postJson('/api/pos/sync', ['orders' => $commands]);
}

/** A variant whose product is `special_kind = tip` — the one line that may join a settled order. */
function tipVariantId(PosFixtures $fx): int
{
    $product = Product::query()->where('company_id', $fx->company->getKey())->firstOrFail()->replicate(['uuid']);
    $product->uuid = (string) Str::uuid();
    $product->name = 'Pourboire';
    $product->special_kind = SpecialKind::Tip->value;
    $product->save();

    $variant = $fx->variant->replicate(['uuid']);
    $variant->uuid = (string) Str::uuid();
    $variant->product_id = $product->getKey();
    $variant->display_name = 'Pourboire';
    $variant->save();

    return (int) $variant->getKey();
}

/** A settled card sale: one 10.00 line + 21 % tax, paid 12.10 on card. */
function settledCardSale(PosFixtures $fx, string $orderUuid, string $paymentUuid): void
{
    push([$fx->orderCommand($orderUuid, [[
        'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
        'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
    ]], ['state' => 'paid'], [[
        'op' => 'create', 'uuid' => $paymentUuid,
        'payment_method_id' => $fx->card->getKey(),
        'amount' => '12.10', 'is_change' => false, 'is_refund' => false, 'payment_status' => 'done',
    ]])])->assertOk()->assertJsonPath('results.0.status', 'ok');
}

/** The tip push: the tip line, the two order columns, and the card raised to what was charged. */
function tipPush(PosFixtures $fx, string $orderUuid, string $paymentUuid, string $tip, string $amount): TestResponse
{
    return push([$fx->orderCommand($orderUuid, [[
        'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => tipVariantId($fx),
        'qty' => '1', 'price_unit' => $tip, 'price_type' => 'manual', 'discount' => '0',
    ]], ['state' => 'paid', 'is_tipped' => true, 'tip_amount' => $tip], [[
        'op' => 'update', 'uuid' => $paymentUuid, 'amount' => $amount,
        'payment_method_id' => $fx->card->getKey(), 'payment_status' => 'done',
    ]])]);
}

function amountOf(string $paymentUuid): float
{
    return (float) DB::table('pos_payments')->where('uuid', $paymentUuid)->value('amount');
}

/**
 * RST-125 (BAN-494) — the payment half of a tip.
 *
 * `settledLineVerdict` has always let a tip **line** join a paid order, because that is what a tip
 * is. Nothing let the **payment** follow it, so the money landed as revenue with nothing behind it.
 * A probe on a settled card sale:
 *
 *     total 14.10   paid 12.10   due 2.00
 *
 * A closed sale reading as underpaid, for a card the customer really was charged 14.10 on. Every tip
 * taken left the session's declared takings short of the money in the account, and the order looked
 * like a debt somebody would eventually try to collect.
 *
 * The door opened here is the narrowest that closes it: an **increase**, on the **amount alone**, no
 * larger than the tip the order itself declares, on a register that tips after payment.
 */
it('lets the card payment rise by the tip, so the order balances', function (): void {
    $orderUuid = (string) Str::uuid();
    $paymentUuid = (string) Str::uuid();

    settledCardSale($this->fx, $orderUuid, $paymentUuid);
    tipPush($this->fx, $orderUuid, $paymentUuid, '2.00', '14.10')
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    $order = Order::query()->where('uuid', $orderUuid)->firstOrFail();

    expect((float) $order->amount_total)->toBe(14.10)
        ->and((float) $order->amount_paid)->toBe(14.10)
        // The whole point: no residual debt on a closed sale.
        ->and((float) $order->amount_due)->toBe(0.0)
        // And not forgiven either — the settled-order write-off exists to absorb a repricing delta,
        // and a tip absorbed by it would be money quietly given away.
        ->and((float) $order->amount_write_off)->toBe(0.0)
        ->and(amountOf($paymentUuid))->toBe(14.10);
});

it('still refuses a payment cut after the receipt printed', function (): void {
    // The skim BAN-410 exists to stop: ring up 12.10, print, then restate it as 9.00 and pocket the
    // difference. Opening this door upwards must not open it downwards.
    $orderUuid = (string) Str::uuid();
    $paymentUuid = (string) Str::uuid();

    settledCardSale($this->fx, $orderUuid, $paymentUuid);

    push([$this->fx->orderCommand($orderUuid, [], ['state' => 'paid', 'is_tipped' => true, 'tip_amount' => '2.00'], [[
        'op' => 'update', 'uuid' => $paymentUuid, 'amount' => '9.00',
        'payment_method_id' => $this->fx->card->getKey(), 'payment_status' => 'done',
    ]])])->assertOk();

    expect(amountOf($paymentUuid))->toBe(12.10);
});

it('refuses a rise larger than the tip the order declares', function (): void {
    // Without this bound the exemption is a blank cheque: declare a 2.00 tip and charge the card
    // 500. Tied to the declared tip, the payment can only ever follow money the order admits to.
    $orderUuid = (string) Str::uuid();
    $paymentUuid = (string) Str::uuid();

    settledCardSale($this->fx, $orderUuid, $paymentUuid);
    tipPush($this->fx, $orderUuid, $paymentUuid, '2.00', '512.10')->assertOk();

    expect(amountOf($paymentUuid))->toBe(12.10);
});

it('refuses a rise on an order that declares no tip at all', function (): void {
    $orderUuid = (string) Str::uuid();
    $paymentUuid = (string) Str::uuid();

    settledCardSale($this->fx, $orderUuid, $paymentUuid);

    push([$this->fx->orderCommand($orderUuid, [], ['state' => 'paid'], [[
        'op' => 'update', 'uuid' => $paymentUuid, 'amount' => '14.10',
        'payment_method_id' => $this->fx->card->getKey(), 'payment_status' => 'done',
    ]])])->assertOk();

    expect(amountOf($paymentUuid))->toBe(12.10);
});

it('refuses moving a settled tender to another method, tip or no tip', function (): void {
    // Restating a card sale as cash empties the drawer on paper while the money sits with the
    // acquirer. The door is the amount and nothing else.
    $orderUuid = (string) Str::uuid();
    $paymentUuid = (string) Str::uuid();

    settledCardSale($this->fx, $orderUuid, $paymentUuid);

    push([$this->fx->orderCommand($orderUuid, [], ['state' => 'paid', 'is_tipped' => true, 'tip_amount' => '2.00'], [[
        'op' => 'update', 'uuid' => $paymentUuid, 'amount' => '14.10',
        'payment_method_id' => $this->fx->cash->getKey(), 'payment_status' => 'done',
    ]])])->assertOk();

    $row = DB::table('pos_payments')->where('uuid', $paymentUuid)->first();

    expect((int) $row->payment_method_id)->toBe($this->fx->card->getKey())
        ->and((float) $row->amount)->toBe(12.10);
});

it('refuses the top-up on a register that does not tip after payment', function (): void {
    // The same two flags the line side reads. A counter that tips into a jar has no business
    // restating a settled card payment.
    $fx = PosFixtures::make(['enable_tips' => true, 'tip_after_payment' => false])->withSession();
    $orderUuid = (string) Str::uuid();
    $paymentUuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', ['orders' => [
        $fx->orderCommand($orderUuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        ]], ['state' => 'paid'], [[
            'op' => 'create', 'uuid' => $paymentUuid, 'payment_method_id' => $fx->card->getKey(),
            'amount' => '12.10', 'is_change' => false, 'is_refund' => false, 'payment_status' => 'done',
        ]]),
    ]])->assertOk();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', ['orders' => [
        $fx->orderCommand($orderUuid, [], ['state' => 'paid', 'is_tipped' => true, 'tip_amount' => '2.00'], [[
            'op' => 'update', 'uuid' => $paymentUuid, 'amount' => '14.10',
            'payment_method_id' => $fx->card->getKey(), 'payment_status' => 'done',
        ]]),
    ]])->assertOk();

    expect(amountOf($paymentUuid))->toBe(12.10);
});

it('puts a refused top-up on the record', function (): void {
    // A refusal that leaves no trace is indistinguishable from a push that never happened — which is
    // exactly what an attempt to restate a settled tender must not get.
    $orderUuid = (string) Str::uuid();
    $paymentUuid = (string) Str::uuid();

    settledCardSale($this->fx, $orderUuid, $paymentUuid);

    $before = DB::table('audit_logs')->count();

    push([$this->fx->orderCommand($orderUuid, [], ['state' => 'paid'], [[
        'op' => 'update', 'uuid' => $paymentUuid, 'amount' => '99.00',
        'payment_method_id' => $this->fx->card->getKey(), 'payment_status' => 'done',
    ]])])->assertOk();

    expect(DB::table('audit_logs')->count())->toBeGreaterThan($before);
});

it('is idempotent on a resend, which the outbox produces routinely', function (): void {
    // The register re-pushes a settled order's whole graph on every reprint. A second identical tip
    // push must not stack another 2.00 onto the card.
    $orderUuid = (string) Str::uuid();
    $paymentUuid = (string) Str::uuid();

    settledCardSale($this->fx, $orderUuid, $paymentUuid);
    tipPush($this->fx, $orderUuid, $paymentUuid, '2.00', '14.10')->assertOk();

    push([$this->fx->orderCommand($orderUuid, [], ['state' => 'paid', 'is_tipped' => true, 'tip_amount' => '2.00'], [[
        'op' => 'update', 'uuid' => $paymentUuid, 'amount' => '14.10',
        'payment_method_id' => $this->fx->card->getKey(), 'payment_status' => 'done',
    ]])])->assertOk();

    expect(amountOf($paymentUuid))->toBe(14.10)
        ->and((float) Order::query()->where('uuid', $orderUuid)->firstOrFail()->amount_due)->toBe(0.0);
});
