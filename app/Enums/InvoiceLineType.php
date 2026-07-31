<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Nature of a `pos_invoice_lines` row.
 */
enum InvoiceLineType: string
{
    use HasEnumHelpers;

    case Product = 'product';
    case Section = 'section';
    case Note = 'note';
    case Rounding = 'rounding';
    case Discount = 'discount';

    public function label(): string
    {
        return match ($this) {
            self::Product => 'Product',
            self::Section => 'Section',
            self::Note => 'Note',
            self::Rounding => 'Cash rounding',
            self::Discount => 'Discount',
        };
    }
}
