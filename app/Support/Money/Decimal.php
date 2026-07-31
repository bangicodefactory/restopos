<?php

declare(strict_types=1);

namespace App\Support\Money;

use InvalidArgumentException;
use Stringable;

/**
 * An exact, immutable decimal — docs/spec/04-tax-engine.md §2.
 *
 * Value = (-1)^negative * unscaled * 10^-scale, with `unscaled` held as a decimal digit string
 * and all arithmetic delegated to {@see BigInt} (bcmath-backed). **No float ever touches this
 * class** (§1.3): there is no `(float)` cast, no `round()`, no `**`, no `/`.
 *
 * The TypeScript twin is `packages/domain/src/money/decimal.ts`; the two are pinned together by
 * `tests/fixtures/tax/*.json`.
 */
final class Decimal implements Stringable
{
    /** §2.1.5 — the internal working scale. */
    public const MAX_SCALE = 12;

    /** §2.1.6 — unit prices are reported at scale 4, matching `decimal(16,4)`. */
    public const PRICE_SCALE = 4;

    private function __construct(
        public readonly bool $negative,
        public readonly string $unscaled,
        public readonly int $scale,
    ) {}

    /** §2.1.1 / §2.1.2 — the only constructor; normalises negative zero away. */
    public static function make(bool $negative, string $unscaled, int $scale): self
    {
        if ($scale < 0) {
            throw new InvalidArgumentException('scale must be non-negative');
        }
        $unscaled = BigInt::normalize($unscaled);

        return new self($unscaled === '0' ? false : $negative, $unscaled, $scale);
    }

    /** §1.2 — parse a decimal string. Rejects exponents, leading `+`, bare `.5` and `1.`. */
    public static function of(self|string $value): self
    {
        if ($value instanceof self) {
            return $value;
        }
        if (\preg_match('/^-?\d+(\.\d+)?$/', $value) !== 1) {
            throw new InvalidArgumentException(\sprintf('invalid decimal string "%s"', $value));
        }
        $negative = $value[0] === '-';
        $body = $negative ? \substr($value, 1) : $value;
        $dot = \strpos($body, '.');
        if ($dot === false) {
            return self::make($negative, $body, 0);
        }
        $fraction = \substr($body, $dot + 1);

        return self::make($negative, \substr($body, 0, $dot).$fraction, \strlen($fraction));
    }

    /** Convenience for small integers produced by the algorithm itself (signs, counters). */
    public static function fromInt(int $value): self
    {
        return self::make($value < 0, (string) \abs($value), 0);
    }

    public static function zero(): self
    {
        return self::of('0');
    }

    public static function one(): self
    {
        return self::of('1');
    }

    public static function hundred(): self
    {
        return self::of('100');
    }

    /** §2.1.4 */
    public function __toString(): string
    {
        if ($this->scale === 0) {
            $body = $this->unscaled;
        } else {
            $padded = \str_pad($this->unscaled, $this->scale + 1, '0', \STR_PAD_LEFT);
            $cut = \strlen($padded) - $this->scale;
            $body = \substr($padded, 0, $cut).'.'.\substr($padded, $cut);
        }

        return $this->negative && $this->unscaled !== '0' ? '-'.$body : $body;
    }

    public function toString(): string
    {
        return (string) $this;
    }

    public function isZero(): bool
    {
        return $this->unscaled === '0';
    }

    public function signum(): int
    {
        return $this->isZero() ? 0 : ($this->negative ? -1 : 1);
    }

    public function negate(): self
    {
        return self::make(! $this->negative, $this->unscaled, $this->scale);
    }

    public function abs(): self
    {
        return self::make(false, $this->unscaled, $this->scale);
    }

