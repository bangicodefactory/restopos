<?php

declare(strict_types=1);

namespace App\Support\Money;

use DivisionByZeroError;
use InvalidArgumentException;

/**
 * Exact arithmetic on non-negative integers held as canonical decimal strings.
 *
 * This is the substrate `Decimal` (docs/spec/04-tax-engine.md §2) is built on. It uses bcmath
 * when the extension is loaded — the composer.json requires `ext-bcmath`, so production always
 * does — and falls back to schoolbook string arithmetic otherwise. Both paths are exact integer
 * arithmetic and therefore produce byte-identical results; the fallback exists so the engine and
 * its parity harness stay runnable on a bare PHP build.
 *
 * "Canonical" means: only digits, no sign, no leading zeros except the single string "0".
 *
 * @internal
 */
final class BigInt
{
    /** Chunk width for the pure-PHP fallback; 1e7 keeps every intermediate product < 2^63. */
    private const CHUNK = 7;

    private const CHUNK_BASE = 10000000;

    private static ?bool $bc = null;

    private function __construct() {}

    private static function hasBcMath(): bool
    {
        return self::$bc ??= \function_exists('bcadd');
    }

    /** Strip leading zeros; validate the shape. */
    public static function normalize(string $digits): string
    {
        if ($digits === '' || ! \ctype_digit($digits)) {
            throw new InvalidArgumentException(\sprintf('not a non-negative integer string: "%s"', $digits));
        }
        $trimmed = \ltrim($digits, '0');

        return $trimmed === '' ? '0' : $trimmed;
    }

    public static function isZero(string $a): bool
    {
        return $a === '0';
    }

    public static function isOdd(string $a): bool
    {
        return ((int) $a[\strlen($a) - 1]) % 2 === 1;
    }

    public static function cmp(string $a, string $b): int
    {
        if (self::hasBcMath()) {
            return \bccomp($a, $b, 0);
        }
        $la = \strlen($a);
        $lb = \strlen($b);
        if ($la !== $lb) {
            return $la < $lb ? -1 : 1;
        }

        return $a <=> $b;
    }

    public static function add(string $a, string $b): string
    {
        if (self::hasBcMath()) {
            return \bcadd($a, $b, 0);
        }
        $x = self::chunks($a);
        $y = self::chunks($b);
        $n = \max(\count($x), \count($y));
        $out = [];
        $carry = 0;
        for ($i = 0; $i < $n; $i++) {
            $sum = ($x[$i] ?? 0) + ($y[$i] ?? 0) + $carry;
            $carry = \intdiv($sum, self::CHUNK_BASE);
            $out[] = $sum % self::CHUNK_BASE;
        }
        if ($carry > 0) {
            $out[] = $carry;
        }

        return self::unchunk($out);
    }

    /** Requires `$a >= $b`. */
    public static function sub(string $a, string $b): string
    {
        if (self::hasBcMath()) {
            return \bcsub($a, $b, 0);
        }
        $x = self::chunks($a);
        $y = self::chunks($b);
        $out = [];
        $borrow = 0;
        for ($i = 0, $n = \count($x); $i < $n; $i++) {
            $diff = $x[$i] - ($y[$i] ?? 0) - $borrow;
            if ($diff < 0) {
                $diff += self::CHUNK_BASE;
                $borrow = 1;
            } else {
                $borrow = 0;
            }
            $out[] = $diff;
        }
        if ($borrow !== 0) {
            throw new InvalidArgumentException('BigInt::sub would produce a negative result');
        }

        return self::unchunk($out);
    }

    public static function mul(string $a, string $b): string
    {
        if (self::hasBcMath()) {
            return \bcmul($a, $b, 0);
        }
        if ($a === '0' || $b === '0') {
            return '0';
        }
        $x = self::chunks($a);
        $y = self::chunks($b);
        $nx = \count($x);
        $ny = \count($y);
        $out = \array_fill(0, $nx + $ny, 0);
        for ($i = 0; $i < $nx; $i++) {
            $carry = 0;
            for ($j = 0; $j < $ny; $j++) {
                $cur = $out[$i + $j] + $x[$i] * $y[$j] + $carry;
                $out[$i + $j] = $cur % self::CHUNK_BASE;
                $carry = \intdiv($cur, self::CHUNK_BASE);
            }
            $k = $i + $ny;
            while ($carry > 0) {
                $cur = $out[$k] + $carry;
                $out[$k] = $cur % self::CHUNK_BASE;
                $carry = \intdiv($cur, self::CHUNK_BASE);
                $k++;
            }
        }

        return self::unchunk($out);
    }

    /**
     * @return array{0: string, 1: string} [quotient, remainder]
     */
    public static function divMod(string $a, string $b): array
    {
        if ($b === '0') {
            throw new DivisionByZeroError('BigInt::divMod by zero');
        }
        if (self::hasBcMath()) {
            return [\bcdiv($a, $b, 0), \bcmod($a, $b, 0)];
        }
        if (self::cmp($a, $b) < 0) {
            return ['0', $a];
        }
        $quotient = '';
        $remainder = '0';
        for ($i = 0, $n = \strlen($a); $i < $n; $i++) {
            $remainder = self::normalize(($remainder === '0' ? '' : $remainder).$a[$i]);
            $digit = 0;
            while (self::cmp($remainder, $b) >= 0) {
                $remainder = self::sub($remainder, $b);
                $digit++;
            }
            $quotient .= (string) $digit;
        }

        return [self::normalize($quotient), $remainder];
    }

    public static function pow10(int $exponent): string
    {
        if ($exponent < 0) {
            throw new InvalidArgumentException(\sprintf('pow10 of negative exponent %d', $exponent));
        }

        return $exponent === 0 ? '1' : '1'.\str_repeat('0', $exponent);
    }

    public static function shiftLeft(string $a, int $exponent): string
    {
        if ($exponent === 0 || $a === '0') {
            return $a;
        }

        return self::normalize($a.\str_repeat('0', $exponent));
    }

    /** @return list<int> little-endian base-1e7 chunks */
    private static function chunks(string $a): array
    {
        $out = [];
        for ($i = \strlen($a); $i > 0; $i -= self::CHUNK) {
            $start = \max(0, $i - self::CHUNK);
            $out[] = (int) \substr($a, $start, $i - $start);
        }

        return $out === [] ? [0] : $out;
    }

    /** @param list<int> $chunks */
    private static function unchunk(array $chunks): string
    {
        $out = '';
        for ($i = \count($chunks) - 1; $i >= 0; $i--) {
            $out .= $out === ''
                ? (string) $chunks[$i]
                : \str_pad((string) $chunks[$i], self::CHUNK, '0', \STR_PAD_LEFT);
        }

        return self::normalize($out);
    }
}
