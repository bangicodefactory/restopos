<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Lifecycle of a `pos_orders` row (spec §4.1).
 *
 * draft → paid → done, or draft → cancelled. Terminal states never return to draft.
 */
enum OrderState: string
{
    use HasEnumHelpers;

    case Draft = 'draft';
    case Paid = 'paid';
    case Done = 'done';
    case Cancelled = 'cancelled';

    public function label(): string
    {
        return match ($this) {
            self::Draft => 'Draft',
            self::Paid => 'Paid',
            self::Done => 'Posted',
            self::Cancelled => 'Cancelled',
        };
    }

    /** Terminal states can never go back to draft. */
    public function isTerminal(): bool
    {
        return $this === self::Done || $this === self::Cancelled;
    }

    public function isSettled(): bool
    {
        return $this === self::Paid || $this === self::Done;
    }

    public function isOpen(): bool
    {
        return $this === self::Draft;
    }

    /** Only draft/cancelled orders may be hard-deleted. */
    public function isDeletable(): bool
    {
        return $this === self::Draft || $this === self::Cancelled;
    }
}
