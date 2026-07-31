<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Where a preset is served (spec §4.12).
 */
enum PresetServiceAt: string
{
    use HasEnumHelpers;

    case Counter = 'counter';
    case Table = 'table';
    case Delivery = 'delivery';

    public function label(): string
    {
        return match ($this) {
            self::Counter => 'At the counter',
            self::Table => 'At the table',
            self::Delivery => 'Delivery',
        };
    }
}
