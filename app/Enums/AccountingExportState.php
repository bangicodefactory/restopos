<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Lifecycle of an `accounting_exports` batch.
 */
enum AccountingExportState: string
{
    use HasEnumHelpers;

    case Draft = 'draft';
    case Generated = 'generated';
    case Sent = 'sent';
    case Failed = 'failed';

    public function label(): string
    {
        return match ($this) {
            self::Draft => 'Draft',
            self::Generated => 'Generated',
            self::Sent => 'Sent',
            self::Failed => 'Failed',
        };
    }
}
