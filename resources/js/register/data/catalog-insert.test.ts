import { describe, expect, it } from 'vitest';

import { buildCatalog, makeCategory, makeProduct, makeVariant } from '../domain/__fixtures__/catalog';
import { nextCatalogVersion } from './catalog';
import { insertCatalogProducts } from './catalog-load';

/**
 * BAN-421 — folding a lazily fetched product into the live index.
 *
 * `setCatalog` only ever took a whole index, and the only thing that could build one was a full
 * Dexie re-read. That is right for a delta and wrong for a scan miss, which needs to add one product
 * without stalling the till. The interesting cases are all about *replacement*: a code that is
 * already claimed, a variant that already exists, a stale copy left where the default-variant rule
 * can still find it.
 */

const EAN = '5901234123457';

describe('insertCatalogProducts', () => {
    it('makes a fetched product scannable, findable and browsable', () => {
        const base = buildCatalog({ categories: [makeCategory({ id: 5 })] });
        const product = makeProduct({ id: 1, name: 'Coffee', pos_category_ids: [5] });
        const variant = makeVariant({ id: 11, product_id: 1, barcode: EAN });

        const next = insertCatalogProducts(base, { products: [product], variants: [variant] }, 7);

        expect(next.barcodeIndex.get(EAN)?.id).toBe(11);
        expect(next.productsById.get(1)?.name).toBe('Coffee');
        expect(next.variantsById.get(11)?.id).toBe(11);
        // A product you can scan but cannot then find by name or category is the half-wired state
        // this ticket exists to close.
        expect(next.sellable.map((p) => p.id)).toContain(1);
        expect(next.productsByCategory.get(5)?.map((p) => p.id)).toEqual([1]);
        expect(next.version).toBe(7);
    });

    it('leaves the index untouched when there is nothing to add', () => {
        const base = buildCatalog({ products: [makeProduct({ id: 1 })] });

        // Same object, so `version` does not move and no memo keyed on it is invalidated for nothing.
        expect(insertCatalogProducts(base, { products: [], variants: [] }, 9)).toBe(base);
    });

    it('replaces a row it already holds instead of duplicating it', () => {
        const base = buildCatalog({
            products: [makeProduct({ id: 1, name: 'Coffee' })],
            variants: [makeVariant({ id: 11, product_id: 1, barcode: EAN })],
        });

        const next = insertCatalogProducts(
            base,
            {
                products: [makeProduct({ id: 1, name: 'Coffee (fair trade)' })],
                variants: [makeVariant({ id: 11, product_id: 1, barcode: EAN, list_price: '3.50' })],
            },
            2,
        );

        expect(next.products).toHaveLength(1);
        expect(next.variants).toHaveLength(1);
        expect(next.productsById.get(1)?.name).toBe('Coffee (fair trade)');
        expect(next.barcodeIndex.get(EAN)?.list_price).toBe('3.50');
    });

    it('does not leave a stale variant where the default-variant rule can still pick it', () => {
        // The cached copy of variant 11 is archived; the server's copy is live. Appending to the
        // existing per-product bucket rather than regrouping would leave both in it, and
        // `defaultVariantsByProduct` takes the first *sellable* one — which is order-dependent and
        // could be the corpse.
        const stale = makeVariant({ id: 11, product_id: 1, active: false, is_active_combination: false });
        const base = buildCatalog({ products: [makeProduct({ id: 1, barcode: EAN })], variants: [stale] });

        const next = insertCatalogProducts(
            base,
            { products: [], variants: [makeVariant({ id: 11, product_id: 1, display_name: 'Live' })] },
            2,
        );

        expect(next.variantsByProduct.get(1)).toHaveLength(1);
        expect(next.defaultVariantByProduct.get(1)?.display_name).toBe('Live');
    });

    it('does not let an incoming product barcode steal a code a variant already holds', () => {
        const base = buildCatalog({
            products: [makeProduct({ id: 1 })],
            variants: [makeVariant({ id: 11, product_id: 1, barcode: EAN })],
        });

        const next = insertCatalogProducts(
            base,
            {
                products: [makeProduct({ id: 2, barcode: EAN })],
                variants: [makeVariant({ id: 21, product_id: 2 })],
            },
            2,
        );

        // A template barcode is the fallback, never an override: the SKU that carries the code keeps
        // it, exactly as on a full catalogue build.
        expect(next.barcodeIndex.get(EAN)?.id).toBe(11);
    });

    it('honours the config’s category allow-list', () => {
        const base = buildCatalog({
            config: { ...buildCatalog().config!, limit_categories: true, iface_available_categ_ids: [5] },
            categories: [makeCategory({ id: 5 }), makeCategory({ id: 6 })],
        });

        const next = insertCatalogProducts(
            base,
            {
                products: [
                    makeProduct({ id: 1, pos_category_ids: [5] }),
                    makeProduct({ id: 2, pos_category_ids: [6] }),
                ],
                variants: [],
            },
            2,
        );

        // A register limited to the bar must not start listing the kitchen's menu because someone
        // scanned a dish. Scanning it still works — the barcode index is not category-filtered.
        expect(next.sellable.map((p) => p.id)).toEqual([1]);
    });
});

describe('nextCatalogVersion', () => {
    it('never repeats a number across writers', () => {
        // `version` is a memo key. Boot owned a private counter until the lazy insert became a second
        // writer; two indexes sharing a number means the grid keeps rendering the previous one.
        const seen = [nextCatalogVersion(), nextCatalogVersion(), nextCatalogVersion()];

        expect(new Set(seen).size).toBe(3);
        expect(seen[1]).toBeGreaterThan(seen[0]!);
        expect(seen[2]).toBeGreaterThan(seen[1]!);
    });
});
