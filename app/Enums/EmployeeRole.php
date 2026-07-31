<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Effective register role of an employee (spec §4.8).
 */
enum EmployeeRole: string
{
    use HasEnumHelpers;

    case Minimal = 'minimal';
    case Cashier = 'cashier';
    case Manager = 'manager';

    public function label(): string
    {
        return match ($this) {
            self::Minimal => 'Minimal',
            self::Cashier => 'Cashier',
            self::Manager => 'Manager',
        };
    }

    public function isManager(): bool
    {
        return $this === self::Manager;
    }

    public function rank(): int
    {
        return match ($this) {
            self::Minimal => 0,
            self::Cashier => 1,
            self::Manager => 2,
        };
    }
}
