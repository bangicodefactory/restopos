<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Kind of physical device registered against a config.
 */
enum DeviceType: string
{
    use HasEnumHelpers;

    case Register = 'register';
    case Kiosk = 'kiosk';
    case CustomerDisplay = 'customer_display';
    case SelfMobile = 'self_mobile';
    case PrepDisplay = 'prep_display';

    public function label(): string
    {
        return match ($this) {
            self::Register => 'Register',
            self::Kiosk => 'Kiosk',
            self::CustomerDisplay => 'Customer display',
            self::SelfMobile => 'Customer phone',
            self::PrepDisplay => 'Preparation display',
        };
    }
}
