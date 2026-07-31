<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Per-tax rounding override; `inherit` falls back to the company setting.
 */
enum TaxRoundingStrategy: string
{
    use HasEnumHelpers;

    case Inherit = 'inherit';
    case RoundPerLine = 'round_per_line';
    case RoundGlobally = 'round_globally';

    public function label(): string
    {
        return match ($this) {
            self::Inherit => 'Company default',
            self::RoundPerLine => 'Round per line',
            self::RoundGlobally => 'Round globally',
        };
    }
}
