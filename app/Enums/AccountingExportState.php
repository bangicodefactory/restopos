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
    case Exported = 'exported';
    case Sent = 'sent';
    case Failed = 'failed';

    public function label(): string
    {
        return match ($this) {
            self::Draft => 'Draft',
            self::Generated => 'Generated',
            self::Exported => 'Exported',
            self::Sent => 'Sent',
            self::Failed => 'Failed',
        };
    }

    /**
     * The states in which an export has actually consumed its sessions.
     *
     * `Exported` is the commit point: the file exists, the pivot rows are written and the sessions
     * carry `accounting_exported_at`. Anything short of it must leave the sessions available, or a
     * failed build strands a period nobody can ever export.
     *
     * @return list<string>
     */
    public static function consuming(): array
    {
        return [self::Exported->value, self::Sent->value];
    }
}
