<?php

declare(strict_types=1);

namespace App\Support\Pricing\Dto;

/**
 * §10.1 — everything about the product and the moment that a pricelist rule can key on.
 *
 * `categoryAncestry` is `[own category, parent, grandparent, ...]`, nearest first: the walk
 * order is what makes a rule on the product's own category beat one on its parent (§10.3).
 */
final class PricelistContext
{
    public const PRICE_TYPE_ORIGINAL = 'original';

    public const PRICE_TYPE_MANUAL = 'manual';

    public const PRICE_TYPE_AUTOMATIC = 'automatic';

    /** @param list<int> $categoryAncestry */
    public function __construct(
        public readonly string $listPrice,
        public readonly string $quantity = '1',
        public readonly ?int $variantId = null,
        public readonly ?int $productId = null,
        public readonly ?int $categoryId = null,
        public readonly array $categoryAncestry = [],
        public readonly string $standardPrice = '0',
        public readonly string $priceExtra = '0',
        public readonly ?string $date = null,
        public readonly string $priceType = self::PRICE_TYPE_ORIGINAL,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $nullableInt = static fn (string $key): ?int => isset($data[$key]) && $data[$key] !== null
            ? (int) $data[$key]
            : null;
        /** @var list<int> $ancestry */
        $ancestry = \array_map(intval(...), \array_values((array) ($data['categoryAncestry'] ?? [])));

        return new self(
            (string) ($data['listPrice'] ?? '0'),
            (string) ($data['quantity'] ?? '1'),
            $nullableInt('variantId'),
            $nullableInt('productId'),
            $nullableInt('categoryId'),
            $ancestry,
            (string) ($data['standardPrice'] ?? '0'),
            (string) ($data['priceExtra'] ?? '0'),
            isset($data['date']) && $data['date'] !== null ? (string) $data['date'] : null,
            (string) ($data['priceType'] ?? self::PRICE_TYPE_ORIGINAL),
        );
    }

    /** §10.7 — `manual` and `automatic` lines are never repriced. */
    public function isRepriceable(): bool
    {
        return $this->priceType === self::PRICE_TYPE_ORIGINAL;
    }
}
