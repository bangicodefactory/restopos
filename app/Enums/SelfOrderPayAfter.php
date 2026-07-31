<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * `pos_configs.self_ordering_pay_after` (spec §4.13).
 */
enum SelfOrderPayAfter: string
{
    use HasEnumHelpers;

    case Each = 'each';
    case Meal = 'meal';

    public function label(): string
    {
        return match ($this) {
            self::Each => 'Each order',
            self::Meal => 'The whole meal',
        };
    }
}
