<?php

declare(strict_types=1);

namespace App\Support\Tax;

use App\Support\Money\Decimal;
use App\Support\Money\RoundingMode;
use App\Support\Tax\Dto\CashRoundingConfig;

/**
 * §9 — cash rounding of the order total.
 *
 * `up` / `down` are away-from / toward **zero**, so a refund total of -12.32 rounded `up` at a
 * 0.05 step becomes -12.35, mirroring the sale.
 */
final class CashRounding
{
    public function __construct(private readonly CashRoundingConfig $config) {}

    /** §9.1 — returns [roundedTotal, delta]. */
    public function apply(Decimal $totalIncluded): CashRoundingResult
    {
        $rounded = $totalIncluded->roundToStep(
            Decimal::of($this->config->rounding),
            $this->config->method,
        );

        return new CashRoundingResult($rounded, $rounded->sub($totalIncluded));
    }

    public function strategy(): string
    {
        return $this->config->strategy;
    }

    public function isBiggestTax(): bool
    {
        return $this->config->strategy === CashRoundingConfig::BIGGEST_TAX;
    }

    /**
     * §9.4 — the tolerance that makes a cash-rounded order settleable (REG-176).
     *
     * The mirror of `fullyPaidTolerance` in `packages/domain/src/tax/rounder.ts`, and it must stay
     * the mirror: the register decides an order is settled with this rule, and the server decides
     * how much of the shortfall to write off with the same one. If they disagree, an order the
     * cashier closed comes back carrying a balance.
     *
     * Cash rounding exists because the drawer has no coin smaller than the step, so the tender can
     * legitimately fall short — by half a step under a nearest-step method, by a full step under a
     * directional one. With no rounding configured the tolerance is zero and the strict test stands.
     */
    public static function fullyPaidTolerance(?string $rounding, RoundingMode $method = RoundingMode::HalfUp): Decimal
    {
        if ($rounding === null) {
            return Decimal::of('0');
        }

        $step = Decimal::of($rounding)->abs();

        if ($step->isZero()) {
            return Decimal::of('0');
        }

        return $method === RoundingMode::HalfUp ? $step->div(Decimal::of('2'), $step->scale + 1) : $step;
    }

    /**
     * §9.4 — whether a remaining due closes the order (REG-176).
     *
     * `$due` is what is left *to collect*: positive is short, negative means the customer overpaid
     * and is owed change, which always settles. So the test is one-sided — the tolerance only
     * widens the band upward.
     */
    public static function isFullyPaid(
        Decimal $due,
        ?string $rounding,
        RoundingMode $method = RoundingMode::HalfUp,
    ): bool {
        return $due->lte(self::fullyPaidTolerance($rounding, $method));
    }
}