    /** §2.2.1 — exact, result scale = max(scales). */
    public function add(self|string $other): self
    {
        $o = self::of($other);
        $scale = \max($this->scale, $o->scale);
        $a = BigInt::shiftLeft($this->unscaled, $scale - $this->scale);
        $b = BigInt::shiftLeft($o->unscaled, $scale - $o->scale);

        if ($this->negative === $o->negative) {
            return self::make($this->negative, BigInt::add($a, $b), $scale);
        }
        $cmp = BigInt::cmp($a, $b);
        if ($cmp === 0) {
            return self::make(false, '0', $scale);
        }
        if ($cmp > 0) {
            return self::make($this->negative, BigInt::sub($a, $b), $scale);
        }

        return self::make($o->negative, BigInt::sub($b, $a), $scale);
    }

    /** §2.2.1 */
    public function sub(self|string $other): self
    {
        return $this->add(self::of($other)->negate());
    }

    /** §2.2.2 — exact product, then clamped to MAX_SCALE (§2.2.3). */
    public function mul(self|string $other): self
    {
        $o = self::of($other);

        return self::make(
            $this->negative !== $o->negative,
            BigInt::mul($this->unscaled, $o->unscaled),
            $this->scale + $o->scale,
        )->clamp();
    }

    /** §2.2.3 */
    public function clamp(): self
    {
        return $this->scale <= self::MAX_SCALE
            ? $this
            : $this->withScale(self::MAX_SCALE, RoundingMode::HalfUp);
    }

    /** §2.2.4 */
    public function div(self|string $other, ?int $scale = null, ?RoundingMode $mode = null): self
    {
        $o = self::of($other);
        $scale ??= self::MAX_SCALE;
        $mode ??= RoundingMode::HalfUp;
        if ($o->isZero()) {
            throw new \DivisionByZeroError('Decimal division by zero');
        }
        $shift = $scale + $o->scale - $this->scale;
        $numerator = $shift > 0 ? BigInt::shiftLeft($this->unscaled, $shift) : $this->unscaled;
        $denominator = $shift < 0 ? BigInt::shiftLeft($o->unscaled, -$shift) : $o->unscaled;
        [$quotient, $remainder] = BigInt::divMod($numerator, $denominator);

        return self::make(
            $this->negative !== $o->negative,
            $mode->apply($quotient, $remainder, $denominator),
            $scale,
        );
    }

    /** §2.2.7 */
    public function withScale(int $scale, ?RoundingMode $mode = null): self
    {
        $mode ??= RoundingMode::HalfUp;
        if ($scale < 0) {
            throw new InvalidArgumentException('scale must be non-negative');
        }
        if ($scale >= $this->scale) {
            return self::make($this->negative, BigInt::shiftLeft($this->unscaled, $scale - $this->scale), $scale);
        }
        $denominator = BigInt::pow10($this->scale - $scale);
        [$quotient, $remainder] = BigInt::divMod($this->unscaled, $denominator);

        return self::make($this->negative, $mode->apply($quotient, $remainder, $denominator), $scale);
    }

    /** §3.3.2 — round to the nearest multiple of `$step`. A zero step is a no-op. */
    public function roundToStep(self|string $step, ?RoundingMode $mode = null): self
    {
        $s = self::of($step);
        if ($s->isZero()) {
            return $this;
        }

        return $this->div($s, 0, $mode ?? RoundingMode::HalfUp)->mul($s);
    }

    /** §2.2.6 — value comparison; `1.50` equals `1.5`. */
    public function compare(self|string $other): int
    {
        $o = self::of($other);
        if ($this->signum() !== $o->signum()) {
            return $this->signum() <=> $o->signum();
        }
        $scale = \max($this->scale, $o->scale);
        $a = BigInt::shiftLeft($this->unscaled, $scale - $this->scale);
        $b = BigInt::shiftLeft($o->unscaled, $scale - $o->scale);
        $cmp = BigInt::cmp($a, $b);

        return $this->negative ? -$cmp : $cmp;
    }

    public function eq(self|string $other): bool
    {
        return $this->compare($other) === 0;
    }

    public function lt(self|string $other): bool
    {
        return $this->compare($other) < 0;
    }

    public function gt(self|string $other): bool
    {
        return $this->compare($other) > 0;
    }

    public function lte(self|string $other): bool
    {
        return $this->compare($other) <= 0;
    }

    public function gte(self|string $other): bool
    {
        return $this->compare($other) >= 0;
    }
}
