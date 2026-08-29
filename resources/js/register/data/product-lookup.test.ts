import { ApiError } from '@shared/sync';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeProduct, makeVariant } from '../domain/__fixtures__/catalog';
import { exactMatch, fetchProducts, lookupBarcode, type ProductLookupPage } from './product-lookup';

/**
 * BAN-421 — the lazy barcode lookup against `GET /api/pos/products`.
 *
 * The endpoint shipped, was routed, documented and server-tested, and no client had ever called it.
 * Most of what is asserted here is about *not* trusting what comes back: the endpoint's `search=` is
 * a substring match built for a cashier typing "marg", and a scan needs an exact answer or the wrong
 * item lands on a customer's bill.
 */

afterEach(() => {
    vi.unstubAllGlobals();
});

function page(overrides: Partial<ProductLookupPage> = {}): ProductLookupPage {
    return { records: [], variants: [], next_cursor: null, total: 0, ...overrides };
}

/** A stand-in for ApiClient that records every `search` it was asked for. */
function fakeApi(bySearch: Record<string, ProductLookupPage>): { api: never; searches: string[] } {
    const searches: string[] = [];

    const api = {
        get: (_path: string, options: { query?: { search?: string | null } }) => {
            const search = options.query?.search ?? '';
            searches.push(String(search));
            return Promise.resolve({
                data: bySearch[String(search)] ?? page(),
                status: 200,
                etag: null,
                notModified: false,
            });
        },
    };

    return { api: api as never, searches };
}

describe('fetchProducts', () => {
    it('sends the filters and defaults the page size', async () => {
        const get = vi.fn().mockResolvedValue({ data: page(), status: 200, etag: null, notModified: false });

        await fetchProducts({ get } as never, { search: 'marg', categoryId: 7 });

        expect(get).toHaveBeenCalledWith('pos/products', {
            query: { search: 'marg', category_id: 7, cursor: null, limit: 20 },
        });
    });

    it('survives an answer with no body', async () => {
        const get = vi.fn().mockResolvedValue({ data: null, status: 304, etag: null, notModified: true });

        await expect(fetchProducts({ get } as never)).resolves.toEqual({
            records: [],
            variants: [],
            next_cursor: null,
            total: 0,
        });
    });
});

describe('lookupBarcode', () => {
    const product = makeProduct({ id: 1, name: 'Coffee' });
    const variant = makeVariant({ id: 11, product_id: 1, barcode: '5901234123457' });

    it('resolves a variant-only barcode', async () => {
        // The reason the server lookup was widened at all: the client indexes both
        // `product_variants.barcode` and `products.barcode`, so a variant-only code is the ordinary
        // case, not an edge one.
        const { api } = fakeApi({ '5901234123457': page({ records: [product], variants: [variant] }) });

        const result = await lookupBarcode(api, ['5901234123457']);

        expect(result.kind).toBe('found');
        expect(result.kind === 'found' && result.variant.id).toBe(11);
    });

    it('resolves a product-level barcode to that product’s default variant', async () => {
        const template = makeProduct({ id: 2, name: 'Tea', barcode: '4006381333931' });
        const plain = makeVariant({ id: 21, product_id: 2 });
        const { api } = fakeApi({ '4006381333931': page({ records: [template], variants: [plain] }) });

        const result = await lookupBarcode(api, ['4006381333931']);

        expect(result.kind === 'found' && result.variant.id).toBe(21);
    });

    it('refuses a substring hit that is not actually this barcode', async () => {
        // `search=123` is a LIKE, so the server legitimately returns "Box of 123 wipes". Adding its
        // variant to the sale would be the wrong product at the wrong price — and would look exactly
        // like the feature working.
        const decoy = makeProduct({ id: 3, name: 'Box of 123 wipes' });
        const decoyVariant = makeVariant({ id: 31, product_id: 3, barcode: '8712345678905' });
        const { api } = fakeApi({ '123': page({ records: [decoy], variants: [decoyVariant] }) });

        await expect(lookupBarcode(api, ['123'])).resolves.toEqual({ kind: 'missing' });
    });

    it('walks the parser’s alternates in order and stops at the first exact hit', async () => {
        // `routeScan` tries `parsed.code` then the UPC↔EAN alternates against the local index; the
        // server lookup must try the same list in the same order, or the same scan resolves to two
        // different products depending on whether the catalogue happened to be capped.
        const { api, searches } = fakeApi({
            '5901234123457': page({ records: [product], variants: [variant] }),
        });

        const result = await lookupBarcode(api, ['0590123412345', '5901234123457', '90123412345']);

        expect(result.kind).toBe('found');
        expect(searches).toEqual(['0590123412345', '5901234123457']);
    });

    it('asks for nothing when the browser knows it is offline', async () => {
        vi.stubGlobal('navigator', { onLine: false });
        const { api, searches } = fakeApi({});

        await expect(lookupBarcode(api, ['5901234123457'])).resolves.toEqual({ kind: 'offline' });
        expect(searches).toEqual([]);
    });

    it('reports offline rather than missing when the request itself fails', async () => {
        // `navigator.onLine` lies on captive-portal wifi. Reporting "no such product" there would
        // tell a cashier a real product does not exist because the network dropped.
        const get = vi.fn().mockRejectedValue(new ApiError(undefined, { kind: 'offline' }, null));

        await expect(lookupBarcode({ get } as never, ['5901234123457'])).resolves.toEqual({
            kind: 'offline',
        });
    });

    it('lets a real server error through instead of swallowing it as a miss', async () => {
        const get = vi.fn().mockRejectedValue(new ApiError(500, { kind: 'server_unreachable' }, null));

        await expect(lookupBarcode({ get } as never, ['5901234123457'])).rejects.toBeInstanceOf(ApiError);
    });

    it('asks for nothing when there is no code to ask about', async () => {
        const { api, searches } = fakeApi({});

        await expect(lookupBarcode(api, ['', '   '])).resolves.toEqual({ kind: 'missing' });
        expect(searches).toEqual([]);
    });
});

describe('exactMatch', () => {
    it('prefers the variant barcode over a product barcode claiming the same code', () => {
        const shared = '5901234123457';
        const template = makeProduct({ id: 1, barcode: shared });
        const other = makeProduct({ id: 2 });
        const ownVariant = makeVariant({ id: 21, product_id: 2, barcode: shared });
        const defaultVariant = makeVariant({ id: 11, product_id: 1 });

        const hit = exactMatch(
            page({ records: [template, other], variants: [defaultVariant, ownVariant] }),
            [shared],
        );

        // The SKU that actually carries the code wins — the same rule `catalog-load.ts` applies, and
        // the reason both go through `indexBarcodes`.
        expect(hit?.id).toBe(21);
    });
});
