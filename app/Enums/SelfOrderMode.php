<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * `pos_configs.self_ordering_mode` (spec §4.13).
 */
enum SelfOrderMode: string
{
    use HasEnumHelpers;

    case Nothing = 'nothing';
    case Consultation = 'consultation';
    case Mobile = 'mobile';
    case Kiosk = 'kiosk';

    public function label(): string
    {
        return match ($this) {
            self::Nothing => 'Disabled',
            self::Consultation => 'QR menu (browse only)',
            self::Mobile => 'QR menu and ordering',
            self::Kiosk => 'Kiosk',
        };
    }

    public function isEnabled(): bool
    {
        return $this !== self::Nothing;
    }

    public function allowsOrdering(): bool
    {
        return $this === self::Mobile || $this === self::Kiosk;
    }

    /** Kiosk and counter-service mobile always pay per order. */
    public function forcesPayEach(): bool
    {
        return $this === self::Kiosk;
    }
}
