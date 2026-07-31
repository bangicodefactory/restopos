<?php

declare(strict_types=1);

namespace App\Enums\Concerns;

/**
 * Shared helpers for every backed string enum in the RestoPOS domain.
 *
 * The literal values are an API contract shared with `packages/domain/src/enums.ts`
 * and with the DB CHECK constraints emitted by the migrations — never renumber,
 * only append.
 */
trait HasEnumHelpers
{
    /**
     * Every backed value, in declaration order. Used by the migrations to build
     * the CHECK constraint of the matching column.
     *
     * @return list<string>
     */
    public static function values(): array
    {
        return array_map(static fn (self $case): string => $case->value, self::cases());
    }

    /**
     * value => label map, ready for a <select> or an Inertia prop.
     *
     * @return array<string, string>
     */
    public static function options(): array
    {
        $options = [];

        foreach (self::cases() as $case) {
            $options[$case->value] = $case->label();
        }

        return $options;
    }

    public static function isValid(?string $value): bool
    {
        return $value !== null && self::tryFrom($value) !== null;
    }

    /** Parse a value, falling back to a default instead of throwing. */
    public static function fromValue(?string $value, self $default): self
    {
        return ($value !== null ? self::tryFrom($value) : null) ?? $default;
    }

    public function is(self ...$others): bool
    {
        return in_array($this, $others, true);
    }
}
