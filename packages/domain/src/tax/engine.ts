import { Decimal, HUNDRED, MINUS_ONE, ONE, PRICE_SCALE, ZERO, MAX_SCALE } from '../money/decimal';
import { HALF_UP } from '../money/rounding';
import { mapTaxes } from './fiscal-position';
import { CashRoundingCalculator, CurrencyRounder } from './rounder';
import type {
    LineInput,
    LineResult,
    LineTaxResult,
    OrderInput,
    OrderResult,
    TaxDefinition,
    TaxGroupResult,
} from './types';

/** §6.4 */
export const MAX_GROUP_DEPTH = 5;

type TaxEntry = {
    readonly taxId: number;
    readonly taxGroupId: number;
    readonly base: Decimal;
    readonly amount: Decimal;
};

type ComputedLine = {
    readonly id: string;
    readonly priceUnit: Decimal;
    /** signed, unrounded under round_globally */
    readonly rawExcluded: Decimal;
    readonly rawIncluded: Decimal;
    readonly entries: readonly TaxEntry[];
};

/** §6 — resolve, order and flatten the tax stack of one line. */
export function flattenTaxes(
    taxIds: readonly number[],
    catalog: ReadonlyMap<number, TaxDefinition>,
): TaxDefinition[] {
    const resolve = (ids: readonly number[], depth: number, stack: ReadonlySet<number>): TaxDefinition[] => {
        if (depth > MAX_GROUP_DEPTH) {
            throw new Error(`tax group nesting exceeds ${MAX_GROUP_DEPTH}`);
        }
        const taxes: TaxDefinition[] = [];
        for (const id of ids) {
            const tax = catalog.get(id);
            if (!tax) {
                throw new Error(`unknown tax id ${id}`);
            }
            taxes.push(tax);
        }
        taxes.sort(bySequenceThenId);
        const out: TaxDefinition[] = [];
        for (const tax of taxes) {
            if (tax.amountType === 'group') {
                if (stack.has(tax.id)) {
                    throw new Error(`cyclic tax group ${tax.id}`);
                }
                out.push(...resolve(tax.childrenTaxIds ?? [], depth + 1, new Set([...stack, tax.id])));
            } else {
                out.push(tax);
            }
        }
        return out;
    };

    const flat = resolve(taxIds, 0, new Set<number>());
    const seen = new Set<number>();
    const deduped: TaxDefinition[] = [];
    for (const tax of flat) {
        if (!seen.has(tax.id)) {
            seen.add(tax.id);
            deduped.push(tax);
        }
    }
    deduped.sort(bySequenceThenId);
    return deduped;
}

function bySequenceThenId(a: TaxDefinition, b: TaxDefinition): number {
    return a.sequence !== b.sequence ? a.sequence - b.sequence : a.id - b.id;
}

/** §7.4.4 */
function recomputeBase(b: Decimal, fixed: Decimal, percent: Decimal, division: Decimal): Decimal {
    let t = b.sub(fixed);
    t = t.div(ONE.add(percent.div(HUNDRED)), MAX_SCALE, HALF_UP);
    t = t.mul(HUNDRED.sub(division));
    t = t.div(HUNDRED, MAX_SCALE, HALF_UP);
    return t;
}

/** §7.5.3 — always the tax-EXCLUDED formula. */
function taxAmountExcluded(tax: TaxDefinition, base: Decimal, absQuantity: Decimal): Decimal {
    const amount = Decimal.of(tax.amount);
    switch (tax.amountType) {
        case 'percent':
            return base.mul(amount).div(HUNDRED, MAX_SCALE, HALF_UP);
        case 'fixed':
            return absQuantity.mul(amount);
        case 'division': {
            const denominator = ONE.sub(amount.div(HUNDRED, MAX_SCALE, HALF_UP));
            if (denominator.isZero()) {
                throw new Error(`division tax ${tax.id} with amount 100 is not computable`);
            }
            return base.div(denominator, MAX_SCALE, HALF_UP).sub(base);
        }
        default:
            throw new Error(`amountType "${tax.amountType}" must have been flattened away`);
    }
}

/**
 * The pricing/tax engine — docs/spec/04-tax-engine.md §5 to §9.
 *
 * Framework-free and dependency-free. Mirrors `app/Support/Tax/TaxEngine.php` step for step;
 * the two are pinned together by `tests/fixtures/tax/*.json`.
 */
