<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Kind of non-order cash movement (spec §4.4).
 */
enum CashMovementType: string
{
    use HasEnumHelpers;

    case CashIn = 'cash_in';
    case CashOut = 'cash_out';
    case OpeningFloat = 'opening_float';
    case ClosingLift = 'closing_lift';
    case Difference = 'difference';

    public function label(): string
    {
        return match ($this) {
            self::CashIn => 'Cash in',
            self::CashOut => 'Cash out',
            self::OpeningFloat => 'Opening float',
            self::ClosingLift => 'Closing lift',
            self::Difference => 'Closing difference',
        };
    }

    /** Expected sign of `cash_movements.amount`; `difference` may be either. */
    public function expectedSign(): ?int
    {
        return match ($this) {
            self::CashIn, self::OpeningFloat => 1,
            self::CashOut, self::ClosingLift => -1,
            self::Difference => null,
        };
    }

    /** Manual movements a cashier can create from the register. */
    public function isManual(): bool
    {
        return $this === self::CashIn || $this === self::CashOut;
    }
}
