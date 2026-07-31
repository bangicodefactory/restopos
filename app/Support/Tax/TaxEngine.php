<?php

declare(strict_types=1);

namespace App\Support\Tax;

use App\Support\Money\Decimal;
use App\Support\Money\RoundingMode;
use App\Support\Tax\Dto\LineInput;
use App\Support\Tax\Dto\LineResult;
use App\Support\Tax\Dto\LineTaxResult;
use App\Support\Tax\Dto\OrderInput;
use App\Support\Tax\Dto\OrderResult;
use App\Support\Tax\Dto\OrderTotals;
use App\Support\Tax\Dto\TaxDefinition;
use App\Support\Tax\Dto\TaxGroupResult;
use DomainException;
use RuntimeException;

/**
 * The pricing/tax engine — docs/spec/04-tax-engine.md §5 to §9.
 *
 * Pure PHP: no facades, no Eloquent, no container. It takes an {@see OrderInput} value object
 * and returns an {@see OrderResult}, so it is callable from a controller, a queue job, a console
 * command or a test with equal ease.
 *
 * This is a step-for-step port of `packages/domain/src/tax/engine.ts`. The two are pinned
 * together by `tests/fixtures/tax/*.json`; see docs/CONVENTIONS.md § "The tax-parity rule".
 */
final class TaxEngine
{
    /** §6.4 */
    public const MAX_GROUP_DEPTH = 5;

    public function __construct(
        private readonly FiscalPositionMapper $fiscalPositionMapper = new FiscalPositionMapper,
    ) {}

    public function compute(OrderInput $order): OrderResult
    {
        $rounder = new CurrencyRounder($order->currency);
        $perLine = $order->roundsPerLine();
        $catalog = $order->taxCatalog();
        $documentSign = Decimal::of($order->documentSign);

        /** @var list<TaxComputation> $computed */
        $computed = [];
        foreach ($order->lines as $line) {
            $ids = $this->fiscalPositionMapper->map($line->taxIds, $order->fiscalPosition);
            $computed[] = $this->computeLine($line, $this->flattenTaxes($ids, $catalog), $rounder, $perLine, $documentSign);
        }

        /** @var list<LineResult> $lines */
        $lines = [];
        foreach ($computed as $line) {
            /** @var list<LineTaxResult> $taxes */
            $taxes = [];
            foreach ($line->entries as $entry) {
                $taxes[] = new LineTaxResult(
                    $entry->taxId,
                    $rounder->format($perLine ? $entry->base : $rounder->round($entry->base)),
                    $rounder->format($perLine ? $entry->amount : $rounder->round($entry->amount)),
                );
            }
            $lines[] = new LineResult(
                $line->id,
                $line->priceUnit->withScale(Decimal::PRICE_SCALE, RoundingMode::HalfUp)->toString(),
                $rounder->format($perLine ? $line->rawExcluded : $rounder->round($line->rawExcluded)),
                $rounder->format($perLine ? $line->rawIncluded : $rounder->round($line->rawIncluded)),
                $taxes,
            );
        }

        $aggregate = $perLine
            ? $this->aggregatePerLine($computed)
            : $this->aggregateGlobally($computed, $rounder);

        $totalExcluded = $aggregate['totalExcluded'];
        $totalTax = $aggregate['totalTax'];
        $totalIncluded = $aggregate['totalIncluded'];
        /** @var list<array{taxGroupId: int, base: Decimal, amount: Decimal}> $taxGroups */
        $taxGroups = $aggregate['taxGroups'];

        // §9
        $roundedTotal = $totalIncluded;
        $roundingDelta = Decimal::zero();
        if ($order->cashRounding !== null) {
            $calculator = new CashRounding($order->cashRounding);
            $applied = $calculator->apply($totalIncluded);
            $roundedTotal = $applied->roundedTotal;
            $roundingDelta = $applied->delta;

            if ($calculator->isBiggestTax() && $taxGroups !== []) {
                $best = 0;
                foreach ($taxGroups as $i => $group) {
                    if ($group['amount']->abs()->gt($taxGroups[$best]['amount']->abs())) {
                        $best = $i;
                    }
                }
                $taxGroups[$best]['amount'] = $taxGroups[$best]['amount']->add($roundingDelta);
                $totalTax = $totalTax->add($roundingDelta);
                $totalIncluded = $roundedTotal;
            }
        }

        /** @var list<TaxGroupResult> $groups */
        $groups = [];
        foreach ($taxGroups as $group) {
            $groups[] = new TaxGroupResult(
                $group['taxGroupId'],
                $rounder->format($group['base']),
                $rounder->format($group['amount']),
            );
        }

        return new OrderResult($lines, new OrderTotals(
            $rounder->format($totalExcluded),
            $rounder->format($totalTax),
            $rounder->format($totalIncluded),
            $rounder->format($roundedTotal),
            $rounder->format($roundingDelta),
            $groups,
        ));
    }

