<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * How a `taxes` row computes its amount (spec §4.9).
 *
 * percent   : base × amount/100
 * fixed     : amount × quantity
 * division  : price already includes the tax — tax = price − price × (1 − amount/100)
 * group     : Σ of `tax_children`, no own amount
 */
enum TaxAmountType: string
{
    use HasEnumHelpers;

    case Percent = 'percent';
    case Fixed = 'fixed';
    case Division = 'division';
    case Group = 'group';

    public function label(): string
    {
        return match ($this) {
            self::Percent => 'Percentage of price',
            self::Fixed => 'Fixed amount per unit',
            self::Division => 'Percentage of price tax included',
            self::Group => 'Group of taxes',
        };
    }

    public function isGroup(): bool
    {
        return $this === self::Group;
    }

    /** Group taxes carry no amount of their own. */
    public function hasOwnAmount(): bool
    {
        return $this !== self::Group;
    }
}
