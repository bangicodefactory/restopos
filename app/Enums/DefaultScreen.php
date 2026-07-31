<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * `pos_configs.default_screen` — where the register lands after login.
 */
enum DefaultScreen: string
{
    use HasEnumHelpers;

    case Tables = 'tables';
    case Register = 'register';

    public function label(): string
    {
        return match ($this) {
            self::Tables => 'Floor plan',
            self::Register => 'Product screen',
        };
    }
}