export class TaxEngine {
    compute(order: OrderInput): OrderResult {
        const rounder = new CurrencyRounder(order.currency);
        const perLine = (order.roundingMethod ?? 'round_per_line') === 'round_per_line';
        const catalog = new Map<number, TaxDefinition>();
        for (const tax of order.taxes) {
            catalog.set(tax.id, tax);
        }
        const documentSign = Decimal.of(order.documentSign ?? '1');

        const computed: ComputedLine[] = order.lines.map((line) => {
            const ids = mapTaxes(line.taxIds ?? [], order.fiscalPosition);
            return this.computeLine(line, flattenTaxes(ids, catalog), rounder, perLine, documentSign);
        });

        const lines: LineResult[] = computed.map((line) => ({
            id: line.id,
            priceUnit: line.priceUnit.withScale(PRICE_SCALE, HALF_UP).toString(),
            priceSubtotal: rounder.format(perLine ? line.rawExcluded : rounder.round(line.rawExcluded)),
            priceTotal: rounder.format(perLine ? line.rawIncluded : rounder.round(line.rawIncluded)),
            taxes: line.entries.map(
                (entry): LineTaxResult => ({
                    taxId: entry.taxId,
                    base: rounder.format(perLine ? entry.base : rounder.round(entry.base)),
                    amount: rounder.format(perLine ? entry.amount : rounder.round(entry.amount)),
                }),
            ),
        }));

        const aggregate = perLine
            ? aggregatePerLine(computed)
            : aggregateGlobally(computed, rounder);

        let { totalExcluded, totalTax, totalIncluded, taxGroups } = aggregate;

        // §9
        let roundedTotal = totalIncluded;
        let roundingDelta = ZERO;
        if (order.cashRounding) {
            const calculator = new CashRoundingCalculator(order.cashRounding);
            const applied = calculator.apply(totalIncluded);
            roundedTotal = applied.roundedTotal;
            roundingDelta = applied.delta;
            if (calculator.strategy === 'biggest_tax' && taxGroups.length > 0) {
                let best = 0;
                for (let i = 1; i < taxGroups.length; i++) {
                    if (taxGroups[i]!.amount.abs().gt(taxGroups[best]!.amount.abs())) {
                        best = i;
                    }
                }
                taxGroups = taxGroups.map((group, i) =>
                    i === best ? { ...group, amount: group.amount.add(roundingDelta) } : group,
                );
                totalTax = totalTax.add(roundingDelta);
                totalIncluded = roundedTotal;
            }
        }

        return {
            lines,
            totals: {
                totalExcluded: rounder.format(totalExcluded),
                totalTax: rounder.format(totalTax),
                totalIncluded: rounder.format(totalIncluded),
                roundedTotal: rounder.format(roundedTotal),
                roundingDelta: rounder.format(roundingDelta),
                taxGroups: taxGroups.map(
                    (group): TaxGroupResult => ({
                        taxGroupId: group.taxGroupId,
                        base: rounder.format(group.base),
                        amount: rounder.format(group.amount),
                    }),
                ),
            },
        };
    }

    /** §7 */
    private computeLine(
        line: LineInput,
        flat: readonly TaxDefinition[],
        rounder: CurrencyRounder,
        perLine: boolean,
        documentSign: Decimal,
    ): ComputedLine {
        const roundLine = (value: Decimal): Decimal => (perLine ? rounder.round(value) : value);

        const priceUnit = Decimal.of(line.priceUnit);
        const quantity = Decimal.of(line.quantity);
        const discount = Decimal.of(line.discount ?? '0');

        // §7.2
        const discountFactor = ONE.sub(discount.div(HUNDRED, MAX_SCALE, HALF_UP));
        const priceAfterDiscount = priceUnit.mul(discountFactor);
        const lineAmount = roundLine(priceAfterDiscount.mul(quantity));

        // §7.3
        const naturalSign = lineAmount.signum() < 0 ? MINUS_ONE : ONE;
        const lineSign = Decimal.of(line.sign ?? '1');
        const outSign = documentSign.mul(lineSign).mul(naturalSign);
        const magnitude = lineAmount.abs();
        const absQuantity = quantity.abs();

        const n = flat.length;

        // §7.4 — descending pass
        let base = magnitude;
        let inclFixed = ZERO;
        let inclPercent = ZERO;
        let inclDivision = ZERO;
        const checkpoint = new Map<number, Decimal>();
        let storeCheckpoint = true;
        let nextIsBaseAffected = true;

        for (let i = n - 1; i >= 0; i--) {
            const tax = flat[i]!;
            const factor = tax.hasNegativeFactor ? MINUS_ONE : ONE;

            if (tax.includeBaseAmount && nextIsBaseAffected) {
                base = recomputeBase(base, inclFixed, inclPercent, inclDivision);
                inclFixed = ZERO;
                inclPercent = ZERO;
                inclDivision = ZERO;
                storeCheckpoint = true;
            }

            if (tax.priceInclude) {
                const amount = Decimal.of(tax.amount);
                if (tax.amountType === 'percent') {
                    inclPercent = inclPercent.add(amount.mul(factor));
                } else if (tax.amountType === 'division') {
                    inclDivision = inclDivision.add(amount.mul(factor));
                } else if (tax.amountType === 'fixed') {
                    inclFixed = inclFixed.add(absQuantity.mul(amount).mul(factor));
                }
                if (storeCheckpoint && !amount.isZero()) {
                    checkpoint.set(i, base);
                    storeCheckpoint = false;
                }
            }

            nextIsBaseAffected = tax.isBaseAffected ?? true;
        }

        const totalExcluded = roundLine(recomputeBase(base, inclFixed, inclPercent, inclDivision));

        // §7.5 — ascending pass
        base = totalExcluded;
        let totalIncluded = totalExcluded;
        let cumulatedIncluded = ZERO;
        const entries: TaxEntry[] = [];

        for (let i = 0; i < n; i++) {
            const tax = flat[i]!;
            const factor = tax.hasNegativeFactor ? MINUS_ONE : ONE;
            const isBaseAffected = tax.isBaseAffected ?? true;
            const taxBase = tax.priceInclude || isBaseAffected ? base : totalExcluded;

            let amount: Decimal;
            let hadCheckpoint = false;
            const stored = checkpoint.get(i);
            if (tax.priceInclude && stored !== undefined) {
                amount = stored.sub(base.add(cumulatedIncluded));
                cumulatedIncluded = ZERO;
                hadCheckpoint = true;
            } else {
                amount = taxAmountExcluded(tax, taxBase, absQuantity);
            }

            amount = roundLine(amount);
            amount = roundLine(amount.mul(factor));

            if (tax.priceInclude && !hadCheckpoint) {
                cumulatedIncluded = cumulatedIncluded.add(amount);
            }

            entries.push({ taxId: tax.id, taxGroupId: tax.taxGroupId, base: taxBase, amount });

            if (tax.includeBaseAmount) {
                base = base.add(amount);
                cumulatedIncluded = ZERO;
            }

            totalIncluded = totalIncluded.add(amount);
        }

        // §7.7
        return {
            id: line.id,
            priceUnit,
            rawExcluded: totalExcluded.mul(outSign),
            rawIncluded: totalIncluded.mul(outSign),
            entries: entries.map((entry) => ({
                taxId: entry.taxId,
                taxGroupId: entry.taxGroupId,
                base: entry.base.mul(outSign),
                amount: entry.amount.mul(outSign),
            })),
        };
    }
}

