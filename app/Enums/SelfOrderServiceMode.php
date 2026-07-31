<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * `pos_configs.self_ordering_service_mode` (spec §4.13).
 */
enum SelfOrderServiceMode: string
{
    use HasEnumHelpers;

    case Counter = 'counter';
    case Table = 'table';

    public function label(): string
    {
        return match ($this) {
            self::Counter => 'At the counter',
            self::Table => 'At the table',
        };
    }
}