    /**
     * §6 — resolve, order and flatten the tax stack of one line.
     *
     * @param  list<int>  $taxIds
     * @param  array<int, TaxDefinition>  $catalog
     * @return list<TaxDefinition>
     */
    public function flattenTaxes(array $taxIds, array $catalog): array
    {
        $flat = $this->resolveTaxes($taxIds, $catalog, 0, []);

        $seen = [];
        $deduped = [];
        foreach ($flat as $tax) {
            if (! isset($seen[$tax->id])) {
                $seen[$tax->id] = true;
                $deduped[] = $tax;
            }
        }
        $this->sortTaxes($deduped);

        return $deduped;
    }

    /**
     * @param  list<int>  $taxIds
     * @param  array<int, TaxDefinition>  $catalog
     * @param  array<int, true>  $stack
     * @return list<TaxDefinition>
     */
    private function resolveTaxes(array $taxIds, array $catalog, int $depth, array $stack): array
    {
        if ($depth > self::MAX_GROUP_DEPTH) {
            throw new RuntimeException(\sprintf('tax group nesting exceeds %d', self::MAX_GROUP_DEPTH));
        }

        $taxes = [];
        foreach ($taxIds as $id) {
            if (! isset($catalog[$id])) {
                throw new DomainException(\sprintf('unknown tax id %d', $id));
            }
            $taxes[] = $catalog[$id];
        }
        $this->sortTaxes($taxes);

        $out = [];
        foreach ($taxes as $tax) {
            if ($tax->isGroup()) {
                if (isset($stack[$tax->id])) {
                    throw new RuntimeException(\sprintf('cyclic tax group %d', $tax->id));
                }
                $out = \array_merge(
                    $out,
                    $this->resolveTaxes($tax->childrenTaxIds, $catalog, $depth + 1, $stack + [$tax->id => true]),
                );
            } else {
                $out[] = $tax;
            }
        }

        return $out;
    }

    /** §6.2 / §6.5 — (sequence ASC, id ASC). @param list<TaxDefinition> $taxes */
    private function sortTaxes(array &$taxes): void
    {
        \usort(
            $taxes,
            static fn (TaxDefinition $a, TaxDefinition $b): int => $a->sequence !== $b->sequence
                ? $a->sequence <=> $b->sequence
                : $a->id <=> $b->id,
        );
    }

