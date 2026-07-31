<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Nature of a `products` row.
 */
enum ProductType: string
{
    use HasEnumHelpers;

    case Consumable = 'consumable';
    case Service = 'service';
    case Combo = 'combo';

    public function label(): string
    {
        return match ($this) {
            self::Consumable => 'Consumable',
            self::Service => 'Service',
            self::Combo => 'Combo / menu',
        };
    }

    public function isCombo(): bool
    {
        return $this === self::Combo;
    }
}
