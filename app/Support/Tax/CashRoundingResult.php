<?php

declare(strict_types=1);

namespace App\Support\Tax;

use App\Support\Money\Decimal;

/** §9.1 — the outcome of cash rounding, before a strategy is applied. */
final class CashRoundingResult
{
    public function __construct(
        public readonly Decimal $roundedTotal,
        public readonly Decimal $delta,
    ) {}
}
