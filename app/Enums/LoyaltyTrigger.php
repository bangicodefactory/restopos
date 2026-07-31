<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * How a program or rule is triggered.
 */
enum LoyaltyTrigger: string
{
    use HasEnumHelpers;

    case Auto = 'auto';
    case WithCode = 'with_code';

    public function label(): string
    {
        return match ($this) {
            self::Auto => 'Automatically',
            self::WithCode => 'With a code',
        };
    }
}
