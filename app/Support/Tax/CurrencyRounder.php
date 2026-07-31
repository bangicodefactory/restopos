<?php

declare(strict_types=1);

namespace App\Support\Tax;

use App\Support\Money\Decimal;
use App\Support\Money\RoundingMode;
use App\Support\Tax\Dto\Currency;

/**
 * §3.3 — currency rounding.
 *
 * A currency rounds to a *step* (0.01 / 0.05 / 0.001), not to a number of decimal places; the
 * decimal places only drive rendering (§3.3.4).
 */
final class CurrencyRounder
{
    private readonly Decimal $step;

    public function __construct(public readonly Currency $currency)
    {
        $this->step = Decimal::of($currency->rounding);
    }

    /** §3.3.3 */
    public function round(Decimal $value): Decimal
    {
        return $value->roundToStep($this->step, $this->currency->roundingMode);
    }

    /** §3.3.4 — render a money value at the currency's decimal places. */
    public function format(Decimal $value): string
    {
        return $value->withScale($this->currency->decimalPlaces, RoundingMode::HalfUp)->toString();
    }
}
