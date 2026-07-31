<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * What a `notification_templates` row is used for.
 */
enum NotificationPurpose: string
{
    use HasEnumHelpers;

    case Receipt = 'receipt';
    case SelfOrderConfirmation = 'self_order_confirmation';
    case PresetConfirmation = 'preset_confirmation';
    case GiftCard = 'gift_card';
    case Loyalty = 'loyalty';
    case Invoice = 'invoice';

    public function label(): string
    {
        return match ($this) {
            self::Receipt => 'Receipt',
            self::SelfOrderConfirmation => 'Self-order confirmation',
            self::PresetConfirmation => 'Preset confirmation',
            self::GiftCard => 'Gift card',
            self::Loyalty => 'Loyalty',
            self::Invoice => 'Invoice',
        };
    }
}
