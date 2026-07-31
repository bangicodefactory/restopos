<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Lifecycle of a staged `pos_order_loyalty_points` claim.
 */
enum LoyaltyPointState: string
{
    use HasEnumHelpers;

    case Pending = 'pending';
    case Confirmed = 'confirmed';
    case Rejected = 'rejected';
    case Reverted = 'reverted';

    public function label(): string
    {
        return match ($this) {
            self::Pending => 'Pending',
            self::Confirmed => 'Confirmed',
            self::Rejected => 'Rejected',
            self::Reverted => 'Reverted',
        };
    }
}
