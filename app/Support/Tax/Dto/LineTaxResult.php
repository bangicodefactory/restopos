<?php

declare(strict_types=1);

namespace App\Support\Tax\Dto;

/** §12 — one row of a line's tax breakdown. All values are rendered decimal strings. */
final class LineTaxResult
{
    public function __construct(
        public readonly int $taxId,
        public readonly string $base,
        public readonly string $amount,
    ) {}

    /** @return array{taxId: int, base: string, amount: string} */
    public function toArray(): array
    {
        return ['taxId' => $this->taxId, 'base' => $this->base, 'amount' => $this->amount];
    }
}
