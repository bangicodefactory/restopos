<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Where the currency symbol is printed relative to the amount.
 */
enum SymbolPosition: string
{
    use HasEnumHelpers;

    case Before = 'before';
    case After = 'after';

    public function label(): string
    {
        return match ($this) {
            self::Before => 'Before the amount',
            self::After => 'After the amount',
        };
    }
}
