<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\TaxRoundingMethod;
use App\Models\Pos\PosConfig;
use App\Support\Money\RoundingMode;
use App\Support\Tax\Dto\CashRoundingConfig;
use App\Support\Tax\Dto\Currency as TaxCurrency;
use App\Support\Tax\Dto\FiscalPosition as TaxFiscalPosition;
use App\Support\Tax\Dto\FiscalPositionMapping;
use App\Support\Tax\Dto\LineInput;
use App\Support\Tax\Dto\OrderInput;
use App\Support\Tax\Dto\OrderResult;
use App\Support\Tax\Dto\TaxDefinition;
use App\Support\Tax\TaxEngine;
use Illuminate\Database\ConnectionInterface;

/**
 * The bridge between persisted order rows and {@see TaxEngine}.
 *
 * **All** money maths lives in `app/Support/Tax`; this class only assembles the
 * engine's value objects from the database and hands the result back. It never
 * adds, multiplies or rounds anything itself — that rule is what keeps the PHP
 * and TypeScript engines in parity (docs/CONVENTIONS.md § "The tax-parity rule").
 *
 * The catalog is read once per order and memoised for the request, because a
 * 60-line restaurant tab would otherwise issue 60 identical tax lookups.
 */
final class OrderCalculator
{
    /** @var array<int, list<TaxDefinition>> */
    private array $taxCache = [];

    /** @var array<int, array<int, list<int>>> variantId => taxIds, per company */
    private array $variantTaxCache = [];

    public function __construct(
        private readonly TaxEngine $engine,
        private readonly ConnectionInterface $connection,
    ) {}

    /**
     * Compute a whole document.
     *
     * @param  list<array{id: string, quantity: string, price_unit: string, discount: string, tax_ids: list<int>, sign?: string}>  $lines
     */
    public function compute(PosConfig $config, array $lines, ?int $fiscalPositionId, string $documentSign = '1'): OrderResult
    {
        return $this->engine->compute(new OrderInput(
            currency: $this->currency($config),
            taxes: $this->taxes($config),
            lines: array_map(
                static fn (array $l): LineInput => new LineInput(
                    id: $l['id'],
                    quantity: $l['quantity'],
                    priceUnit: $l['price_unit'],
                    discount: $l['discount'],
                    taxIds: $l['tax_ids'],
                    sign: $l['sign'] ?? '1',
                ),
                $lines,
            ),
            roundingMethod: $this->roundingMethod($config),
            documentSign: $documentSign,
            fiscalPosition: $this->fiscalPosition($fiscalPositionId),
            cashRounding: $this->cashRounding($config),
        ));
    }

    /** The engine's currency descriptor for this register. */
    public function currency(PosConfig $config): TaxCurrency
    {
        /** @var object{code: string, decimal_places: int, rounding: string}|null $row */
        $row = $this->connection->table('currencies')->where('id', $config->currency_id)->first();

        if ($row === null) {
            return new TaxCurrency('EUR', 2, '0.01');
        }

        return new TaxCurrency(
            (string) $row->code,
            (int) $row->decimal_places,
            $this->trimRounding((string) $row->rounding),
        );
    }

    /**
     * Every company tax, including archived ones — a historical order still
     * references them (spec 01-schema §5.3).
     *
     * @return list<TaxDefinition>
     */
    public function taxes(PosConfig $config): array
    {
        $companyId = (int) $config->company_id;

        if (isset($this->taxCache[$companyId])) {
            return $this->taxCache[$companyId];
        }

        $children = [];
        foreach ($this->connection->table('tax_children')->orderBy('sequence')->get() as $row) {
            $children[(int) $row->parent_tax_id][] = (int) $row->child_tax_id;
        }

        $taxes = [];
        foreach ($this->connection->table('taxes')->where('company_id', $companyId)->orderBy('sequence')->orderBy('id')->get() as $row) {
            $taxes[] = new TaxDefinition(
                id: (int) $row->id,
                amountType: (string) $row->amount_type,
                amount: (string) $row->amount,
                sequence: (int) $row->sequence,
                taxGroupId: (int) $row->tax_group_id,
                name: (string) $row->name,
                priceInclude: (bool) $row->price_include,
                includeBaseAmount: (bool) $row->include_base_amount,
                isBaseAffected: (bool) $row->is_base_affected,
                hasNegativeFactor: (bool) $row->has_negative_factor,
                childrenTaxIds: $children[(int) $row->id] ?? [],
            );
        }

        return $this->taxCache[$companyId] = $taxes;
    }

    /**
     * Server-authoritative tax resolution for one line: the variant's own taxes,
     * falling back to the template's. The client's `tax_ids` are never trusted —
     * a tampered self-order payload must not be able to zero the VAT.
     *
     * @return list<int>
     */
    public function taxIdsForVariant(int $variantId, int $productId): array
    {
        if (isset($this->variantTaxCache[$variantId])) {
            return $this->variantTaxCache[$variantId][$productId] ?? [];
        }

        /** @var list<int> $ids */
        $ids = $this->connection->table('product_variant_tax')
            ->where('product_variant_id', $variantId)
            ->pluck('tax_id')
            ->map(static fn (mixed $v): int => (int) $v)
            ->all();

        if ($ids === []) {
            $ids = $this->connection->table('product_tax')
                ->where('product_id', $productId)
                ->pluck('tax_id')
                ->map(static fn (mixed $v): int => (int) $v)
                ->all();
            $ids = array_map(intval(...), $ids);
        }

        $this->variantTaxCache[$variantId] = [$productId => $ids];

        return $ids;
    }

    /** @return list<int> the ids of a tax stack after fiscal-position mapping */
    public function fiscalPosition(?int $fiscalPositionId): ?TaxFiscalPosition
    {
        if ($fiscalPositionId === null) {
            return null;
        }

        $mappings = [];
        foreach ($this->connection->table('fiscal_position_taxes')->where('fiscal_position_id', $fiscalPositionId)->get() as $row) {
            $mappings[] = new FiscalPositionMapping(
                (int) $row->tax_src_id,
                $row->tax_dest_id === null ? null : (int) $row->tax_dest_id,
            );
        }

        return new TaxFiscalPosition($mappings, $fiscalPositionId);
    }

    public function cashRounding(PosConfig $config): ?CashRoundingConfig
    {
        if (! $config->use_cash_rounding || $config->cash_rounding_id === null) {
            return null;
        }

        /** @var object{rounding: string, rounding_method: string}|null $row */
        $row = $this->connection->table('cash_roundings')->where('id', $config->cash_rounding_id)->first();

        if ($row === null) {
            return null;
        }

        return new CashRoundingConfig(
            $this->trimRounding((string) $row->rounding),
            RoundingMode::parse((string) $row->rounding_method),
        );
    }

    /**
     * `round_per_line` unless a tax in the stack demands global rounding
     * (spec 04 §8.1).
     */
    public function roundingMethod(PosConfig $config): string
    {
        $global = $this->connection->table('taxes')
            ->where('company_id', $config->company_id)
            ->where('rounding_strategy', TaxRoundingMethod::RoundGlobally->value)
            ->exists();

        return $global ? OrderInput::ROUND_GLOBALLY : OrderInput::ROUND_PER_LINE;
    }

    /** `0.010000` from a decimal(12,6) column is `0.01` to the engine. */
    private function trimRounding(string $value): string
    {
        if (! str_contains($value, '.')) {
            return $value;
        }

        $trimmed = rtrim(rtrim($value, '0'), '.');

        return $trimmed === '' ? '0' : $trimmed;
    }
}
