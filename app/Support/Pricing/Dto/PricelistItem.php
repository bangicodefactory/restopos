<?php

declare(strict_types=1);

namespace App\Support\Pricing\Dto;

/**
 * §10.1 — one row of `pricelist_items` (docs/spec/01-schema.md §2.C).
 *
 * Every monetary field is a decimal string; `dateStart` / `dateEnd` are ISO-8601 strings
 * compared lexically (§10.2).
 */
final class PricelistItem
{
    public const APPLIED_VARIANT = 'variant';

    public const APPLIED_PRODUCT = 'product';

    public const APPLIED_CATEGORY = 'pos_category';

    public const APPLIED_GLOBAL = 'global';

    public const COMPUTE_FIXED = 'fixed';

    public const COMPUTE_PERCENTAGE = 'percentage';

    public const COMPUTE_FORMULA = 'formula';

    public const BASE_LIST_PRICE = 'list_price';

    public const BASE_STANDARD_PRICE = 'standard_price';

    public const BASE_PRICELIST = 'pricelist';

    public function __construct(
        public readonly int $id,
        public readonly string $appliedOn = self::APPLIED_GLOBAL,
        public readonly ?int $productVariantId = null,
        public readonly ?int $productId = null,
        public readonly ?int $posCategoryId = null,
        public readonly string $minQuantity = '0',
        public readonly ?string $dateStart = null,
        public readonly ?string $dateEnd = null,
        public readonly string $computePrice = self::COMPUTE_FIXED,
        public readonly string $fixedPrice = '0',
        public readonly string $percentPrice = '0',
        public readonly string $base = self::BASE_LIST_PRICE,
        public readonly ?int $basePricelistId = null,
        public readonly string $priceDiscount = '0',
        public readonly string $priceSurcharge = '0',
        public readonly string $priceRound = '0',
        public readonly string $priceMinMargin = '0',
        public readonly string $priceMaxMargin = '0',
        public readonly int $sequence = 10,
        public readonly bool $active = true,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $nullableInt = static fn (string $key): ?int => isset($data[$key]) && $data[$key] !== null
            ? (int) $data[$key]
            : null;
        $nullableString = static fn (string $key): ?string => isset($data[$key]) && $data[$key] !== null
            ? (string) $data[$key]
            : null;

        return new self(
            (int) $data['id'],
            (string) ($data['appliedOn'] ?? self::APPLIED_GLOBAL),
            $nullableInt('productVariantId'),
            $nullableInt('productId'),
            $nullableInt('posCategoryId'),
            (string) ($data['minQuantity'] ?? '0'),
            $nullableString('dateStart'),
            $nullableString('dateEnd'),
            (string) ($data['computePrice'] ?? self::COMPUTE_FIXED),
            (string) ($data['fixedPrice'] ?? '0'),
            (string) ($data['percentPrice'] ?? '0'),
            (string) ($data['base'] ?? self::BASE_LIST_PRICE),
            $nullableInt('basePricelistId'),
            (string) ($data['priceDiscount'] ?? '0'),
            (string) ($data['priceSurcharge'] ?? '0'),
            (string) ($data['priceRound'] ?? '0'),
            (string) ($data['priceMinMargin'] ?? '0'),
            (string) ($data['priceMaxMargin'] ?? '0'),
            (int) ($data['sequence'] ?? 10),
            (bool) ($data['active'] ?? true),
        );
    }
}
