<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Fine-grained edit recorded in `pos_order_edit_logs`.
 */
enum OrderEditAction: string
{
    use HasEnumHelpers;

    case LineAdded = 'line_added';
    case LineRemoved = 'line_removed';
    case QtyDecreased = 'qty_decreased';
    case QtyIncreased = 'qty_increased';
    case PriceChanged = 'price_changed';
    case DiscountChanged = 'discount_changed';
    case NoteChanged = 'note_changed';
    case PaymentChanged = 'payment_changed';
    case OrderCancelled = 'order_cancelled';

    public function label(): string
    {
        return match ($this) {
            self::LineAdded => 'Line added',
            self::LineRemoved => 'Line removed',
            self::QtyDecreased => 'Quantity decreased',
            self::QtyIncreased => 'Quantity increased',
            self::PriceChanged => 'Price changed',
            self::DiscountChanged => 'Discount changed',
            self::NoteChanged => 'Note changed',
            self::PaymentChanged => 'Payment changed',
            self::OrderCancelled => 'Order cancelled',
        };
    }
}