type Aggregate = {
    totalExcluded: Decimal;
    totalTax: Decimal;
    totalIncluded: Decimal;
    taxGroups: { taxGroupId: number; base: Decimal; amount: Decimal }[];
};

/** §8.2 */
function aggregatePerLine(lines: readonly ComputedLine[]): Aggregate {
    let totalExcluded = ZERO;
    for (const line of lines) {
        totalExcluded = totalExcluded.add(line.rawExcluded);
    }
    let totalTax = ZERO;
    for (const line of lines) {
        for (const entry of line.entries) {
            totalTax = totalTax.add(entry.amount);
        }
    }
    const groups = new Map<number, { base: Decimal; amount: Decimal }>();
    for (const line of lines) {
        for (const entry of line.entries) {
            const current = groups.get(entry.taxGroupId) ?? { base: ZERO, amount: ZERO };
            groups.set(entry.taxGroupId, {
                base: current.base.add(entry.base),
                amount: current.amount.add(entry.amount),
            });
        }
    }
    return {
        totalExcluded,
        totalTax,
        totalIncluded: totalExcluded.add(totalTax),
        taxGroups: [...groups.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([taxGroupId, v]) => ({ taxGroupId, base: v.base, amount: v.amount })),
    };
}

/** §8.3 */
function aggregateGlobally(lines: readonly ComputedLine[], rounder: CurrencyRounder): Aggregate {
    let rawExcluded = ZERO;
    for (const line of lines) {
        rawExcluded = rawExcluded.add(line.rawExcluded);
    }

    const perTax = new Map<number, { base: Decimal; amount: Decimal; taxGroupId: number }>();
    const taxOrder: number[] = [];
    for (const line of lines) {
        for (const entry of line.entries) {
            const current = perTax.get(entry.taxId);
            if (!current) {
                taxOrder.push(entry.taxId);
                perTax.set(entry.taxId, {
                    base: entry.base,
                    amount: entry.amount,
                    taxGroupId: entry.taxGroupId,
                });
            } else {
                perTax.set(entry.taxId, {
                    base: current.base.add(entry.base),
                    amount: current.amount.add(entry.amount),
                    taxGroupId: current.taxGroupId,
                });
            }
        }
    }

    const totalExcluded = rounder.round(rawExcluded);
    let totalTax = ZERO;
    for (const taxId of taxOrder) {
        totalTax = totalTax.add(rounder.round(perTax.get(taxId)!.amount));
    }

    const groups = new Map<number, { base: Decimal; amount: Decimal }>();
    for (const taxId of taxOrder) {
        const tax = perTax.get(taxId)!;
        const current = groups.get(tax.taxGroupId) ?? { base: ZERO, amount: ZERO };
        groups.set(tax.taxGroupId, {
            base: current.base.add(tax.base),
            amount: current.amount.add(tax.amount),
        });
    }

    return {
        totalExcluded,
        totalTax,
        totalIncluded: totalExcluded.add(totalTax),
        taxGroups: [...groups.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([taxGroupId, v]) => ({
                taxGroupId,
                base: rounder.round(v.base),
                amount: rounder.round(v.amount),
            })),
    };
}

/** Convenience wrapper — one engine instance is stateless and safe to share. */
export const taxEngine = new TaxEngine();

export function computeOrderTaxes(order: OrderInput): OrderResult {
    return taxEngine.compute(order);
}
