<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * What a `sequences` row numbers (replaces `ir.sequence`).
 */
enum SequencePurpose: string
{
    use HasEnumHelpers;

    case Order = 'order';
    case Receipt = 'receipt';
    case OrderLine = 'order_line';
    case Device = 'device';
    case Session = 'session';
    case Invoice = 'invoice';
    case Refund = 'refund';

    public function label(): string
    {
        return match ($this) {
            self::Order => 'Order reference',
            self::Receipt => 'Receipt number',
            self::OrderLine => 'Order line',
            self::Device => 'Device identifier',
            self::Session => 'Session name',
            self::Invoice => 'Invoice number',
            self::Refund => 'Refund reference',
        };
    }
}
