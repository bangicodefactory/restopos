import { Decimal, HUNDRED, PRICE_SCALE, MAX_SCALE } from '../money/decimal';
import { HALF_UP } from '../money/rounding';

/** §10.5 */
export const MAX_PRICELIST_DEPTH = 5;

export type PricelistAppliedOn = 'variant' | 'product' | 'pos_category' | 'global';
export type PricelistComputePrice = 'fixed' | 'percentage' | 'formula';
export type PricelistBase = 'list_price' | 'standard_price' | 'pricelist';

/** Mirrors `pricelist_items` — docs/spec/01-schema.md §2.C. */
export type PricelistItem = {
    readonly id: number;
    readonly appliedOn?: PricelistAppliedOn;
    readonly productVariantId?: number | null;
    readonly productId?: number | null;
    readonly posCategoryId?: number | null;
    readonly minQuantity?: string;
    readonly dateStart?: string | null;
    readonly dateEnd?: string | null;
    readonly computePrice?: PricelistComputePrice;
    readonly fixedPrice?: string;
    readonly percentPrice?: string;
    readonly base?: PricelistBase;
    readonly basePricelistId?: number | null;
    readonly priceDiscount?: string;
    readonly priceSurcharge?: string;
    readonly priceRound?: string;
    readonly priceMinMargin?: string;
    readonly priceMaxMargin?: string;
    readonly sequence?: number;
    readonly active?: boolean;
};

export type Pricelist = {
    readonly id: number;
    readonly items: readonly PricelistItem[];
};

/** §10.1 */
export type PricelistContext = {
    readonly variantId?: number | null;
    readonly productId?: number | null;
    readonly categoryId?: number | null;
    readonly categoryAncestry?: readonly number[];
    readonly listPrice: string;
    readonly standardPrice?: string;
    readonly priceExtra?: string;
    readonly quantity: string;
    /** ISO-8601; compared lexically, so always pass a zero-padded, same-offset string. */
    readonly date?: string | null;
    /** §10.7 — `manual` / `automatic` lines are never repriced. */
    readonly priceType?: 'original' | 'manual' | 'automatic';
};

type Candidate = { rank: number; item: PricelistItem };

/**
 * §10 — pricelist rule resolution. Mirrors `app/Support/Pricing/PricelistResolver.php`.
 */
export class PricelistResolver {
    constructor(private readonly pricelists: ReadonlyMap<number, Pricelist>) {}

    static fromArray(pricelists: readonly Pricelist[]): PricelistResolver {
        return new PricelistResolver(new Map(pricelists.map((p) => [p.id, p])));
    }

    /** Returns the resolved unit price rendered at PRICE_SCALE (§10.6.4). */
    resolve(pricelistId: number, context: PricelistContext, rate: string = '1'): string {
        return this.resolveDecimal(pricelistId, context, rate).withScale(PRICE_SCALE, HALF_UP).toString();
    }

    resolveDecimal(pricelistId: number, context: PricelistContext, rate: string = '1'): Decimal {
        const priceType = context.priceType ?? 'original';
        if (priceType !== 'original') {
            // §10.7 — never reprice a manual or barcode-embedded price.
            return this.basePrice(context).mul(Decimal.of(rate));
        }
        const price = this.resolveIn(pricelistId, context, 0, new Set<number>());
        return price.mul(Decimal.of(rate));
    }

    private basePrice(context: PricelistContext): Decimal {
        return Decimal.of(context.listPrice).add(Decimal.of(context.priceExtra ?? '0'));
    }

