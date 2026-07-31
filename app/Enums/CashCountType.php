<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * When a `session_cash_counts` drawer count happened.
 */
enum CashCountType: string
{
    use HasEnumHelpers;

    case Opening = 'opening';
    case Closing = 'closing';
    case MidShift = 'mid_shift';

    public function label(): string
    {
        return match ($this) {
            self::Opening => 'Opening count',
            self::Closing => 'Closing count',
            self::MidShift => 'Mid-shift count',
        };
    }
}
