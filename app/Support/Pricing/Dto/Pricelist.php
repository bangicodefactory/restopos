<?php

declare(strict_types=1);

namespace App\Support\Pricing\Dto;

/** §10.1 — a pricelist and its rules. Maps from `pricelists` + `pricelist_items`. */
final class Pricelist
{
    /** @param list<PricelistItem> $items */
    public function __construct(
        public readonly int $id,
        public readonly array $items,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        /** @var list<PricelistItem> $items */
        $items = \array_map(
            static fn (array $row): PricelistItem => PricelistItem::fromArray($row),
            \array_values((array) ($data['items'] ?? [])),
        );

        return new self((int) $data['id'], $items);
    }
}