    private resolveIn(
        pricelistId: number,
        context: PricelistContext,
        depth: number,
        stack: ReadonlySet<number>,
    ): Decimal {
        if (depth > MAX_PRICELIST_DEPTH) {
            throw new Error(`pricelist base recursion exceeds ${MAX_PRICELIST_DEPTH}`);
        }
        if (stack.has(pricelistId)) {
            throw new Error(`cyclic pricelist base at ${pricelistId}`);
        }
        const pricelist = this.pricelists.get(pricelistId);
        if (!pricelist) {
            throw new Error(`unknown pricelist ${pricelistId}`);
        }
        const item = this.pick(pricelist.items, context);
        if (!item) {
            return this.basePrice(context);
        }

        // §10.5 — base price
        let price: Decimal;
        const base = item.base ?? 'list_price';
        if (base === 'list_price') {
            price = this.basePrice(context);
        } else if (base === 'standard_price') {
            price = Decimal.of(context.standardPrice ?? '0');
        } else {
            const basePricelistId = item.basePricelistId ?? null;
            price =
                basePricelistId === null
                    ? this.basePrice(context)
                    : this.resolveIn(basePricelistId, context, depth + 1, new Set([...stack, pricelistId]));
        }

        // §10.6 — computation
        const computePrice = item.computePrice ?? 'fixed';
        if (computePrice === 'fixed') {
            return Decimal.of(item.fixedPrice ?? '0');
        }
        if (computePrice === 'percentage') {
            return price.sub(price.mul(Decimal.of(item.percentPrice ?? '0')).div(HUNDRED, MAX_SCALE, HALF_UP));
        }

        const priceLimit = price;
        price = price.sub(price.mul(Decimal.of(item.priceDiscount ?? '0')).div(HUNDRED, MAX_SCALE, HALF_UP));
        const priceRound = Decimal.of(item.priceRound ?? '0');
        if (!priceRound.isZero()) {
            price = price.roundToStep(priceRound, HALF_UP);
        }
        price = price.add(Decimal.of(item.priceSurcharge ?? '0'));
        const minMargin = Decimal.of(item.priceMinMargin ?? '0');
        if (!minMargin.isZero()) {
            const floor = priceLimit.add(minMargin);
            if (price.lt(floor)) {
                price = floor;
            }
        }
        const maxMargin = Decimal.of(item.priceMaxMargin ?? '0');
        if (!maxMargin.isZero()) {
            const cap = priceLimit.add(maxMargin);
            if (price.gt(cap)) {
                price = cap;
            }
        }
        return price;
    }

    /** §10.2 to §10.4 */
    private pick(items: readonly PricelistItem[], context: PricelistContext): PricelistItem | null {
        const quantity = Decimal.of(context.quantity);
        const ancestry = context.categoryAncestry ?? [];
        const candidates: Candidate[] = [];

        for (const item of items) {
            if (item.active === false) {
                continue;
            }
            const date = context.date ?? null;
            if (date !== null) {
                if (item.dateStart && item.dateStart > date) continue;
                if (item.dateEnd && date > item.dateEnd) continue;
            }
            if (Decimal.of(item.minQuantity ?? '0').gt(quantity)) {
                continue;
            }
            const appliedOn = item.appliedOn ?? 'global';
            let rank: number;
            if (appliedOn === 'variant') {
                if ((item.productVariantId ?? null) !== (context.variantId ?? null)) continue;
                rank = 0;
            } else if (appliedOn === 'product') {
                if ((item.productId ?? null) !== (context.productId ?? null)) continue;
                rank = 1;
            } else if (appliedOn === 'pos_category') {
                const index = ancestry.indexOf(item.posCategoryId ?? -1);
                if (index === -1) continue;
                rank = 2 + index;
            } else {
                rank = 2 + 1000;
            }
            candidates.push({ rank, item });
        }

        if (candidates.length === 0) {
            return null;
        }
        candidates.sort((a, b) => {
            if (a.rank !== b.rank) return a.rank - b.rank;
            const qty = Decimal.of(b.item.minQuantity ?? '0').compare(Decimal.of(a.item.minQuantity ?? '0'));
            if (qty !== 0) return qty;
            const seqA = a.item.sequence ?? 10;
            const seqB = b.item.sequence ?? 10;
            if (seqA !== seqB) return seqA - seqB;
            return a.item.id - b.item.id;
        });
        return candidates[0]!.item;
    }
}
