<?php

declare(strict_types=1);

use App\Enums\OrderState;
use App\Enums\SpecialKind;
use App\Models\Audit\AuditLog;
use App\Models\Catalog\Product;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Pos\Payment;
use App\Support\Audit\AuditEvent;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-410 / REG-218 — a settled order is not writable.
 *
 * The supersession guard only fired when the *incoming* state was `draft`, so a client that sent
 * `state: "paid"` alongside its edits walked straight past it: lines could be added, quantities
 * changed and payments deleted on an order that was already closed. Session summaries are frozen at
 * close, so the receipt in the customer's hand and the ledger diverged with nothing recording that
 * they had.
 *
 * ## The shape of the rule
 *
 * Not "refuse everything a settled order sends". `buildOrderCommand` re-sends the whole graph on
 * every push, and reprinting a receipt bumps `print_count`, which commits, which enqueues — so a
 * blanket rule tells a cashier that a completed sale failed to sync. The rule is about **change**:
 * a resend that alters nothing passes through as a no-op, and only a command that would move
 * something is refused.
 *
 * And two things legitimately still move: a **tip**, which is a line whose product is
 * `special_kind = tip` and which `TicketScreen` offers on past orders, and the invoice flag.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();
});

function pushOrders(PosFixtures $fx, array $orders): TestResponse
{
    return test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'employee_id' => $fx->cashier->getKey(),
        'orders' => $orders,
    ]);
}

/** Settle an order with one line and one cash payment, exactly as a till does. */
function settleOrder(PosFixtures $fx, string $orderUuid, string $lineUuid, string $paymentUuid): void
{
    pushOrders($fx, [$fx->orderCommand($orderUuid, [[
        'op' => 'create', 'uuid' => $lineUuid, 'variant_id' => $fx->variant->getKey(),
        'qty' => '2', 'price_unit' => '10.00', 'discount' => '0',
    ]], ['state' => OrderState::Paid->value], [
        ['op' => 'create', 'uuid' => $paymentUuid, 'payment_method_id' => $fx->cash->getKey(), 'amount' => '24.20'],
    ])])->assertOk()->assertJsonPath('results.0.status', 'ok')->assertJsonPath('results.0.lines.0.status', 'ok');
}

/**
 * The same order pushed again, with whatever the caller wants to try.
 *
 * `lines` is written back over the command rather than passed in, because `orderCommand` treats an
 * empty array as "give me the default line" — so a test meaning to push only a payment would
 * silently also push a create, and pass or fail on the wrong one of the two.
 */
function repushSettled(PosFixtures $fx, string $orderUuid, array $lines = [], array $payments = []): TestResponse
{
    $command = $fx->orderCommand($orderUuid, [], ['state' => OrderState::Paid->value], $payments);
    $command['lines'] = $lines;

    return pushOrders($fx, [$command]);
}

/** A variant whose product is `special_kind = tip` — the one line that may join a settled order. */
function tipVariant(PosFixtures $fx): int
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

// ---------------------------------------------------------------- the acceptance criteria

it('refuses a line added to an order that is already paid', function (): void {
    // The ticket's first acceptance criterion. `state: "paid"` was the way past the old guard,
    // which only ever looked for an incoming `draft`.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();
    $paymentUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, $lineUuid, $paymentUuid);

    $before = (string) Order::query()->where('uuid', $orderUuid)->value('amount_total');

    $response = repushSettled($this->fx, $orderUuid, [[
        'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->drinkVariant->getKey(),
        'qty' => '1', 'price_unit' => '2.50', 'discount' => '0',
    ]]);

    $response->assertOk()->assertJsonPath('results.0.lines.0.code', 'order_settled');

    $order = Order::query()->where('uuid', $orderUuid)->firstOrFail();

    expect(OrderLine::query()->where('pos_order_id', $order->getKey())->count())->toBe(1)
        // …and the stored order is unchanged, which is the half that actually matters.
        ->and((string) $order->amount_total)->toBe($before);
});

