<?php

declare(strict_types=1);

use App\Enums\OrderState;
use App\Models\Pos\Order;
use App\Models\Pricing\CashRounding;
use App\Support\Money\Decimal;
use App\Support\Money\RoundingMode;
use App\Support\Tax\CashRounding as CashRoundingCalculator;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * REG-176 — the server half of the cash-rounding fully-paid tolerance.
 *
 * The register settles a cash-rounded order once the shortfall is inside the tolerance. If the
 * server did not write that shortfall off, every such order would come back carrying a residual
 * `amount_due` and the session would look permanently short. These pin the two halves together.
 *
 * The default fixture order is 2 × 10.00 + 21 % = 24.20, already on the 0.05 grid.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();

    $rounding = CashRounding::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Nickel',
        'rounding' => '0.05',
        'rounding_method' => 'half_up',
    ]);

    $this->fx->config->forceFill([
        'use_cash_rounding' => true,
        'cash_rounding_id' => $rounding->getKey(),
    ])->save();
});

function settleWith(PosFixtures $fx, int $methodId, string $amount): Order
{
    $uuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [], ['state' => OrderState::Paid->value], [[
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'payment_method_id' => $methodId,
            'amount' => $amount,
        ]])],
    ])->assertOk()->assertJsonPath('results.0.status', 'ok');

    return Order::query()->where('uuid', $uuid)->firstOrFail();
}

it('writes off a cash shortfall inside the tolerance so nothing is left owing', function (): void {
    $order = settleWith($this->fx, $this->fx->cash->getKey(), '24.18');

    // 0.02 short of 24.20, inside the ±0.025 HALF-UP band the register settles on.
    expect((float) $order->amount_due)->toBe(0.0)
        ->and((float) $order->amount_total)->toBe(24.20)
        // The forgiven 0.02 lands in the rounding write-off rather than vanishing, so
        // amount_rounding stays the single answer to what rounding cost us on this order.
        ->and((float) $order->amount_rounding)->toBe(-0.02);
});

it('leaves a card shortfall owing — a terminal can be charged the exact amount', function (): void {
    $order = settleWith($this->fx, $this->fx->card->getKey(), '24.18');

    expect((float) $order->amount_due)->toBe(0.02)
        ->and((float) $order->amount_rounding)->toBe(0.0);
});

it('refuses to write off more than the rounding could explain', function (): void {
    // 0.05 short is twice the HALF-UP tolerance; the register would not settle it either.
    $order = settleWith($this->fx, $this->fx->cash->getKey(), '24.15');

    expect((float) $order->amount_due)->toBe(0.05)
        ->and((float) $order->amount_rounding)->toBe(0.0);
});

it('does not touch an exactly-paid order', function (): void {
    $order = settleWith($this->fx, $this->fx->cash->getKey(), '24.20');

    expect((float) $order->amount_due)->toBe(0.0)
        ->and((float) $order->amount_rounding)->toBe(0.0);
});

it('leaves an overpaid order to the change reconciler (BAN-440)', function (): void {
    $order = settleWith($this->fx, $this->fx->cash->getKey(), '30.00');

    expect((float) $order->amount_due)->toBe(0.0)
        ->and((float) $order->amount_change)->toBe(5.80)
        // Overpayment is change, not a rounding write-off.
        ->and((float) $order->amount_rounding)->toBe(0.0);
});

it('grants nothing when the config has cash rounding switched off', function (): void {
    $this->fx->config->forceFill(['use_cash_rounding' => false])->save();

    $order = settleWith($this->fx, $this->fx->cash->getKey(), '24.18');

    expect((float) $order->amount_due)->toBe(0.02);
});

it('is idempotent across a resync', function (): void {
    $uuid = (string) Str::uuid();
    $command = $this->fx->orderCommand($uuid, [], ['state' => OrderState::Paid->value], [[
        'op' => 'create',
        'uuid' => (string) Str::uuid(),
        'payment_method_id' => $this->fx->cash->getKey(),
        'amount' => '24.18',
    ]]);

    foreach ([1, 2] as $_) {
        test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', ['orders' => [$command]])->assertOk();
    }

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    // The write-off is re-derived from primary facts, so replaying must not double it.
    expect((float) $order->amount_due)->toBe(0.0)
        ->and((float) $order->amount_rounding)->toBe(-0.02);
});

/**
 * The tolerance itself must stay the mirror of `fullyPaidTolerance` in
 * `packages/domain/src/tax/rounder.ts` — same inputs, same answers, or the register and the server
 * disagree about whether an order is settled.
 */
it('matches the TypeScript tolerance table', function (string $step, RoundingMode $mode, string $expected): void {
    expect(CashRoundingCalculator::fullyPaidTolerance($step, $mode)->toString())->toBe($expected);
})->with([
    ['0.05', RoundingMode::HalfUp, '0.025'],
    ['0.01', RoundingMode::HalfUp, '0.005'],
    ['0.5', RoundingMode::HalfUp, '0.25'],
    ['0.05', RoundingMode::Up, '0.05'],
    ['0.05', RoundingMode::Down, '0.05'],
    ['0.05', RoundingMode::HalfDown, '0.05'],
    ['0.05', RoundingMode::HalfEven, '0.05'],
]);

it('is a strict sign test with no rounding configured', function (): void {
    expect(CashRoundingCalculator::fullyPaidTolerance(null)->isZero())->toBeTrue()
        ->and(CashRoundingCalculator::isFullyPaid(Decimal::of('0.01'), null))->toBeFalse()
        ->and(CashRoundingCalculator::isFullyPaid(Decimal::of('0'), null))->toBeTrue()
        ->and(CashRoundingCalculator::isFullyPaid(Decimal::of('-5.00'), null))->toBeTrue();
});

it('accepts both signs of the tolerance boundary', function (): void {
    expect(CashRoundingCalculator::isFullyPaid(Decimal::of('0.025'), '0.05'))->toBeTrue()
        ->and(CashRoundingCalculator::isFullyPaid(Decimal::of('0.026'), '0.05'))->toBeFalse()
        ->and(CashRoundingCalculator::isFullyPaid(Decimal::of('-0.025'), '0.05'))->toBeTrue()
        ->and(CashRoundingCalculator::isFullyPaid(Decimal::of('-5.00'), '0.05'))->toBeTrue();
});
