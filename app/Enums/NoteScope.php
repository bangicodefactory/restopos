<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Where a predefined `pos_notes` chip can be applied.
 */
enum NoteScope: string
{
    use HasEnumHelpers;

    case Line = 'line';
    case Order = 'order';
    case Both = 'both';

    public function label(): string
    {
        return match ($this) {
            self::Line => 'Order line',
            self::Order => 'Whole order',
            self::Both => 'Line and order',
        };
    }

    public function appliesToLine(): bool
    {
        return $this === self::Line || $this === self::Both;
    }

    public function appliesToOrder(): bool
    {
        return $this === self::Order || $this === self::Both;
    }
}
