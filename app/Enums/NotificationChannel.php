<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Transport of a notification template / log row.
 */
enum NotificationChannel: string
{
    use HasEnumHelpers;

    case Email = 'email';
    case Sms = 'sms';

    public function label(): string
    {
        return match ($this) {
            self::Email => 'E-mail',
            self::Sms => 'SMS',
        };
    }
}
