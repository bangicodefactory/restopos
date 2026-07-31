<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Lifecycle of a `preparation_print_jobs` row.
 */
enum PrintJobState: string
{
    use HasEnumHelpers;

    case Queued = 'queued';
    case Printing = 'printing';
    case Printed = 'printed';
    case Failed = 'failed';
    case Skipped = 'skipped';

    public function label(): string
    {
        return match ($this) {
            self::Queued => 'Queued',
            self::Printing => 'Printing',
            self::Printed => 'Printed',
            self::Failed => 'Failed',
            self::Skipped => 'Skipped',
        };
    }

    public function isPending(): bool
    {
        return $this === self::Queued || $this === self::Printing;
    }
}
