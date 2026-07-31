<?php

declare(strict_types=1);

namespace App\Support\Tax;

use App\Support\Money\Decimal;

/**
 * §7 — the intermediate (unrendered) result of computing one line.
 *
 * Values are signed and, under `round_globally`, still unrounded: the order aggregation (§8.3)
 * needs the raw magnitudes so that rounding can happen exactly once. This value object is the
 * boundary between §7 and §8 and never escapes the engine.
 */
final class TaxComputation
{
    /** @param list<TaxComputationEntry> $entries */
    public function __construct(
        public readonly string $id,
        public readonly Decimal $priceUnit,
        public readonly Decimal $rawExcluded,
        public readonly Decimal $rawIncluded,
        public readonly array $entries,
    ) {}
}
