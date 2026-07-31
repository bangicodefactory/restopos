<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Severity of an `audit_logs` entry.
 */
enum AuditSeverity: string
{
    use HasEnumHelpers;

    case Info = 'info';
    case Notice = 'notice';
    case Warning = 'warning';
    case Critical = 'critical';

    public function label(): string
    {
        return match ($this) {
            self::Info => 'Info',
            self::Notice => 'Notice',
            self::Warning => 'Warning',
            self::Critical => 'Critical',
        };
    }

    public function rank(): int
    {
        return match ($this) {
            self::Info => 0,
            self::Notice => 1,
            self::Warning => 2,
            self::Critical => 3,
        };
    }
}
