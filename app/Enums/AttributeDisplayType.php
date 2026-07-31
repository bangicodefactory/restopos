<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Widget used by the product configurator for a `product_attributes` row.
 */
enum AttributeDisplayType: string
{
    use HasEnumHelpers;

    case Radio = 'radio';
    case Pills = 'pills';
    case Select = 'select';
    case Color = 'color';
    case Multi = 'multi';

    public function label(): string
    {
        return match ($this) {
            self::Radio => 'Radio buttons',
            self::Pills => 'Pills',
            self::Select => 'Dropdown',
            self::Color => 'Color swatches',
            self::Multi => 'Multiple choice',
        };
    }

    public function allowsMultiple(): bool
    {
        return $this === self::Multi;
    }
}
