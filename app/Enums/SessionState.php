<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * State machine of `pos_sessions` (spec §4.2). Transitions are strictly forward.
 */
enum SessionState: string
{
    use HasEnumHelpers;

    case OpeningControl = 'opening_control';
    case Opened = 'opened';
    case ClosingControl = 'closing_control';
    case Closed = 'closed';

    public function label(): string
    {
        return match ($this) {
            self::OpeningControl => 'Opening Control',
            self::Opened => 'In Progress',
            self::ClosingControl => 'Closing Control',
            self::Closed => 'Closed',
        };
    }

    public function isOpen(): bool
    {
        return $this !== self::Closed;
    }

    public function canTrade(): bool
    {
        return $this === self::Opened;
    }

    public function next(): ?self
    {
        return match ($this) {
            self::OpeningControl => self::Opened,
            self::Opened => self::ClosingControl,
            self::ClosingControl => self::Closed,
            self::Closed => null,
        };
    }
}
