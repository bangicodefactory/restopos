<?php

declare(strict_types=1);

namespace Database\Seeders\Support;

use DateTimeImmutable;
use DateTimeZone;

/**
 * Deterministic helpers shared by every demo seeder.
 *
 * The demo data set must be byte-for-byte reproducible: two `migrate:fresh --seed`
 * runs have to produce the same uuids, the same access tokens and the same order
 * mix, otherwise fixture-based tests and screenshots drift. Nothing here uses
 * `random_bytes()`, `Str::uuid()` or `now()`.
 */
final class Demo
{
    /** Everything is anchored to this instant instead of `now()`. */
    public const CLOCK = '2026-07-28 09:00:00';

    public const RNG_SEED = 20260728;

    public const COMPANY_NAME = 'Le Bistro Numérique';

    private static ?self $instance = null;

    private int $state;

    private function __construct(int $seed)
    {
        $this->state = $seed;
    }

    public static function rng(): self
    {
        return self::$instance ??= new self(self::RNG_SEED);
    }

    /** Re-seed the stream so a single seeder run standalone matches its run inside the suite. */
    public static function reseed(string $streamKey): self
    {
        $seed = self::RNG_SEED + (int) hexdec(substr(md5($streamKey), 0, 6));
        self::$instance = new self($seed);

        return self::$instance;
    }

    /** xorshift32 — tiny, portable and identical on every PHP build. */
    public function next(): int
    {
        $x = $this->state;
        $x ^= ($x << 13) & 0xFFFFFFFF;
        $x ^= ($x >> 17);
        $x ^= ($x << 5) & 0xFFFFFFFF;
        $this->state = $x & 0xFFFFFFFF;

        return $this->state;
    }

    public function int(int $min, int $max): int
    {
        if ($max <= $min) {
            return $min;
        }

        return $min + ($this->next() % ($max - $min + 1));
    }

    /** @param  non-empty-list<mixed>  $items */
    public function pick(array $items): mixed
    {
        return $items[$this->int(0, count($items) - 1)];
    }

    /** True with probability `percent`/100. */
    public function chance(int $percent): bool
    {
        return $this->int(1, 100) <= $percent;
    }

    /**
     * A stable RFC-4122-shaped uuid derived from a namespace key.
     *
     * Same key ⇒ same uuid, on every machine and every run.
     */
    public static function uuid(string $key): string
    {
        $hash = md5('restopos-demo:'.$key);

        return sprintf(
            '%s-%s-4%s-%s%s-%s',
            substr($hash, 0, 8),
            substr($hash, 8, 4),
            substr($hash, 13, 3),
            dechex(8 + (hexdec($hash[16]) % 4)),
            substr($hash, 17, 3),
            substr($hash, 20, 12),
        );
    }

    /** A stable hex token of `$length` characters (access tokens, identifiers). */
    public static function token(string $key, int $length = 32): string
    {
        $out = '';
        $i = 0;
        while (strlen($out) < $length) {
            $out .= md5('restopos-token:'.$key.':'.$i);
            $i++;
        }

        return substr($out, 0, $length);
    }

    public static function sha256(string $value): string
    {
        return hash('sha256', $value);
    }

    public static function clock(): DateTimeImmutable
    {
        return new DateTimeImmutable(self::CLOCK, new DateTimeZone('UTC'));
    }

    /** `$daysAgo` days before the demo clock, at midnight (negative = in the future). */
    public static function day(int $daysAgo): DateTimeImmutable
    {
        return self::clock()->modify(sprintf('%+d days', -$daysAgo))->setTime(0, 0, 0);
    }

    public static function at(int $daysAgo, int $hour, int $minute = 0, int $second = 0): DateTimeImmutable
    {
        return self::day($daysAgo)->setTime($hour, $minute, $second);
    }

    public static function ts(DateTimeImmutable $moment): string
    {
        return $moment->format('Y-m-d H:i:s');
    }

    public static function ms(DateTimeImmutable $moment): string
    {
        return $moment->format('Y-m-d H:i:s.v');
    }

    /**
     * A URL/receipt-safe slug for a French product name.
     *
     * "Crème brûlée" → "creme-brulee"; used for `default_code` so every internal
     * reference stays ASCII while the display name keeps its accents.
     */
    public static function slug(string $value): string
    {
        $map = [
            'à' => 'a', 'â' => 'a', 'ä' => 'a', 'á' => 'a', 'ã' => 'a', 'å' => 'a',
            'ç' => 'c', 'é' => 'e', 'è' => 'e', 'ê' => 'e', 'ë' => 'e',
            'î' => 'i', 'ï' => 'i', 'í' => 'i', 'ì' => 'i',
            'ô' => 'o', 'ö' => 'o', 'ó' => 'o', 'ò' => 'o', 'õ' => 'o',
            'ù' => 'u', 'û' => 'u', 'ü' => 'u', 'ú' => 'u',
            'ÿ' => 'y', 'ñ' => 'n', 'œ' => 'oe', 'æ' => 'ae', 'ß' => 'ss',
        ];

        $value = strtr(mb_strtolower($value, 'UTF-8'), $map);
        $value = preg_replace('/[^a-z0-9]+/', '-', $value) ?? '';

        return trim($value, '-');
    }

    /** EAN-13 check digit, so every seeded barcode actually scans. */
    public static function ean13(string $twelveDigits): string
    {
        $sum = 0;
        for ($i = 0; $i < 12; $i++) {
            $sum += (int) $twelveDigits[$i] * ($i % 2 === 0 ? 1 : 3);
        }

        return $twelveDigits.((string) ((10 - ($sum % 10)) % 10));
    }
}