it('refuses a payment deleted from an order that is already paid', function (): void {
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();
    $paymentUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, $lineUuid, $paymentUuid);

    $response = repushSettled($this->fx, $orderUuid, [], [['op' => 'delete', 'uuid' => $paymentUuid]]);

    $response->assertOk()
        ->assertJsonPath('results.0.payments.0.code', 'order_settled')
        // Nothing else was in this push, so nothing else can account for the rejection.
        ->assertJsonPath('results.0.lines', []);

    expect(Payment::query()->where('uuid', $paymentUuid)->exists())->toBeTrue()
        ->and((string) Order::query()->where('uuid', $orderUuid)->value('amount_paid'))->toBe('24.2000');
});

it('refuses a payment restated after the receipt printed', function (): void {
    // The fraud this exists for. €40 rung up in cash, receipt printed, then quietly restated as €30
    // and the difference pocketed. The order still balances and the session still reconciles
    // against what was declared, so nothing else in the system has any reason to notice.
    $orderUuid = (string) Str::uuid();
    $paymentUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, (string) Str::uuid(), $paymentUuid);

    repushSettled($this->fx, $orderUuid, [], [
        ['op' => 'update', 'uuid' => $paymentUuid, 'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '14.20'],
    ])->assertOk()->assertJsonPath('results.0.payments.0.code', 'order_settled');

    expect((string) Payment::query()->where('uuid', $paymentUuid)->value('amount'))->toBe('24.2000');
});

it('records the attempt with the device and what was tried', function (): void {
    // A rejection the client swallows silently is not evidence of anything. A till that keeps
    // trying to restate a payment after the receipt printed is the signal worth having.
    $orderUuid = (string) Str::uuid();
    $paymentUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, (string) Str::uuid(), $paymentUuid);
    AuditLog::query()->delete();

    repushSettled($this->fx, $orderUuid, [], [
        ['op' => 'update', 'uuid' => $paymentUuid, 'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '14.20'],
    ])->assertOk();

    $log = AuditLog::query()->where('event', AuditEvent::SettledOrderWriteRejected)->firstOrFail();

    expect((int) $log->pos_device_id)->toBe((int) $this->fx->device->getKey())
        ->and((int) $log->actor_employee_id)->toBe((int) $this->fx->cashier->getKey())
        ->and($log->severity->value)->toBe('critical')
        ->and($log->changes['amount']['new'])->toBe('14.20')
        ->and($log->changes['op']['new'])->toBe('update');
});

// ---------------------------------------------------------------- what must still work

it('lets a till resend a settled order without refusing any of it', function (): void {
    // The case that decides whether this guard is shippable. Reprinting a receipt bumps
    // `print_count`, which commits, which enqueues the *whole* order again — every line, every
    // payment. A blanket rule answers that with a batch of rejections and tells the cashier a
    // completed sale failed to sync.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();
    $paymentUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, $lineUuid, $paymentUuid);

    $response = repushSettled($this->fx, $orderUuid, [[
        'op' => 'update', 'uuid' => $lineUuid, 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '2', 'price_unit' => '10.00', 'discount' => '0',
    ]], [
        ['op' => 'update', 'uuid' => $paymentUuid, 'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '24.20'],
    ]);

    $response->assertOk()
        ->assertJsonPath('results.0.status', 'ok')
        ->assertJsonPath('results.0.lines.0.status', 'ok')
        ->assertJsonPath('results.0.payments.0.status', 'ok');

    expect(AuditLog::query()->where('event', AuditEvent::SettledOrderWriteRejected)->count())->toBe(0);
});

it('lets a tip be applied to an order that is already paid', function (): void {
    // `setTip` does not merely set a flag — it adds a *line*, and `TicketScreen` offers it on past
    // orders, which is exactly where a restaurant applies one. A guard that refuses all
    // post-settlement line writes refuses tipping, which is not a theoretical loss.
    $tipProduct = Product::query()->where('company_id', $this->fx->company->getKey())->firstOrFail()
        ->replicate(['uuid']);
    $tipProduct->uuid = (string) Str::uuid();
    $tipProduct->name = 'Pourboire';
    $tipProduct->special_kind = SpecialKind::Tip->value;
    $tipProduct->save();

    $tipVariant = $this->fx->variant->replicate(['uuid']);
    $tipVariant->uuid = (string) Str::uuid();
    $tipVariant->product_id = $tipProduct->getKey();
    $tipVariant->display_name = 'Pourboire';
    $tipVariant->save();

    $orderUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, (string) Str::uuid(), (string) Str::uuid());

    $response = repushSettled($this->fx, $orderUuid, [[
        'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $tipVariant->getKey(),
        'qty' => '1', 'price_unit' => '3.00', 'price_type' => 'manual', 'discount' => '0',
    ]]);

    $response->assertOk()->assertJsonPath('results.0.lines.0.status', 'ok');

    $order = Order::query()->where('uuid', $orderUuid)->firstOrFail();

    expect(OrderLine::query()->where('pos_order_id', $order->getKey())->count())->toBe(2);
});

