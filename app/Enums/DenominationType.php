<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Coin or bill for a `pos_bills` denomination row.
 */
enum DenominationType: string
{
    use HasEnumHelpers;

    case Bill = 'bill';
    case Coin = 'coin';

    public function label(): string
    {
        return match ($this) {
            self::Bill => 'Bill',
            self::Coin => 'Coin',
        };
    }
}
