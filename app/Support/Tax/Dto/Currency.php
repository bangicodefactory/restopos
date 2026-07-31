<?php

declare(strict_types=1);

namespace App\Support\Tax\Dto;

use App\Support\Money\RoundingMode;

/**
 * §4.1 — the currency the order is denominated in.
 *
 * `rounding` is the smallest representable increment ("0.01", "0.05", "0.001"); `decimalPlaces`
 * only drives rendering (§3.3.4). Maps from `currencies`.
 */
final class Currency
{
    public function __construct(
        public readonly string $code,
        public readonly int $decimalPlaces,
        public readonly string $rounding,
        public readonly RoundingMode $roundingMode = RoundingMode::HalfUp,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            (string) ($data['code'] ?? 'EUR'),
            (int) ($data['decimalPlaces'] ?? 2),
            (string) ($data['rounding'] ?? '0.01'),
            RoundingMode::parse(isset($data['roundingMode']) ? (string) $data['roundingMode'] : null),
        );
    }
}