it('keeps the tip flag and the invoice flag writable after payment', function (): void {
    $orderUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, (string) Str::uuid(), (string) Str::uuid());

    pushOrders($this->fx, [$this->fx->orderCommand($orderUuid, [], [
        'state' => OrderState::Paid->value,
        'is_tipped' => true,
        'tip_amount' => '3.00',
        'to_invoice' => true,
    ])])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $order = Order::query()->where('uuid', $orderUuid)->firstOrFail();

    expect((bool) $order->is_tipped)->toBeTrue()
        ->and((string) $order->tip_amount)->toBe('3.0000')
        ->and((bool) $order->to_invoice)->toBeTrue();
});

it('drops a stale field rather than costing the tip that rode in with it', function (): void {
    // A rejection here would be the wrong trade: the till is pushing a tip and happens to carry the
    // table id it still holds locally. Refusing the whole order to protect a column nobody is
    // attacking would lose the money.
    $orderUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, (string) Str::uuid(), (string) Str::uuid());

    $before = Order::query()->where('uuid', $orderUuid)->value('restaurant_table_id');

    pushOrders($this->fx, [$this->fx->orderCommand($orderUuid, [], [
        'state' => OrderState::Paid->value,
        'is_tipped' => true,
        'tip_amount' => '2.00',
        'guest_count' => 99,
        'general_customer_note' => 'rewritten after the fact',
    ])])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $order = Order::query()->where('uuid', $orderUuid)->firstOrFail();

    expect((bool) $order->is_tipped)->toBeTrue()
        ->and((int) $order->guest_count)->not->toBe(99)
        ->and($order->general_customer_note)->not->toBe('rewritten after the fact')
        ->and($order->restaurant_table_id)->toBe($before);
});

it('still lets a draft order be edited freely', function (): void {
    // The guard must not leak into the state the till spends its whole service in.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    pushOrders($this->fx, [$this->fx->orderCommand($orderUuid, [[
        'op' => 'create', 'uuid' => $lineUuid, 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
    ]])])->assertOk();

    pushOrders($this->fx, [$this->fx->orderCommand($orderUuid, [
        ['op' => 'update', 'uuid' => $lineUuid, 'qty' => '5'],
    ])])->assertOk()->assertJsonPath('results.0.lines.0.status', 'ok');

    expect((string) OrderLine::query()->where('uuid', $lineUuid)->value('quantity'))->toBe('5.000');
});

it('settles an order and its own lines in the same push', function (): void {
    // The trap this guard fell into first. `createOrder` runs before the child commands, so an
    // order paid *by this very command* already reads as settled by the time its own lines and
    // payments are applied — and the entire normal payment flow was refused. The question is only
    // ever "was it already settled when this arrived".
    $orderUuid = (string) Str::uuid();

    pushOrders($this->fx, [$this->fx->orderCommand($orderUuid, [[
        'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '2', 'price_unit' => '10.00', 'discount' => '0',
    ]], ['state' => OrderState::Paid->value], [
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '24.20'],
    ])])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok')
        ->assertJsonPath('results.0.lines.0.status', 'ok')
        ->assertJsonPath('results.0.payments.0.status', 'ok');

    expect((string) Order::query()->where('uuid', $orderUuid)->value('amount_paid'))->toBe('24.2000');
});

