<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Relation of a `uoms` row to its category reference unit.
 */
enum UomType: string
{
    use HasEnumHelpers;

    case Reference = 'reference';
    case Bigger = 'bigger';
    case Smaller = 'smaller';

    public function label(): string
    {
        return match ($this) {
            self::Reference => 'Reference unit',
            self::Bigger => 'Bigger than the reference',
            self::Smaller => 'Smaller than the reference',
        };
    }
}
