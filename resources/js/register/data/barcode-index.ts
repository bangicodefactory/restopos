import type { ProductRow, ProductVariantRow } from '@domain/types';

/**
 * What a barcode maps to — defined once (REG-071, REG-080).
 *
 * This rule was written out three times: in `catalog-load.ts` (the real index), in the domain
 * test fixture, and it was about to be written a fourth time for the lazy scan-miss fetch. Three
 * copies of "which variant does this code mean" is three chances for the server lookup and the
 * local lookup to disagree about the same scan, which is the one place they must not.
 *
 * The rule itself, in order:
 *
 *  1. a **variant** barcode wins, always — it is the SKU actually being sold;
 *  2. a **product** barcode resolves to that product's default variant, and only if no variant has
 *     already claimed the code.
 *
 * "Default variant" is the first sellable combination, falling back to the first variant at all —
 * a product whose combinations are all archived still has to be scannable, or an inventory mistake
 * silently becomes an unsellable product.
 */

export function groupVariantsByProduct(
    variants: readonly ProductVariantRow[],
): Map<number, ProductVariantRow[]> {
    const out = new Map<number, ProductVariantRow[]>();

    for (const variant of variants) {
        const bucket = out.get(variant.product_id);
        if (bucket) bucket.push(variant);
        else out.set(variant.product_id, [variant]);
    }

    return out;
}

export function defaultVariantsByProduct(
    variantsByProduct: ReadonlyMap<number, readonly ProductVariantRow[]>,
): Map<number, ProductVariantRow> {
    const out = new Map<number, ProductVariantRow>();

    for (const [productId, list] of variantsByProduct) {
        const first = list.filter((v) => v.active && v.is_active_combination)[0] ?? list[0];
        if (first) out.set(productId, first);
    }

    return out;
}

/**
 * Fold products and variants into the barcode index.
 *
 * `into` is mutated and returned so an incremental insert can extend the existing index without
 * rebuilding it. Pass a fresh `Map` for a full build.
 */
export function indexBarcodes(
    products: readonly ProductRow[],
    variants: readonly ProductVariantRow[],
    defaultVariantByProduct: ReadonlyMap<number, ProductVariantRow>,
    into: Map<string, ProductVariantRow> = new Map(),
): Map<string, ProductVariantRow> {
    for (const variant of variants) {
        if (variant.barcode) into.set(variant.barcode, variant);
    }

    for (const product of products) {
        if (!product.barcode) continue;
        const variant = defaultVariantByProduct.get(product.id);
        if (variant && !into.has(product.barcode)) into.set(product.barcode, variant);
    }

    return into;
}
