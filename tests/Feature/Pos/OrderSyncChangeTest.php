<?php

declare(strict_types=1);

use App\Enums\OrderState;
use App\Models\Pos\Order;
use App\Models\Pos\Payment;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();
});

/** Ring up the default order (2 × 10.00 + 21% tax = 24.20) paid with the given cash/card tender. */
function ringUpWith(PosFixtures $fx, array $payments): array
{
    $uuid = (string) Str::uuid();

    $response = test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [], ['state' => OrderState::Paid->value], $payments)],
    ]);

    return [$uuid, $response];
}

it('records overpaid cash as a negative change row and clears the due (REG-204)', function (): void {
    [$uuid, $response] = ringUpWith($this->fx, [[
        'op' => 'create',
        'uuid' => (string) Str::uuid(),
        'payment_method_id' => $this->fx->cash->getKey(),
        'amount' => '30.00',
    ]]);

    $response->assertOk()->assertJsonPath('results.0.status', 'ok');

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();
    $total = (float) $order->amount_total;           // server-computed (24.20)
    $expectedChange = round(30.0 - $total, 2);       // 5.80

    // A single negative is_change row on the cash method.
    $change = Payment::query()->where('pos_order_id', $order->getKey())->where('is_change', true)->get();
    expect($change)->toHaveCount(1)
        ->and((float) $change[0]->amount)->toBe(-$expectedChange)
        ->and((int) $change[0]->payment_method_id)->toBe($this->fx->cash->getKey());

    // The order's money fields reflect it: change recorded, nothing owed, not negative.
    expect((float) $order->amount_change)->toBe($expectedChange)
        ->and((float) $order->amount_due)->toBe(0.0);

    // Two rows total: the +30 tender and the −change.
    expect(Payment::query()->where('pos_order_id', $order->getKey())->count())->toBe(2);
});

it('re-derives the change on resync rather than stacking rows', function (): void {
    [$uuid] = ringUpWith($this->fx, [[
        'op' => 'create', 'uuid' => (string) Str::uuid(),
        'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '30.00',
    ]]);

    // Resend the same order — recompute must keep exactly one change row.
    ringUpWith($this->fx, [[
        'op' => 'create', 'uuid' => (string) Str::uuid(),
        'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '30.00',
    ]]);

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();
    expect(Payment::query()->where('pos_order_id', $order->getKey())->where('is_change', true)->count())->toBe(1);
});

it('rejects a client payment that asserts is_change with a positive amount', function (): void {
    [$uuid, $response] = ringUpWith($this->fx, [
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '30.00'],
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '5.80', 'is_change' => true],
    ]);

    $response->assertOk();

    // The bogus positive change payment is rejected, not booked…
    $payments = collect($response->json('results.0.payments'));
    expect($payments->firstWhere('status', 'rejected'))->not->toBeNull()
        ->and($payments->firstWhere('status', 'rejected')['code'])->toBe('change_wrong_sign');

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();
    // …and no positive is_change row exists; the server's own negative one is there instead.
    expect(Payment::query()->where('pos_order_id', $order->getKey())->where('is_change', true)->where('amount', '>', 0)->exists())->toBeFalse()
        ->and((float) $order->amount_due)->toBe(0.0);
});

it('never books change on a refund order (negative total is not an overpayment)', function (): void {
    // A refund has a negative total and no tender; changeDue reads positive there, so without the
    // tender guard it would book phantom change — and reject the refund when no cash method exists.
    $uuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [[
            'uuid' => $uuid,
            'op' => 'upsert',
            'order' => [
                'session_id' => $this->fx->session->getKey(),
                'state' => OrderState::Draft->value,
                'is_refund' => true,
                'access_token' => (string) Str::uuid(),
            ],
            'lines' => [[
                'op' => 'create', 'uuid' => (string) Str::uuid(),
                'variant_id' => $this->fx->variant->getKey(), 'qty' => '-1', 'price_unit' => '10.00', 'discount' => '0',
            ]],
            'payments' => [],
        ]],
    ])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((float) $order->amount_total)->toBeLessThan(0.0)
        ->and(Payment::query()->where('pos_order_id', $order->getKey())->where('is_change', true)->count())->toBe(0)
        ->and((float) $order->amount_change)->toBe(0.0);
});

it('rejects an overpayment when the config has no cash method (REG-204)', function (): void {
    // Leave only the (non-cash) card method on the config.
    $this->fx->config->paymentMethods()->detach($this->fx->cash->getKey());

    [$uuid, $response] = ringUpWith($this->fx, [[
        'op' => 'create', 'uuid' => (string) Str::uuid(),
        'payment_method_id' => $this->fx->card->getKey(), 'amount' => '30.00',
    ]]);

    $response->assertOk()
        ->assertJsonPath('results.0.status', 'rejected')
        ->assertJsonPath('results.0.error.code', 'change_without_cash');

    // The whole order rolled back — nothing half-booked.
    expect(Order::query()->where('uuid', $uuid)->exists())->toBeFalse();
});
