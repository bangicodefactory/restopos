<?php

declare(strict_types=1);

namespace App\Support\Tax\Dto;

/**
 * §4.5 — a tax mapping profile (`fiscal_positions` + `fiscal_position_taxes`).
 *
 * A mapping row with `taxDestId === null` drops the source tax (exemption); several rows with
 * the same `taxSrcId` expand one source tax into several destinations.
 */
final class FiscalPositionMapping
{
    public function __construct(
        public readonly int $taxSrcId,
        public readonly ?int $taxDestId,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $dest = $data['taxDestId'] ?? null;

        return new self((int) $data['taxSrcId'], $dest === null ? null : (int) $dest);
    }
}
