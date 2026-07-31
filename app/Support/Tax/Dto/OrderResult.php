<?php

declare(strict_types=1);

namespace App\Support\Tax\Dto;

/** §12 — the engine's complete output for one document. */
final class OrderResult
{
    /** @param list<LineResult> $lines */
    public function __construct(
        public readonly array $lines,
        public readonly OrderTotals $totals,
    ) {}

    /** @return array{lines: list<array<string, mixed>>, totals: array<string, mixed>} */
    public function toArray(): array
    {
        return [
            'lines' => \array_map(static fn (LineResult $l): array => $l->toArray(), $this->lines),
            'totals' => $this->totals->toArray(),
        ];
    }
}
