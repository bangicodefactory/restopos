<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Customer information a preset requires (spec §4.12).
 */
enum PresetIdentification: string
{
    use HasEnumHelpers;

    case None = 'none';
    case Name = 'name';
    case Address = 'address';

    public function label(): string
    {
        return match ($this) {
            self::None => 'Nothing',
            self::Name => 'Name',
            self::Address => 'Full address',
        };
    }
}
