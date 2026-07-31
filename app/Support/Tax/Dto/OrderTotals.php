<?php

declare(strict_types=1);

namespace App\Support\Tax\Dto;

/**
 * §12 — order-level totals.
 *
 * `roundedTotal` and `roundingDelta` are always populated (§9.4) so the client can compute
 * `amountDue` per payment method without re-running the engine; with no cash rounding
 * configured they are `totalIncluded` and `0`.
 */
final class OrderTotals
{
    /** @param list<TaxGroupResult> $taxGroups */
    public function __construct(
        public readonly string $totalExcluded,
        public readonly string $totalTax,
        public readonly string $totalIncluded,
        public readonly string $roundedTotal,
        public readonly string $roundingDelta,
        public readonly array $taxGroups,
    ) {}

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return [
            'totalExcluded' => $this->totalExcluded,
            'totalTax' => $this->totalTax,
            'totalIncluded' => $this->totalIncluded,
            'roundedTotal' => $this->roundedTotal,
            'roundingDelta' => $this->roundingDelta,
            'taxGroups' => \array_map(static fn (TaxGroupResult $g): array => $g->toArray(), $this->taxGroups),
        ];
    }
}
