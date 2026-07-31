<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * State of one `prep_order_lines` row (spec §4.3).
 */
enum PrepLineState: string
{
    use HasEnumHelpers;

    case Todo = 'todo';
    case InProgress = 'in_progress';
    case Ready = 'ready';
    case Served = 'served';
    case Cancelled = 'cancelled';

    public function label(): string
    {
        return match ($this) {
            self::Todo => 'To do',
            self::InProgress => 'Cooking',
            self::Ready => 'Ready',
            self::Served => 'Served',
            self::Cancelled => 'Cancelled',
        };
    }

    public function isDone(): bool
    {
        return $this === self::Served || $this === self::Cancelled;
    }
}
