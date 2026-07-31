<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Computation mode of a `pricelist_items` rule.
 */
enum PricelistComputePrice: string
{
    use HasEnumHelpers;

    case Fixed = 'fixed';
    case Percentage = 'percentage';
    case Formula = 'formula';

    public function label(): string
    {
        return match ($this) {
            self::Fixed => 'Fixed price',
            self::Percentage => 'Discount %',
            self::Formula => 'Formula',
        };
    }
}
