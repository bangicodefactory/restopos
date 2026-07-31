<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Kind of loyalty/promotion program (spec §4.11).
 */
enum LoyaltyProgramType: string
{
    use HasEnumHelpers;

    case Coupons = 'coupons';
    case GiftCard = 'gift_card';
    case Loyalty = 'loyalty';
    case Promotion = 'promotion';
    case PromoCode = 'promo_code';
    case BuyXGetY = 'buy_x_get_y';
    case Ewallet = 'ewallet';
    case NextOrderCoupons = 'next_order_coupons';

    public function label(): string
    {
        return match ($this) {
            self::Coupons => 'Coupons',
            self::GiftCard => 'Gift card',
            self::Loyalty => 'Loyalty cards',
            self::Promotion => 'Promotional program',
            self::PromoCode => 'Discount code',
            self::BuyXGetY => 'Buy X get Y',
            self::Ewallet => 'eWallet',
            self::NextOrderCoupons => 'Next-order coupons',
        };
    }

    /** Programs that require an identified customer. */
    public function isNominative(): bool
    {
        return $this === self::Loyalty || $this === self::Ewallet;
    }

    /** Programs where 1 point == 1 currency unit and the card pays the order. */
    public function isPaymentProgram(): bool
    {
        return $this === self::GiftCard || $this === self::Ewallet;
    }
}
