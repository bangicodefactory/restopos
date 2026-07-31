<?php

declare(strict_types=1);

namespace App\Support\Money;

/**
 * Rounding modes — docs/spec/04-tax-engine.md §3.1.
 *
 * Every mode is defined on the magnitude and then signed: there is no CEIL/FLOOR, so a refund
 * rounds as the exact mirror of the sale that produced it (§3.1, §7.3). The backed values are
 * exactly the strings used in `currencies.rounding_method`, `cash_roundings.rounding_method`
 * and in the fixture corpus, so `RoundingMode::from($json)` is always safe.
 */
enum RoundingMode: string
{
    case HalfUp = 'half_up';
    case HalfDown = 'half_down';
    case HalfEven = 'half_even';
    case Up = 'up';
    case Down = 'down';

    public static function parse(?string $value): self
    {
        return $value === null ? self::HalfUp : self::from($value);
    }

    /**
     * §3.2 — decide whether the truncated quotient is incremented.
     *
     * All arguments are non-negative decimal integer strings with `remainder < divisor`.
     */
    public function apply(string $quotient, string $remainder, string $divisor): string
    {
        if ($remainder === '0') {
            return $quotient;
        }

        $twice = BigInt::add($remainder, $remainder);
        $cmp = BigInt::cmp($twice, $divisor);

        return match ($this) {
            self::Down => $quotient,
            self::Up => BigInt::add($quotient, '1'),
            self::HalfUp => $cmp >= 0 ? BigInt::add($quotient, '1') : $quotient,
            self::HalfDown => $cmp > 0 ? BigInt::add($quotient, '1') : $quotient,
            self::HalfEven => match (true) {
                $cmp > 0 => BigInt::add($quotient, '1'),
                $cmp < 0 => $quotient,
                default => BigInt::isOdd($quotient) ? BigInt::add($quotient, '1') : $quotient,
            },
        };
    }
}
