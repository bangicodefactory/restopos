<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Status of one `pos_payments` row (spec §4.6).
 */
enum PaymentStatus: string
{
    use HasEnumHelpers;

    case Pending = 'pending';
    case Authorized = 'authorized';
    case Done = 'done';
    case Reversed = 'reversed';
    case Failed = 'failed';
    case Cancelled = 'cancelled';

    public function label(): string
    {
        return match ($this) {
            self::Pending => 'Pending',
            self::Authorized => 'Authorized',
            self::Done => 'Captured',
            self::Reversed => 'Reversed',
            self::Failed => 'Failed',
            self::Cancelled => 'Cancelled',
        };
    }

    /** Counts towards `pos_orders.amount_paid`. */
    public function isCaptured(): bool
    {
        return $this === self::Done;
    }
}
