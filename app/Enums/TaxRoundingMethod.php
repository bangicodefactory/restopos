<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * `companies.tax_calculation_rounding_method` — must match Odoo semantics exactly.
 */
enum TaxRoundingMethod: string
{
    use HasEnumHelpers;

    case RoundPerLine = 'round_per_line';
    case RoundGlobally = 'round_globally';

    public function label(): string
    {
        return match ($this) {
            self::RoundPerLine => 'Round per line',
            self::RoundGlobally => 'Round globally',
        };
    }
}
