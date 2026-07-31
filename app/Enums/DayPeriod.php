<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Display grouping of a `preset_service_windows` row.
 */
enum DayPeriod: string
{
    use HasEnumHelpers;

    case Morning = 'morning';
    case Afternoon = 'afternoon';
    case Evening = 'evening';

    public function label(): string
    {
        return match ($this) {
            self::Morning => 'Morning',
            self::Afternoon => 'Afternoon',
            self::Evening => 'Evening',
        };
    }
}
