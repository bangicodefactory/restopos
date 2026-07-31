<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Scope a tax amount applies to when reported on a receipt or summary.
 */
enum TaxScope: string
{
    use HasEnumHelpers;

    case Line = 'line';
    case Order = 'order';

    public function label(): string
    {
        return match ($this) {
            self::Line => 'Per line',
            self::Order => 'Whole order',
        };
    }
}
