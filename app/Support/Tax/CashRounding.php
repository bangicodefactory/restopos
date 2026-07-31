<?php

declare(strict_types=1);

namespace App\Support\Tax;

use App\Support\Money\Decimal;
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
}
