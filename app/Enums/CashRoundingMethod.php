<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Rounding direction of a `cash_roundings` row.
 */
enum CashRoundingMethod: string
{
    use HasEnumHelpers;

    case HalfUp = 'half_up';
    case Up = 'up';
    case Down = 'down';

    public function label(): string
    {
        return match ($this) {
            self::HalfUp => 'Half-up',
            self::Up => 'Always up',
            self::Down => 'Always down',
        };
    }

    /** Tolerance applied when checking that payments cover the total. */
    public function tolerance(string|float $rounding): float
    {
        $rounding = (float) $rounding;

        return $this === self::HalfUp ? $rounding / 2 : $rounding;
    }
}
