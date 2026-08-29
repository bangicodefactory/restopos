import type { ProductRow, ProductVariantRow } from '@domain/types';
import { ApiError, browserOnline, type ApiClient } from '@shared/sync';

import { defaultVariantsByProduct, groupVariantsByProduct, indexBarcodes } from './barcode-index';

/**
 * The register's lazy product lookup (REG-071, BAN-421).
 *
 * `GET /api/pos/products` shipped, was routed, documented and server-tested — and no client had
 * ever called it. The register preloads a capped slice of the catalogue (`limited_product_count`),
 * so a product that exists but has not reached this device was indistinguishable from one that does
 * not exist: the scan simply fell into the search box.
 *
 * Nothing here writes to Dexie or to the catalog index. It returns plain data and the caller decides
 * what to do with it — the same split as `order-lookup.ts`, and what makes this testable with a fake
 * `ApiClient` and no database.
 *
 * ## Why the answer is re-checked locally
 *
 * The endpoint's `search=` is a **substring** match over name, reference and barcode. That is right
 * for a cashier typing "marg", and wrong for a scan: scanning a short code would match every product
 * whose name happens to contain those digits, and adding the first row to the sale would put the
 * wrong item on a customer's bill. So the server narrows, and this module decides — a returned row
 * only counts when its barcode is *equal* to one of the scanned candidates.
 */

export type ProductLookupPage = {
    records: ProductRow[];
    variants: ProductVariantRow[];
    next_cursor: string | null;
    total: number;
};

export type BarcodeLookup =
    /** Exactly one product/variant carries this barcode. `page` is what to cache. */
    | { kind: 'found'; variant: ProductVariantRow; page: ProductLookupPage }
    /** The server answered and nothing carries this barcode. */
    | { kind: 'missing' }
    /** No network. Distinct from `missing`: it is not a statement about the catalogue. */
    | { kind: 'offline' };

export const LOOKUP_PAGE_SIZE = 20;

function pageOf(data: Partial<ProductLookupPage> | null): ProductLookupPage {
    return {
        records: data?.records ?? [],
        variants: data?.variants ?? [],
        next_cursor: data?.next_cursor ?? null,
        total: data?.total ?? 0,
    };
}

/** One page of the lazy search endpoint. Used for a scan and, later, for catalogue paging. */
export async function fetchProducts(
    api: ApiClient,
    query: { search?: string | null; categoryId?: number | null; cursor?: string | null; limit?: number | null } = {},
): Promise<ProductLookupPage> {
    const response = await api.get<ProductLookupPage>('pos/products', {
        query: {
            search: query.search ?? null,
            category_id: query.categoryId ?? null,
            cursor: query.cursor ?? null,
            limit: query.limit ?? LOOKUP_PAGE_SIZE,
        },
    });

    return pageOf(response.data);
}

/**
 * Ask the server which product carries one of these barcodes.
 *
 * `codes` is the scan's code plus the parser's alternates (UPC↔EAN, zero-padded GTIN) — the same
 * list `routeScan` tries against the local index, in the same order, so a lookup that reaches the
 * server cannot resolve to a different product than one that did not have to.
 *
 * Offline is answered **without a request**. `navigator.onLine` is advisory and a lying `true` still
 * ends up here through `ApiError`, but a lying `false` is rare and the round trip it saves is the
 * one a cashier is standing through.
 */
export async function lookupBarcode(api: ApiClient, codes: readonly string[]): Promise<BarcodeLookup> {
    const candidates = [...new Set(codes.map((code) => code.trim()).filter((code) => code !== ''))];
    if (candidates.length === 0) return { kind: 'missing' };

    if (!browserOnline()) return { kind: 'offline' };

    for (const code of candidates) {
        let page: ProductLookupPage;

        try {
            page = await fetchProducts(api, { search: code });
        } catch (error) {
            if (error instanceof ApiError && error.sync.kind === 'offline') return { kind: 'offline' };
            throw error;
        }

        const variant = exactMatch(page, candidates);
        if (variant) return { kind: 'found', variant, page };
    }

    return { kind: 'missing' };
}

/**
 * The variant a page exactly matches, or null.
 *
 * Built through the same `indexBarcodes` rule the local catalogue uses, so "which variant does this
 * code mean" has one definition rather than one per lookup path.
 */
export function exactMatch(page: ProductLookupPage, candidates: readonly string[]): ProductVariantRow | null {
    const byProduct = groupVariantsByProduct(page.variants);
    const index = indexBarcodes(page.records, page.variants, defaultVariantsByProduct(byProduct));

    for (const code of candidates) {
        const hit = index.get(code);
        if (hit) return hit;
    }

    return null;
}
