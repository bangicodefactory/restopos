<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Online `payment_transactions.state` (spec §4.6).
 */
enum PaymentTransactionState: string
{
    use HasEnumHelpers;

    case Draft = 'draft';
    case Pending = 'pending';
    case Authorized = 'authorized';
    case Done = 'done';
    case Cancelled = 'cancelled';
    case Error = 'error';

    public function label(): string
    {
        return match ($this) {
            self::Draft => 'Draft',
            self::Pending => 'Pending',
            self::Authorized => 'Authorized',
            self::Done => 'Done',
            self::Cancelled => 'Cancelled',
            self::Error => 'Error',
        };
    }

    public function isFinal(): bool
    {
        return match ($this) {
            self::Done, self::Cancelled, self::Error => true,
            default => false,
        };
    }
}
