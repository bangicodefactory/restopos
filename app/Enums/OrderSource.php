<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Where a `pos_orders` row was created (spec §4.7).
 */
enum OrderSource: string
{
    use HasEnumHelpers;

    case Pos = 'pos';
    case Mobile = 'mobile';
    case Kiosk = 'kiosk';
    case Backoffice = 'backoffice';
    case Api = 'api';

    public function label(): string
    {
        return match ($this) {
            self::Pos => 'Register',
            self::Mobile => 'QR self-order',
            self::Kiosk => 'Kiosk',
            self::Backoffice => 'Back office',
            self::Api => 'API',
        };
    }

    public function isSelfOrder(): bool
    {
        return $this === self::Mobile || $this === self::Kiosk;
    }

    /** Prefix used in front of the customer-facing tracking number. */
    public function trackingPrefix(): string
    {
        return match ($this) {
            self::Kiosk => 'K',
            self::Mobile => 'S',
            default => '',
        };
    }
}
