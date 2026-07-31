<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Per-register privilege of an employee (`pos_config_employee.access_level`).
 */
enum AccessLevel: string
{
    use HasEnumHelpers;

    case Minimal = 'minimal';
    case Basic = 'basic';
    case Advanced = 'advanced';

    public function label(): string
    {
        return match ($this) {
            self::Minimal => 'Minimal',
            self::Basic => 'Basic',
            self::Advanced => 'Advanced (manager)',
        };
    }

    /** `advanced` grants the manager role on that register. */
    public function toRole(): EmployeeRole
    {
        return match ($this) {
            self::Minimal => EmployeeRole::Minimal,
            self::Basic => EmployeeRole::Cashier,
            self::Advanced => EmployeeRole::Manager,
        };
    }
}
