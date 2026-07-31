<?php

declare(strict_types=1);

namespace App\Support\Tax\Dto;

/** §12 — the engine's per-line output. */
final class LineResult
{
    /** @param list<LineTaxResult> $taxes */
    public function __construct(
        public readonly string $id,
        public readonly string $priceUnit,
        public readonly string $priceSubtotal,
        public readonly string $priceTotal,
        public readonly array $taxes,
    ) {}

    /** @return array{id: string, priceUnit: string, priceSubtotal: string, priceTotal: string, taxes: list<array{taxId: int, base: string, amount: string}>} */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'priceUnit' => $this->priceUnit,
            'priceSubtotal' => $this->priceSubtotal,
            'priceTotal' => $this->priceTotal,
            'taxes' => \array_map(static fn (LineTaxResult $t): array => $t->toArray(), $this->taxes),
        ];
    }
}
