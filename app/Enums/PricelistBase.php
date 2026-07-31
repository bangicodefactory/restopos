<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Base price a formula rule starts from.
 */
enum PricelistBase: string
{
    use HasEnumHelpers;

    case ListPrice = 'list_price';
    case StandardPrice = 'standard_price';
    case Pricelist = 'pricelist';

    public function label(): string
    {
        return match ($this) {
            self::ListPrice => 'Sales price',
            self::StandardPrice => 'Cost',
            self::Pricelist => 'Other pricelist',
        };
    }
}
