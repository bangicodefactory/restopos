<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * How to cast a `settings.value` string.
 */
enum SettingValueType: string
{
    use HasEnumHelpers;

    case String = 'string';
    case Int = 'int';
    case Float = 'float';
    case Bool = 'bool';
    case Json = 'json';

    public function label(): string
    {
        return match ($this) {
            self::String => 'Text',
            self::Int => 'Integer',
            self::Float => 'Decimal',
            self::Bool => 'Boolean',
            self::Json => 'JSON',
        };
    }

    public function cast(?string $value): mixed
    {
        if ($value === null) {
            return null;
        }

        return match ($this) {
            self::String => $value,
            self::Int => (int) $value,
            self::Float => (float) $value,
            self::Bool => filter_var($value, FILTER_VALIDATE_BOOLEAN),
            self::Json => json_decode($value, true),
        };
    }
}
