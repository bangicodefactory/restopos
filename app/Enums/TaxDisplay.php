<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * `pos_configs.tax_display` — price shown tax-excluded or tax-included.
 */
enum TaxDisplay: string
{
    use HasEnumHelpers;

    case Subtotal = 'subtotal';
    case Total = 'total';

    public function label(): string
    {
        return match ($this) {
            self::Subtotal => 'Tax-excluded',
            self::Total => 'Tax-included',
        };
    }
}
