<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Kind of point movement in `loyalty_card_histories`.
 */
enum LoyaltyMovementType: string
{
    use HasEnumHelpers;

    case Earn = 'earn';
    case Spend = 'spend';
    case Adjust = 'adjust';
    case Expire = 'expire';
    case Topup = 'topup';
    case Issue = 'issue';

    public function label(): string
    {
        return match ($this) {
            self::Earn => 'Earned',
            self::Spend => 'Spent',
            self::Adjust => 'Manual adjustment',
            self::Expire => 'Expired',
            self::Topup => 'Top-up',
            self::Issue => 'Issued',
        };
    }
}
