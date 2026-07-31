<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Whether a rule threshold is compared tax-included or tax-excluded.
 */
enum AmountTaxMode: string
{
    use HasEnumHelpers;

    case Incl = 'incl';
    case Excl = 'excl';

    public function label(): string
    {
        return match ($this) {
            self::Incl => 'Tax included',
            self::Excl => 'Tax excluded',
        };
    }
}
