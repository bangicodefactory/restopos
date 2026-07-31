<?php

declare(strict_types=1);

namespace App\Support\Tax\Dto;

/**
 * §4.4 — everything the tax engine needs for one document.
 *
 * Deliberately a plain value object built from arrays: no Eloquent, no container, no facades,
 * so it is trivially constructible from a sync payload, a fixture, or a database row.
 */
final class OrderInput
{
    public const ROUND_PER_LINE = 'round_per_line';

    public const ROUND_GLOBALLY = 'round_globally';

    /**
     * @param  list<TaxDefinition>  $taxes
     * @param  list<LineInput>  $lines
     */
    public function __construct(
        public readonly Currency $currency,
        public readonly array $taxes,
        public readonly array $lines,
        public readonly string $roundingMethod = self::ROUND_PER_LINE,
        public readonly string $documentSign = '1',
        public readonly ?FiscalPosition $fiscalPosition = null,
        public readonly ?CashRoundingConfig $cashRounding = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        /** @var list<TaxDefinition> $taxes */
        $taxes = \array_map(
            static fn (array $row): TaxDefinition => TaxDefinition::fromArray($row),
            \array_values((array) ($data['taxes'] ?? [])),
        );
        /** @var list<LineInput> $lines */
        $lines = \array_map(
            static fn (array $row): LineInput => LineInput::fromArray($row),
            \array_values((array) ($data['lines'] ?? [])),
        );

        $fiscalPosition = $data['fiscalPosition'] ?? null;
        $cashRounding = $data['cashRounding'] ?? null;

        return new self(
            Currency::fromArray((array) ($data['currency'] ?? [])),
            $taxes,
            $lines,
            (string) ($data['roundingMethod'] ?? self::ROUND_PER_LINE),
            (string) ($data['documentSign'] ?? '1'),
            \is_array($fiscalPosition) ? FiscalPosition::fromArray($fiscalPosition) : null,
            \is_array($cashRounding) ? CashRoundingConfig::fromArray($cashRounding) : null,
        );
    }

    public function roundsPerLine(): bool
    {
        return $this->roundingMethod === self::ROUND_PER_LINE;
    }

    /** @return array<int, TaxDefinition> keyed by tax id */
    public function taxCatalog(): array
    {
        $catalog = [];
        foreach ($this->taxes as $tax) {
            $catalog[$tax->id] = $tax;
        }

        return $catalog;
    }
}
