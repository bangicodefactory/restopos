<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Roll-up state of a `prep_orders` card (spec §4.3).
 */
enum PrepOrderState: string
{
    use HasEnumHelpers;

    case Pending = 'pending';
    case InProgress = 'in_progress';
    case Ready = 'ready';
    case Served = 'served';
    case Cancelled = 'cancelled';

    public function label(): string
    {
        return match ($this) {
            self::Pending => 'Pending',
            self::InProgress => 'In progress',
            self::Ready => 'Ready',
            self::Served => 'Served',
            self::Cancelled => 'Cancelled',
        };
    }

    public function isActive(): bool
    {
        return $this !== self::Served && $this !== self::Cancelled;
    }
}
