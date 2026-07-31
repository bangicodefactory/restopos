<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Nature of a `pos_invoices` document.
 */
enum InvoiceType: string
{
    use HasEnumHelpers;

    case Invoice = 'invoice';
    case CreditNote = 'credit_note';

    public function label(): string
    {
        return match ($this) {
            self::Invoice => 'Invoice',
            self::CreditNote => 'Credit note',
        };
    }
}