it('does not take a repeated delete of an already-gone line for an attack', function (): void {
    // The outbox re-sends `deletedLineUuids` until the entry retires. Once the line is gone the
    // repeat is noise, not an edit, and answering it with a rejection would strand the entry.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    pushOrders($this->fx, [$this->fx->orderCommand($orderUuid, [[
        'op' => 'create', 'uuid' => $lineUuid, 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
    ]])])->assertOk();

    pushOrders($this->fx, [$this->fx->orderCommand($orderUuid, [['op' => 'delete', 'uuid' => $lineUuid]])])->assertOk();

    settleOrder($this->fx, $orderUuid, (string) Str::uuid(), (string) Str::uuid());

    repushSettled($this->fx, $orderUuid, [['op' => 'delete', 'uuid' => $lineUuid]])
        ->assertOk()
        ->assertJsonPath('results.0.lines.0.status', 'ok');

    expect(AuditLog::query()->where('event', AuditEvent::SettledOrderWriteRejected)->count())->toBe(0);
});

it('refuses a line deleted from a settled order', function (): void {
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, $lineUuid, (string) Str::uuid());

    repushSettled($this->fx, $orderUuid, [['op' => 'delete', 'uuid' => $lineUuid]])
        ->assertOk()
        ->assertJsonPath('results.0.lines.0.code', 'order_settled');

    expect(OrderLine::query()->where('uuid', $lineUuid)->exists())->toBeTrue();
});

it('refuses a quantity changed on a settled order', function (): void {
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, $lineUuid, (string) Str::uuid());

    repushSettled($this->fx, $orderUuid, [['op' => 'update', 'uuid' => $lineUuid, 'qty' => '9']])
        ->assertOk()
        ->assertJsonPath('results.0.lines.0.code', 'order_settled');

    expect((string) OrderLine::query()->where('uuid', $lineUuid)->value('quantity'))->toBe('2.000');
});

it('refuses a new tender added after the order was settled', function (): void {
    $orderUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, (string) Str::uuid(), (string) Str::uuid());

    repushSettled($this->fx, $orderUuid, [], [
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'payment_method_id' => $this->fx->card->getKey(), 'amount' => '5.00'],
    ])->assertOk()->assertJsonPath('results.0.payments.0.code', 'order_settled');

    $order = Order::query()->where('uuid', $orderUuid)->firstOrFail();

    expect(Payment::query()->where('pos_order_id', $order->getKey())->count())->toBe(1);
});

// ---------------------------------------------------------------- the ways round the guard

it('refuses a tip that would take value off a settled order', function (): void {
    // The exemption is a hole without this, and the review found it open. A device sends a tip line
    // priced at −20.00 and knocks €20 off an order that is already paid, printed and reconciled —
    // the exact fraud the guard exists to stop, walking in through the door held open for tipping.
    $tipVariant = tipVariant($this->fx);
    $orderUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, (string) Str::uuid(), (string) Str::uuid());

    $before = (string) Order::query()->where('uuid', $orderUuid)->value('amount_total');

    repushSettled($this->fx, $orderUuid, [[
        'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $tipVariant,
        'qty' => '1', 'price_unit' => '-20.00', 'price_type' => 'manual', 'discount' => '0',
    ]])->assertOk()->assertJsonPath('results.0.lines.0.code', 'order_settled');

    expect((string) Order::query()->where('uuid', $orderUuid)->value('amount_total'))->toBe($before);
});

it('refuses a tip with a negative quantity, and one discounted past free', function (): void {
    // The same value, reached two other ways. A rule stated as "the price must be positive" and
    // checked nowhere else covers one of the three fields that decide what a line is worth.
    $tipVariant = tipVariant($this->fx);
    $orderUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, (string) Str::uuid(), (string) Str::uuid());

    $before = (string) Order::query()->where('uuid', $orderUuid)->value('amount_total');

    foreach ([
        ['qty' => '-1', 'price_unit' => '20.00', 'discount' => '0'],
        ['qty' => '1', 'price_unit' => '20.00', 'discount' => '150'],
    ] as $attempt) {
        repushSettled($this->fx, $orderUuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $tipVariant,
            'price_type' => 'manual', ...$attempt,
        ]])->assertOk()->assertJsonPath('results.0.lines.0.code', 'order_settled');
    }

    expect((string) Order::query()->where('uuid', $orderUuid)->value('amount_total'))->toBe($before);
});

