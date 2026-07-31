<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Scope a discount reward applies to.
 */
enum DiscountApplicability: string
{
    use HasEnumHelpers;

    case Order = 'order';
    case Cheapest = 'cheapest';
    case Specific = 'specific';

    public function label(): string
    {
        return match ($this) {
            self::Order => 'Whole order',
            self::Cheapest => 'Cheapest product',
            self::Specific => 'Specific products',
        };
    }
}
