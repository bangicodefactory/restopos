<?php

declare(strict_types=1);

namespace App\Support\Tax;

use App\Support\Money\Decimal;

/** §7.5.2 — one (line, tax) pair before rendering. */
final class TaxComputationEntry
{
    public function __construct(
        public readonly int $taxId,
        public readonly int $taxGroupId,
        public readonly Decimal $base,
        public readonly Decimal $amount,
    ) {}

    public function withSign(Decimal $sign): self
    {
        return new self($this->taxId, $this->taxGroupId, $this->base->mul($sign), $this->amount->mul($sign));
    }
}
