import 'fake-indexeddb/auto';

import { PosDb, dbNameFor } from '@shared/db';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCatalog } from '../data/catalog';
import type { ProductLookupPage } from '../data/product-lookup';
import { installCatalog, makeNomenclature, makeProduct, makeRule, makeVariant } from './__fixtures__/catalog';
import { resolveScanMiss } from './scan-miss';
import { routeScan } from './scanner';

/**
 * BAN-421 — what happens when a scan matches nothing this device holds.
 *
 * Before this, the register filled the search box and said nothing, so "not stocked on this till",
 * "does not exist anywhere" and "the wifi is down" were one indistinguishable non-event. The three
 * outcomes asserted here are those three answers.
 */

const PLAIN_EAN = '5901234123457';
const WEIGHT_SCAN = '2100001015003'; // 1.500 kg of base code 2100001000004
const WEIGHT_BASE = '2100001000004';

const rules = [
    makeRule({ id: 1, rule_type: 'weight', pattern: '21.....{NNDDD}', encoding: 'ean13', sequence: 1 }),
    makeRule({ id: 2, rule_type: 'product', pattern: '.*', sequence: 100 }),
];

let configId = 8000;
let db: PosDb;

beforeEach(() => {
    configId += 1;
    db = new PosDb(configId);
    // A till that holds a catalogue with the nomenclature but not this product — the whole premise:
    // the local slice is capped, so a miss is not yet an answer.
    installCatalog({ nomenclature: makeNomenclature(rules) });
});

afterEach(async () => {
    db.close();
    await Dexie.delete(dbNameFor(configId));
    vi.unstubAllGlobals();
});

function page(products: unknown[], variants: unknown[]): ProductLookupPage {
    return {
        records: products as ProductLookupPage['records'],
        variants: variants as ProductLookupPage['variants'],
        next_cursor: null,
        total: products.length,
    };
}

function fakeApi(bySearch: Record<string, ProductLookupPage>): never {
    return {
        get: (_path: string, options: { query?: { search?: string | null } }) =>
            Promise.resolve({
                data: bySearch[String(options.query?.search ?? '')] ?? page([], []),
                status: 200,
                etag: null,
                notModified: false,
            }),
    } as never;
}

function miss(raw: string) {
    const action = routeScan(raw, getCatalog());
    if (action.kind !== 'unknown') throw new Error(`expected a miss, got ${action.kind}`);
    return action;
}

