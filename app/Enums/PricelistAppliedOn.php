<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Specificity of a `pricelist_items` rule — most specific match wins.
 */
enum PricelistAppliedOn: string
{
    use HasEnumHelpers;

    case Variant = 'variant';
    case Product = 'product';
    case PosCategory = 'pos_category';
    case Global = 'global';

    public function label(): string
    {
        return match ($this) {
            self::Variant => 'Product variant',
            self::Product => 'Product',
            self::PosCategory => 'POS category',
            self::Global => 'All products',
        };
    }

    /** Lower is more specific; drives the resolution order (variant → product → category → global). */
    public function specificity(): int
    {
        return match ($this) {
            self::Variant => 0,
            self::Product => 1,
            self::PosCategory => 2,
            self::Global => 3,
        };
    }
}
