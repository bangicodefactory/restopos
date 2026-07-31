<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * How many points a `loyalty_rules` row grants.
 */
enum RewardPointMode: string
{
    use HasEnumHelpers;

    case Order = 'order';
    case Money = 'money';
    case Unit = 'unit';

    public function label(): string
    {
        return match ($this) {
            self::Order => 'Per order',
            self::Money => 'Per currency unit spent',
            self::Unit => 'Per product unit',
        };
    }
}
