<?php

declare(strict_types=1);

namespace App\Support\Tax\Dto;

/** §8.4 — one row of the receipt's tax-group block. */
final class TaxGroupResult
{
    public function __construct(
        public readonly int $taxGroupId,
        public readonly string $base,
        public readonly string $amount,
    ) {}

    /** @return array{taxGroupId: int, base: string, amount: string} */
    public function toArray(): array
    {
        return ['taxGroupId' => $this->taxGroupId, 'base' => $this->base, 'amount' => $this->amount];
    }
}