    /** §7 — compute one line. @param list<TaxDefinition> $flat */
    private function computeLine(
        LineInput $line,
        array $flat,
        CurrencyRounder $rounder,
        bool $perLine,
        Decimal $documentSign,
    ): TaxComputation {
        $roundLine = static fn (Decimal $v): Decimal => $perLine ? $rounder->round($v) : $v;

        $one = Decimal::one();
        $hundred = Decimal::hundred();
        $minusOne = Decimal::of('-1');
        $zero = Decimal::zero();

        $priceUnit = Decimal::of($line->priceUnit);
        $quantity = Decimal::of($line->quantity);
        $discount = Decimal::of($line->discount);

        // §7.2
        $discountFactor = $one->sub($discount->div($hundred, Decimal::MAX_SCALE, RoundingMode::HalfUp));
        $priceAfterDiscount = $priceUnit->mul($discountFactor);
        $lineAmount = $roundLine($priceAfterDiscount->mul($quantity));

        // §7.3
        $naturalSign = $lineAmount->signum() < 0 ? $minusOne : $one;
        $outSign = $documentSign->mul(Decimal::of($line->sign))->mul($naturalSign);
        $magnitude = $lineAmount->abs();
        $absQuantity = $quantity->abs();

        $n = \count($flat);

        // §7.4 — descending pass
        $base = $magnitude;
        $inclFixed = $zero;
        $inclPercent = $zero;
        $inclDivision = $zero;
        /** @var array<int, Decimal> $checkpoint */
        $checkpoint = [];
        $storeCheckpoint = true;
        $nextIsBaseAffected = true;

        for ($i = $n - 1; $i >= 0; $i--) {
            $tax = $flat[$i];
            $factor = $tax->hasNegativeFactor ? $minusOne : $one;

            if ($tax->includeBaseAmount && $nextIsBaseAffected) {
                $base = $this->recomputeBase($base, $inclFixed, $inclPercent, $inclDivision);
                $inclFixed = $zero;
                $inclPercent = $zero;
                $inclDivision = $zero;
                $storeCheckpoint = true;
            }

            if ($tax->priceInclude) {
                $amount = Decimal::of($tax->amount);
                if ($tax->amountType === TaxDefinition::PERCENT) {
                    $inclPercent = $inclPercent->add($amount->mul($factor));
                } elseif ($tax->amountType === TaxDefinition::DIVISION) {
                    $inclDivision = $inclDivision->add($amount->mul($factor));
                } elseif ($tax->amountType === TaxDefinition::FIXED) {
                    $inclFixed = $inclFixed->add($absQuantity->mul($amount)->mul($factor));
                }
                if ($storeCheckpoint && ! $amount->isZero()) {
                    $checkpoint[$i] = $base;
                    $storeCheckpoint = false;
                }
            }

            $nextIsBaseAffected = $tax->isBaseAffected;
        }

        $totalExcluded = $roundLine($this->recomputeBase($base, $inclFixed, $inclPercent, $inclDivision));

        // §7.5 — ascending pass
        $base = $totalExcluded;
        $totalIncluded = $totalExcluded;
        $cumulatedIncluded = $zero;
        /** @var list<TaxComputationEntry> $entries */
        $entries = [];

        for ($i = 0; $i < $n; $i++) {
            $tax = $flat[$i];
            $factor = $tax->hasNegativeFactor ? $minusOne : $one;
            $taxBase = ($tax->priceInclude || $tax->isBaseAffected) ? $base : $totalExcluded;

            $hadCheckpoint = false;
            if ($tax->priceInclude && isset($checkpoint[$i])) {
                $amount = $checkpoint[$i]->sub($base->add($cumulatedIncluded));
                $cumulatedIncluded = $zero;
                $hadCheckpoint = true;
            } else {
                $amount = $this->taxAmountExcluded($tax, $taxBase, $absQuantity);
            }

            $amount = $roundLine($amount);
            $amount = $roundLine($amount->mul($factor));

            if ($tax->priceInclude && ! $hadCheckpoint) {
                $cumulatedIncluded = $cumulatedIncluded->add($amount);
            }

            $entries[] = new TaxComputationEntry($tax->id, $tax->taxGroupId, $taxBase, $amount);

            if ($tax->includeBaseAmount) {
                $base = $base->add($amount);
                $cumulatedIncluded = $zero;
            }

            $totalIncluded = $totalIncluded->add($amount);
        }

        // §7.7
        return new TaxComputation(
            $line->id,
            $priceUnit,
            $totalExcluded->mul($outSign),
            $totalIncluded->mul($outSign),
            \array_map(static fn (TaxComputationEntry $e): TaxComputationEntry => $e->withSign($outSign), $entries),
        );
    }

    /** §7.4.4 */
    private function recomputeBase(Decimal $base, Decimal $fixed, Decimal $percent, Decimal $division): Decimal
    {
        $hundred = Decimal::hundred();
        $t = $base->sub($fixed);
        $t = $t->div(
            Decimal::one()->add($percent->div($hundred, Decimal::MAX_SCALE, RoundingMode::HalfUp)),
            Decimal::MAX_SCALE,
            RoundingMode::HalfUp,
        );
        $t = $t->mul($hundred->sub($division));

        return $t->div($hundred, Decimal::MAX_SCALE, RoundingMode::HalfUp);
    }

    /** §7.5.3 — always the tax-EXCLUDED formula. */
    private function taxAmountExcluded(TaxDefinition $tax, Decimal $base, Decimal $absQuantity): Decimal
    {
        $hundred = Decimal::hundred();
        $amount = Decimal::of($tax->amount);

        return match ($tax->amountType) {
            TaxDefinition::PERCENT => $base->mul($amount)->div($hundred, Decimal::MAX_SCALE, RoundingMode::HalfUp),
            TaxDefinition::FIXED => $absQuantity->mul($amount),
            TaxDefinition::DIVISION => $this->divisionAmount($tax, $base, $amount),
            default => throw new DomainException(
                \sprintf('amountType "%s" must have been flattened away', $tax->amountType),
            ),
        };
    }

    private function divisionAmount(TaxDefinition $tax, Decimal $base, Decimal $amount): Decimal
    {
        $denominator = Decimal::one()->sub(
            $amount->div(Decimal::hundred(), Decimal::MAX_SCALE, RoundingMode::HalfUp),
        );
        if ($denominator->isZero()) {
            throw new DomainException(\sprintf('division tax %d with amount 100 is not computable', $tax->id));
        }

        return $base->div($denominator, Decimal::MAX_SCALE, RoundingMode::HalfUp)->sub($base);
    }

