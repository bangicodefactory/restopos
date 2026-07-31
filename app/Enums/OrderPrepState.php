<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Denormalised kitchen state badge on `pos_orders.prep_state` (spec §4.3).
 */
enum OrderPrepState: string
{
    use HasEnumHelpers;

    case None = 'none';
    case Pending = 'pending';
    case Sent = 'sent';
    case PartiallyReady = 'partially_ready';
    case Ready = 'ready';
    case Served = 'served';

    public function label(): string
    {
        return match ($this) {
            self::None => 'Not sent',
            self::Pending => 'Pending',
            self::Sent => 'Sent to kitchen',
            self::PartiallyReady => 'Partially ready',
            self::Ready => 'Ready',
            self::Served => 'Served',
        };
    }
}
