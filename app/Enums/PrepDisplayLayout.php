<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Board layout of a `prep_displays` screen.
 */
enum PrepDisplayLayout: string
{
    use HasEnumHelpers;

    case Columns = 'columns';
    case Grid = 'grid';
    case List = 'list';

    public function label(): string
    {
        return match ($this) {
            self::Columns => 'Columns',
            self::Grid => 'Grid',
            self::List => 'List',
        };
    }
}