    /**
     * §8.2
     *
     * @param  list<TaxComputation>  $lines
     * @return array{totalExcluded: Decimal, totalTax: Decimal, totalIncluded: Decimal, taxGroups: list<array{taxGroupId: int, base: Decimal, amount: Decimal}>}
     */
    private function aggregatePerLine(array $lines): array
    {
        $totalExcluded = Decimal::zero();
        foreach ($lines as $line) {
            $totalExcluded = $totalExcluded->add($line->rawExcluded);
        }
        $totalTax = Decimal::zero();
        foreach ($lines as $line) {
            foreach ($line->entries as $entry) {
                $totalTax = $totalTax->add($entry->amount);
            }
        }

        /** @var array<int, array{base: Decimal, amount: Decimal}> $groups */
        $groups = [];
        foreach ($lines as $line) {
            foreach ($line->entries as $entry) {
                $current = $groups[$entry->taxGroupId] ?? ['base' => Decimal::zero(), 'amount' => Decimal::zero()];
                $groups[$entry->taxGroupId] = [
                    'base' => $current['base']->add($entry->base),
                    'amount' => $current['amount']->add($entry->amount),
                ];
            }
        }
        \ksort($groups);

        $taxGroups = [];
        foreach ($groups as $taxGroupId => $group) {
            $taxGroups[] = ['taxGroupId' => $taxGroupId, 'base' => $group['base'], 'amount' => $group['amount']];
        }

        return [
            'totalExcluded' => $totalExcluded,
            'totalTax' => $totalTax,
            'totalIncluded' => $totalExcluded->add($totalTax),
            'taxGroups' => $taxGroups,
        ];
    }

    /**
     * §8.3
     *
     * @param  list<TaxComputation>  $lines
     * @return array{totalExcluded: Decimal, totalTax: Decimal, totalIncluded: Decimal, taxGroups: list<array{taxGroupId: int, base: Decimal, amount: Decimal}>}
     */
    private function aggregateGlobally(array $lines, CurrencyRounder $rounder): array
    {
        $rawExcluded = Decimal::zero();
        foreach ($lines as $line) {
            $rawExcluded = $rawExcluded->add($line->rawExcluded);
        }

        /** @var array<int, array{base: Decimal, amount: Decimal, taxGroupId: int}> $perTax */
        $perTax = [];
        /** @var list<int> $taxOrder */
        $taxOrder = [];
        foreach ($lines as $line) {
            foreach ($line->entries as $entry) {
                if (! isset($perTax[$entry->taxId])) {
                    $taxOrder[] = $entry->taxId;
                    $perTax[$entry->taxId] = [
                        'base' => $entry->base,
                        'amount' => $entry->amount,
                        'taxGroupId' => $entry->taxGroupId,
                    ];
                } else {
                    $perTax[$entry->taxId] = [
                        'base' => $perTax[$entry->taxId]['base']->add($entry->base),
                        'amount' => $perTax[$entry->taxId]['amount']->add($entry->amount),
                        'taxGroupId' => $perTax[$entry->taxId]['taxGroupId'],
                    ];
                }
            }
        }

        $totalExcluded = $rounder->round($rawExcluded);
        $totalTax = Decimal::zero();
        foreach ($taxOrder as $taxId) {
            $totalTax = $totalTax->add($rounder->round($perTax[$taxId]['amount']));
        }

        /** @var array<int, array{base: Decimal, amount: Decimal}> $groups */
        $groups = [];
        foreach ($taxOrder as $taxId) {
            $tax = $perTax[$taxId];
            $current = $groups[$tax['taxGroupId']] ?? ['base' => Decimal::zero(), 'amount' => Decimal::zero()];
            $groups[$tax['taxGroupId']] = [
                'base' => $current['base']->add($tax['base']),
                'amount' => $current['amount']->add($tax['amount']),
            ];
        }
        \ksort($groups);

        $taxGroups = [];
        foreach ($groups as $taxGroupId => $group) {
            $taxGroups[] = [
                'taxGroupId' => $taxGroupId,
                'base' => $rounder->round($group['base']),
                'amount' => $rounder->round($group['amount']),
            ];
        }

        return [
            'totalExcluded' => $totalExcluded,
            'totalTax' => $totalTax,
            'totalIncluded' => $totalExcluded->add($totalTax),
            'taxGroups' => $taxGroups,
        ];
    }
}
