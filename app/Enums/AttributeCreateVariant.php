<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Whether choosing a value spawns a `product_variants` row.
 */
enum AttributeCreateVariant: string
{
    use HasEnumHelpers;

    case Always = 'always';
    case Dynamic = 'dynamic';
    case NoVariant = 'no_variant';

    public function label(): string
    {
        return match ($this) {
            self::Always => 'Instantly',
            self::Dynamic => 'Dynamically',
            self::NoVariant => 'Never (rides on the order line)',
        };
    }

    /** `no_variant` values are stored on the order line, not on a variant. */
    public function ridesOnLine(): bool
    {
        return $this === self::NoVariant;
    }
}
