<?php

declare(strict_types=1);

namespace App\Support\Tax\Dto;

/**
 * §4.3 — one order line as the engine sees it.
 *
 * `taxIds` are the taxes **before** fiscal-position mapping (§5). `sign` is a per-line override
 * of the document sign, for a returned line inside a sale.
 */
final class LineInput
{
    /** @param list<int> $taxIds */
    public function __construct(
        public readonly string $id,
        public readonly string $quantity,
        public readonly string $priceUnit,
        public readonly string $discount = '0',
        public readonly array $taxIds = [],
        public readonly string $sign = '1',
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        /** @var list<int> $taxIds */
        $taxIds = \array_map(intval(...), (array) ($data['taxIds'] ?? []));

        return new self(
            (string) $data['id'],
            (string) ($data['quantity'] ?? '0'),
            (string) ($data['priceUnit'] ?? '0'),
            (string) ($data['discount'] ?? '0'),
            $taxIds,
            (string) ($data['sign'] ?? '1'),
        );
    }
}
