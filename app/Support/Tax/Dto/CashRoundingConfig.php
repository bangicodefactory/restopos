<?php

declare(strict_types=1);

namespace App\Support\Tax\Dto;

use App\Support\Money\RoundingMode;

/**
 * §4.6 — cash rounding configuration. Maps from `cash_roundings`.
 *
 * `up` / `down` are away-from / toward **zero**, so a refund rounds as the mirror of the sale.
 */
final class CashRoundingConfig
{
    public const ADD_INVOICE_LINE = 'add_invoice_line';

    public const BIGGEST_TAX = 'biggest_tax';

    public function __construct(
        public readonly string $rounding,
        public readonly RoundingMode $method = RoundingMode::HalfUp,
        public readonly string $strategy = self::ADD_INVOICE_LINE,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            (string) ($data['rounding'] ?? '0.05'),
            RoundingMode::parse(isset($data['method']) ? (string) $data['method'] : null),
            (string) ($data['strategy'] ?? self::ADD_INVOICE_LINE),
        );
    }
}
