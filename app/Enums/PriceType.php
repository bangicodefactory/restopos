<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * How the unit price of a `pos_order_lines` row was set.
 */
enum PriceType: string
{
    use HasEnumHelpers;

    case Original = 'original';
    case Manual = 'manual';
    case Automatic = 'automatic';

    public function label(): string
    {
        return match ($this) {
            self::Original => 'Catalog price',
            self::Manual => 'Manually set',
            self::Automatic => 'Automatic (pricelist/reward)',
        };
    }
}
