<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * What a `loyalty_rewards` row gives.
 */
enum LoyaltyRewardType: string
{
    use HasEnumHelpers;

    case Discount = 'discount';
    case Product = 'product';
    case Shipping = 'shipping';

    public function label(): string
    {
        return match ($this) {
            self::Discount => 'Discount',
            self::Product => 'Free product',
            self::Shipping => 'Free shipping',
        };
    }
}
