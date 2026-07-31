<?php

declare(strict_types=1);

namespace App\Support\Tax\Dto;

/**
 * §4.5 — a tax mapping profile. Maps from `fiscal_positions`.
 */
final class FiscalPosition
{
    /** @param list<FiscalPositionMapping> $mappings */
    public function __construct(
        public readonly array $mappings,
        public readonly ?int $id = null,
        public readonly string $name = '',
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        /** @var list<FiscalPositionMapping> $mappings */
        $mappings = \array_map(
            static fn (array $row): FiscalPositionMapping => FiscalPositionMapping::fromArray($row),
            \array_values((array) ($data['mappings'] ?? [])),
        );

        return new self(
            $mappings,
            isset($data['id']) ? (int) $data['id'] : null,
            (string) ($data['name'] ?? ''),
        );
    }
}
