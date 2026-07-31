<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Technical products always pushed to the client but never browsable.
 */
enum SpecialKind: string
{
    use HasEnumHelpers;

    case None = 'none';
    case Tip = 'tip';
    case GlobalDiscount = 'global_discount';
    case LoyaltyReward = 'loyalty_reward';
    case Deposit = 'deposit';

    public function label(): string
    {
        return match ($this) {
            self::None => 'Regular product',
            self::Tip => 'Tip',
            self::GlobalDiscount => 'Global discount',
            self::LoyaltyReward => 'Loyalty reward',
            self::Deposit => 'Deposit',
        };
    }

    public function isSpecial(): bool
    {
        return $this !== self::None;
    }

    /** Special lines are never routed to the kitchen. */
    public function skipsPreparation(): bool
    {
        return $this !== self::None;
    }
}