it('refuses a tip edited downward into negative territory', function (): void {
    // A partial update must not dodge the check by omitting the field it is changing.
    $tipVariant = tipVariant($this->fx);
    $orderUuid = (string) Str::uuid();
    $tipUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, (string) Str::uuid(), (string) Str::uuid());

    repushSettled($this->fx, $orderUuid, [[
        'op' => 'create', 'uuid' => $tipUuid, 'variant_id' => $tipVariant,
        'qty' => '1', 'price_unit' => '5.00', 'price_type' => 'manual', 'discount' => '0',
    ]])->assertOk()->assertJsonPath('results.0.lines.0.status', 'ok');

    repushSettled($this->fx, $orderUuid, [['op' => 'update', 'uuid' => $tipUuid, 'price_unit' => '-5.00']])
        ->assertOk()
        ->assertJsonPath('results.0.lines.0.code', 'order_settled');

    expect((string) OrderLine::query()->where('uuid', $tipUuid)->value('price_unit'))->toBe('5.0000');
});

it('still lets a tip be corrected downward while it stays worth something', function (): void {
    // Reducing €5 to €3 is an ordinary correction and must survive the rule above.
    $tipVariant = tipVariant($this->fx);
    $orderUuid = (string) Str::uuid();
    $tipUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, (string) Str::uuid(), (string) Str::uuid());

    repushSettled($this->fx, $orderUuid, [[
        'op' => 'create', 'uuid' => $tipUuid, 'variant_id' => $tipVariant,
        'qty' => '1', 'price_unit' => '5.00', 'price_type' => 'manual', 'discount' => '0',
    ]])->assertOk();

    repushSettled($this->fx, $orderUuid, [['op' => 'update', 'uuid' => $tipUuid, 'price_unit' => '3.00']])
        ->assertOk()
        ->assertJsonPath('results.0.lines.0.status', 'ok');

    expect((string) OrderLine::query()->where('uuid', $tipUuid)->value('price_unit'))->toBe('3.0000');
});

it('refuses to cancel an order that is already paid', function (): void {
    // Narrowing the writable field list did nothing for `state`, which `updateOrder` sets outside
    // it — so a push claiming `cancelled` wrote straight through and took a paid order out of every
    // report while the money stayed in the drawer. Voiding a settled sale is a refund, which is a
    // new order, not a state change on this one.
    $orderUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, (string) Str::uuid(), (string) Str::uuid());

    $command = $this->fx->orderCommand($orderUuid, [], ['state' => OrderState::Cancelled->value]);
    $command['lines'] = [];

    pushOrders($this->fx, [$command])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'rejected')
        ->assertJsonPath('results.0.code', 'order_settled');

    expect(Order::query()->where('uuid', $orderUuid)->value('state')?->value)->toBe('paid');
});

it('refuses an explicit cancel op on a settled order', function (): void {
    // The same move by the other route: `op: cancel` rather than a state field.
    $orderUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, (string) Str::uuid(), (string) Str::uuid());

    $command = $this->fx->orderCommand($orderUuid, [], ['state' => OrderState::Paid->value]);
    $command['op'] = 'cancel';
    $command['lines'] = [];

    pushOrders($this->fx, [$command])
        ->assertOk()
        ->assertJsonPath('results.0.code', 'order_settled');

    expect(Order::query()->where('uuid', $orderUuid)->value('state')?->value)->toBe('paid');
});

it('still lets a paid order be posted to done', function (): void {
    // The one transition off `paid` that is real, and the rule must not cost it.
    $orderUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, (string) Str::uuid(), (string) Str::uuid());

    $command = $this->fx->orderCommand($orderUuid, [], ['state' => OrderState::Done->value]);
    $command['lines'] = [];

    pushOrders($this->fx, [$command])->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect(Order::query()->where('uuid', $orderUuid)->value('state')?->value)->toBe('done');
});

it('records a refused cancel like any other settled write', function (): void {
    $orderUuid = (string) Str::uuid();

    settleOrder($this->fx, $orderUuid, (string) Str::uuid(), (string) Str::uuid());
    AuditLog::query()->delete();

    $command = $this->fx->orderCommand($orderUuid, [], ['state' => OrderState::Cancelled->value]);
    $command['lines'] = [];

    pushOrders($this->fx, [$command])->assertOk();

    $log = AuditLog::query()->where('event', AuditEvent::SettledOrderWriteRejected)->firstOrFail();

    expect($log->changes['from']['new'])->toBe('paid')
        ->and($log->changes['to']['new'])->toBe('cancelled')
        ->and((int) $log->pos_device_id)->toBe((int) $this->fx->device->getKey());
});
