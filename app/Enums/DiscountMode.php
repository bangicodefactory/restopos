<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * How a discount reward value is interpreted.
 */
enum DiscountMode: string
{
    use HasEnumHelpers;

    case Percent = 'percent';
    case PerPoint = 'per_point';
    case PerOrder = 'per_order';

    public function label(): string
    {
        return match ($this) {
            self::Percent => 'Percentage',
            self::PerPoint => 'Per point',
            self::PerOrder => 'Per order',
        };
    }
}