describe('resolveScanMiss', () => {
    it('adds the product the server had, and caches it for next time', async () => {
        const api = fakeApi({
            [PLAIN_EAN]: page(
                [makeProduct({ id: 1, name: 'Coffee' })],
                [makeVariant({ id: 11, product_id: 1, barcode: PLAIN_EAN })],
            ),
        });

        const outcome = await resolveScanMiss(PLAIN_EAN, miss(PLAIN_EAN), { api, db });

        expect(outcome.kind).toBe('resolved');
        expect(outcome.kind === 'resolved' && outcome.action.kind).toBe('product');
        expect(outcome.kind === 'resolved' && outcome.action.kind === 'product' && outcome.action.variant.id).toBe(11);

        // In memory, so the sale can proceed…
        expect(getCatalog().barcodeIndex.get(PLAIN_EAN)?.id).toBe(11);
        // …and in IndexedDB, so the next scan of it works after a reload, and offline.
        expect((await db.variants.get(11))?.id).toBe(11);
    });

    it('keeps the embedded weight instead of adding one unit', async () => {
        // The obvious implementation adds a line for the variant the lookup returned. It puts one
        // unit of ham on the bill instead of 1.5 kg, because the miss's `code` is the *base* code
        // with the payload zeroed out. Routing the raw scan again is what preserves it — and this
        // assertion is the only thing standing between that and a silent pricing bug.
        const api = fakeApi({
            [WEIGHT_BASE]: page(
                [makeProduct({ id: 2, name: 'Jambon' })],
                [makeVariant({ id: 22, product_id: 2, barcode: WEIGHT_BASE })],
            ),
        });

        const outcome = await resolveScanMiss(WEIGHT_SCAN, miss(WEIGHT_SCAN), { api, db });

        expect(outcome.kind === 'resolved' && outcome.action.kind).toBe('weighed');
        expect(outcome.kind === 'resolved' && outcome.action.kind === 'weighed' && outcome.action.quantity).toBe(1.5);
    });

    it('says "not found" when the server has answered and has nothing', async () => {
        const outcome = await resolveScanMiss(PLAIN_EAN, miss(PLAIN_EAN), { api: fakeApi({}), db });

        expect(outcome).toEqual({ kind: 'notFound', code: PLAIN_EAN });
    });

    it('says "offline" rather than "not found" when it could not ask', async () => {
        vi.stubGlobal('navigator', { onLine: false });
        const before = getCatalog();

        const outcome = await resolveScanMiss(PLAIN_EAN, miss(PLAIN_EAN), { api: fakeApi({}), db });

        expect(outcome).toEqual({ kind: 'offline', code: PLAIN_EAN });
        // And nothing was invented locally to paper over it.
        expect(getCatalog()).toBe(before);
    });

    it('does not add a substring match the server threw in', async () => {
        const api = fakeApi({
            [PLAIN_EAN]: page(
                [makeProduct({ id: 3, name: `Case of ${PLAIN_EAN}` })],
                [makeVariant({ id: 33, product_id: 3, barcode: '8712345678905' })],
            ),
        });

        const outcome = await resolveScanMiss(PLAIN_EAN, miss(PLAIN_EAN), { api, db });

        expect(outcome.kind).toBe('notFound');
        expect(getCatalog().barcodeIndex.has(PLAIN_EAN)).toBe(false);
    });

    it('still completes the sale when the local cache write fails', async () => {
        // Quota exhausted, or private browsing. The line carries its own name and price, so the only
        // thing lost is that the next scan pays for the round trip again — losing the sale instead
        // would be a much worse trade.
        const broken = { transaction: () => Promise.reject(new Error('QuotaExceededError')) } as unknown as PosDb;
        const api = fakeApi({
            [PLAIN_EAN]: page(
                [makeProduct({ id: 1, name: 'Coffee' })],
                [makeVariant({ id: 11, product_id: 1, barcode: PLAIN_EAN })],
            ),
        });

        const outcome = await resolveScanMiss(PLAIN_EAN, miss(PLAIN_EAN), { api, db: broken });

        expect(outcome.kind === 'resolved' && outcome.action.kind).toBe('product');
    });

    it('bumps the catalog version so memos keyed on it re-read', async () => {
        const before = getCatalog().version;
        const api = fakeApi({
            [PLAIN_EAN]: page(
                [makeProduct({ id: 1 })],
                [makeVariant({ id: 11, product_id: 1, barcode: PLAIN_EAN })],
            ),
        });

        await resolveScanMiss(PLAIN_EAN, miss(PLAIN_EAN), { api, db });

        // The product grid is a `useMemo` keyed on `version`. Publishing the new index without
        // moving it would leave a product that is in the catalogue and invisible on screen.
        expect(getCatalog().version).toBeGreaterThan(before);
    });

    it('leaves the previously fetched products in place across two misses', async () => {
        const first = fakeApi({
            [PLAIN_EAN]: page(
                [makeProduct({ id: 1 })],
                [makeVariant({ id: 11, product_id: 1, barcode: PLAIN_EAN })],
            ),
        });
        const second = fakeApi({
            '4006381333931': page(
                [makeProduct({ id: 2 })],
                [makeVariant({ id: 21, product_id: 2, barcode: '4006381333931' })],
            ),
        });

        await resolveScanMiss(PLAIN_EAN, miss(PLAIN_EAN), { api: first, db });
        await resolveScanMiss('4006381333931', miss('4006381333931'), { api: second, db });

        // An insert that rebuilt from the addition alone rather than folding into the current index
        // would drop the first product on the second scan.
        expect(getCatalog().barcodeIndex.get(PLAIN_EAN)?.id).toBe(11);
        expect(getCatalog().barcodeIndex.get('4006381333931')?.id).toBe(21);
    });
});
