<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Shape of a `restaurant_tables` row on the floor plan.
 */
enum TableShape: string
{
    use HasEnumHelpers;

    case Square = 'square';
    case Round = 'round';

    public function label(): string
    {
        return match ($this) {
            self::Square => 'Square',
            self::Round => 'Round',
        };
    }
}
