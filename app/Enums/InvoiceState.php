<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Lifecycle of a `pos_invoices` document.
 */
enum InvoiceState: string
{
    use HasEnumHelpers;

    case Draft = 'draft';
    case Issued = 'issued';
    case Sent = 'sent';
    case Cancelled = 'cancelled';

    public function label(): string
    {
        return match ($this) {
            self::Draft => 'Draft',
            self::Issued => 'Issued',
            self::Sent => 'Sent',
            self::Cancelled => 'Cancelled',
        };
    }
}
