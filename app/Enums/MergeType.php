<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * What a `pos_order_merges` audit row recorded.
 */
enum MergeType: string
{
    use HasEnumHelpers;

    case TableLink = 'table_link';
    case OrderTransfer = 'order_transfer';
    case OrderMerge = 'order_merge';
    case Split = 'split';

    public function label(): string
    {
        return match ($this) {
            self::TableLink => 'Table link',
            self::OrderTransfer => 'Order transfer',
            self::OrderMerge => 'Order merge',
            self::Split => 'Bill split',
        };
    }
}
