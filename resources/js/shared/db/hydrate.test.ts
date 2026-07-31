import 'fake-indexeddb/auto';

import type { BootstrapResponse, DeltaResponse } from '@domain/sync/wire';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    applyPayload,
    destroyDatabase,
    getMeta,
    loadCatalog,
    normalizeSearch,
    phoneDigitsOf,
    resetForConfigRevision,
    searchCatalog,
    searchCustomers,
    setMeta,
} from './hydrate';
import { META, PosDb, dbNameFor } from './schema';

/**
 * Unit coverage for spec 03 §3.3 (hydration) and spec 01 §5.5 (full-reload trigger), against
 * `fake-indexeddb` so the real Dexie schema — indexes and all — is exercised.
 */

let configId = 5000;
let db: PosDb;

beforeEach(() => {
    configId += 1;
    db = new PosDb(configId);
});

afterEach(async () => {
    db.close();
    await Dexie.delete(dbNameFor(configId));
});

// ── payload builders ─────────────────────────────────────────────────────────

function bootstrap(
    data: Record<string, unknown[]>,
    overrides: Partial<BootstrapResponse> = {},
): BootstrapResponse {
    return {
        server_time: '2026-07-28T12:00:00.000Z',
        config_revision: 1,
        profile: 'register',
        limits: { products: 500, customers: 500, products_total: 500 },
        data,
        ...overrides,
    };
}

function delta(
    data: Record<string, unknown[]>,
    tombstones: Record<string, Array<number | string>> = {},
    overrides: Partial<DeltaResponse> = {},
): DeltaResponse {
    return {
        ...bootstrap(data),
        since: '2026-07-28T11:00:00.000Z',
        tombstones,
        ...overrides,
    } as DeltaResponse;
}

function product(id: number, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, name, default_code: null, barcode: null, pos_category_ids: [], ...extra };
}

function variant(id: number, productId: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, product_id: productId, display_name: `Variant ${id}`, default_code: null, barcode: null, ...extra };
}

function order(uuid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { uuid, id: null, state: 'draft', pos_session_id: 1, restaurant_table_id: null, ...extra };
}

// ── search-field precomputation ──────────────────────────────────────────────

describe('normalizeSearch', () => {
    it.each([
        { input: 'Crème Brûlée', expected: 'creme brulee' },
        { input: '  PIZZA   MARGHERITA ', expected: 'pizza margherita' },
        { input: 'Éclair', expected: 'eclair' },
        { input: '', expected: '' },
    ])('$input → $expected', ({ input, expected }) => {
        expect(normalizeSearch(input)).toBe(expected);
    });
});

describe('phoneDigitsOf', () => {
    it('keeps every digit of every number and drops everything else', () => {
        expect(phoneDigitsOf('+32 475 12 34 56', '02/345.67.89')).toBe('32475123456 023456789');
    });

    it('ignores nulls and undefined', () => {
        expect(phoneDigitsOf(null, undefined, '0123')).toBe('0123');
    });

    it('leaves no dangling separator when a number has no digits', () => {
        // `hydrate` maps a null `mobile` to `''`, so the empty segment must be dropped, not joined.
        expect(phoneDigitsOf('+32 475 12 34 56', '')).toBe('32475123456');
        expect(phoneDigitsOf('', '02/345.67.89')).toBe('023456789');
        expect(phoneDigitsOf('n/a', 'none')).toBe('');
        expect(phoneDigitsOf('', '')).toBe('');
    });
});

// ── hydration ────────────────────────────────────────────────────────────────

describe('applyPayload', () => {
    it('ingests a bootstrap payload and stamps the watermarks', async () => {
        const result = await applyPayload(
            db,
            bootstrap({
                products: [product(1, 'Pizza Margherita', { default_code: 'PZ-01', barcode: '5901234123457' })],
                product_variants: [variant(11, 1, { barcode: '5901234123457' })],
            }),
        );

        expect(result).toMatchObject({ upserted: 2, deleted: 0, configRevision: 1 });
        expect(result.entities).toEqual(['products', 'product_variants']);

        expect(await db.products.count()).toBe(1);
        expect(await getMeta(db, META.watermarkGlobal, null)).toBe('2026-07-28T12:00:00.000Z');
        expect(await getMeta(db, META.watermarkFor('products'), null)).toBe('2026-07-28T12:00:00.000Z');
        expect(await getMeta(db, META.configRevision, null)).toBe(1);
    });

    it('keys static rows by the server id and dynamic rows by the client uuid', async () => {
        await applyPayload(
            db,
            bootstrap({
                products: [product(1, 'Pizza')],
                pos_orders: [order('11111111-1111-4111-8111-111111111111')],
            }),
        );

        expect(await db.products.get(1)).toMatchObject({ name: 'Pizza' });
        expect(await db.orders.get('11111111-1111-4111-8111-111111111111')).toBeDefined();
        // Server ids are not the key for a dynamic row.
        expect(await db.orders.get(1 as unknown as string)).toBeUndefined();
    });

    it('precomputes searchText for products from name, reference and barcode', async () => {
        await applyPayload(
            db,
            bootstrap({
                products: [product(1, 'Crème Brûlée', { default_code: 'DES-07', barcode: '3017620422003' })],
            }),
        );

        expect((await db.products.get(1))?.searchText).toBe('creme brulee des-07 3017620422003');
    });

    it('folds the parent product name into the variant searchText', async () => {
        await applyPayload(
            db,
            bootstrap({
                products: [product(1, 'Café')],
                product_variants: [variant(11, 1, { display_name: 'Café Grand', default_code: 'CAF-L' })],
            }),
        );

        expect((await db.variants.get(11))?.searchText).toBe('cafe cafe grand caf-l');
    });

    it('precomputes customer searchText and phoneDigits', async () => {
        await applyPayload(
            db,
            bootstrap({
                customers: [
                    {
                        id: 1,
                        name: 'Élodie Durand',
                        company_name: 'Chez Élo',
                        email: 'elo@example.com',
                        vat: 'BE0123',
                        phone: '+32 475 12 34 56',
                        mobile: null,
                    },
                ],
            }),
        );

        const row = await db.customers.get(1);
        expect(row?.searchText).toBe('elodie durand chez elo elo@example.com be0123');
        // A null mobile contributes nothing at all — no dangling separator.
        expect(row?.phoneDigits).toBe('32475123456');
    });

    it('precomputes the category ancestry so a leaf knows its whole chain', async () => {
        await applyPayload(
            db,
            bootstrap({
                pos_categories: [
                    { id: 1, name: 'Carte', parent_id: null },
                    { id: 2, name: 'Plats', parent_id: 1 },
                    { id: 3, name: 'Pizzas', parent_id: 2 },
                ],
            }),
        );

        expect((await db.posCategories.get(3))?.ancestorIds).toEqual([1, 2]);
        expect((await db.posCategories.get(1))?.ancestorIds).toEqual([]);
    });

    it('marks server-sourced orders synced without overwriting fields the payload carries', async () => {
        await applyPayload(db, bootstrap({ pos_orders: [order('uuid-a', { id: 88 })] }));

        expect(await db.orders.get('uuid-a')).toMatchObject({ id: 88, syncState: 'synced', rev: 0 });
    });

    it('applies a delta idempotently — the same payload twice is one row', async () => {
        const payload = bootstrap({ products: [product(1, 'Pizza')] });
        await applyPayload(db, payload);
        await applyPayload(db, payload);
        expect(await db.products.count()).toBe(1);
    });

    it('applies tombstones for static rows', async () => {
        await applyPayload(db, bootstrap({ products: [product(1, 'Pizza'), product(2, 'Cola')] }));
        const result = await applyPayload(db, delta({}, { products: [2] }));

        expect(result.deleted).toBe(1);
        expect(await db.products.toArray()).toHaveLength(1);
        expect(await db.products.get(2)).toBeUndefined();
    });

    it('refuses to let a tombstone delete an order we have not pushed yet', async () => {
        await db.orders.bulkPut([
            order('unsynced', { syncState: 'local' }),
            order('synced', { syncState: 'synced' }),
        ] as never[]);

        const result = await applyPayload(db, delta({}, { pos_orders: ['unsynced', 'synced'] }));

        expect(result.deleted).toBe(1);
        expect(await db.orders.get('unsynced')).toBeDefined();
        expect(await db.orders.get('synced')).toBeUndefined();
    });

    it('ignores an entity name that is not in the table map', async () => {
        const result = await applyPayload(db, bootstrap({ unicorns: [{ id: 1 }] }));
        expect(result.entities).toEqual([]);
        expect(result.upserted).toBe(0);
    });
});

// ── config-revision reset ────────────────────────────────────────────────────

describe('resetForConfigRevision (spec 01 §5.5)', () => {
    beforeEach(async () => {
        await applyPayload(
            db,
            bootstrap({
                products: [product(1, 'Pizza')],
                product_variants: [variant(11, 1)],
                pos_categories: [{ id: 1, name: 'Carte', parent_id: null }],
                taxes: [{ id: 1, name: 'TVA', amount: '20' }],
            }),
        );
    });

    it('purges the static dataset and voids every watermark', async () => {
        await resetForConfigRevision(db, 2);

        expect(await db.products.count()).toBe(0);
        expect(await db.variants.count()).toBe(0);
        expect(await db.posCategories.count()).toBe(0);
        expect(await db.taxes.count()).toBe(0);

        expect(await getMeta(db, META.watermarkGlobal, null)).toBeNull();
        expect(await getMeta(db, META.watermarkFor('products'), null)).toBeNull();
        expect(await getMeta(db, META.configRevision, null)).toBe(2);
    });

    it('preserves unsynced orders and live drafts, dropping only settled synced ones', async () => {
        await db.orders.bulkPut([
            order('draft-synced', { state: 'draft', syncState: 'synced' }),
            order('paid-local', { state: 'paid', syncState: 'local' }),
            order('done-synced', { state: 'done', syncState: 'synced' }),
        ] as never[]);
        await db.lines.bulkPut([
            { uuid: 'l1', order_uuid: 'done-synced' },
            { uuid: 'l2', order_uuid: 'paid-local' },
        ] as never[]);
        await db.payments.bulkPut([{ uuid: 'p1', order_uuid: 'done-synced' }] as never[]);
        await db.courses.bulkPut([{ uuid: 'c1', order_uuid: 'done-synced' }] as never[]);

        const { preservedOrders } = await resetForConfigRevision(db, 2);

        expect(preservedOrders).toBe(2);
        expect((await db.orders.toArray()).map((o) => o.uuid).sort()).toEqual(['draft-synced', 'paid-local']);
        // The dropped order's children go with it; the kept order's do not.
        expect((await db.lines.toArray()).map((l) => l.uuid)).toEqual(['l2']);
        expect(await db.payments.count()).toBe(0);
        expect(await db.courses.count()).toBe(0);
    });

    it('keeps the outbox, the audit log and the device credentials', async () => {
        await db.outbox.put({ id: 'e1', seq: 1, kind: 'order.sync' } as never);
        await db.auditLog.put({ uuid: 'a1', kind: 'discount', at: 'now', payload: {}, syncedAt: null } as never);
        await setMeta(db, META.deviceToken, 'tok-123');

        await resetForConfigRevision(db, 2);

        expect(await db.outbox.count()).toBe(1);
        expect(await db.auditLog.count()).toBe(1);
        expect(await getMeta(db, META.deviceToken, null)).toBe('tok-123');
    });
});

describe('destroyDatabase', () => {
    it('refuses while an order has not reached the server', async () => {
        await db.orders.put(order('unsynced', { syncState: 'local' }) as never);
        await expect(destroyDatabase(configId)).rejects.toThrow(/Refusing to wipe/);
    });

    it('wipes when everything is synced', async () => {
        await db.orders.put(order('synced', { syncState: 'synced' }) as never);
        db.close();
        await expect(destroyDatabase(configId)).resolves.toBeUndefined();

        const fresh = new PosDb(configId);
        expect(await fresh.orders.count()).toBe(0);
        fresh.close();
    });

    it('wipes unconditionally when forced', async () => {
        await db.orders.put(order('unsynced', { syncState: 'local' }) as never);
        db.close();
        await expect(destroyDatabase(configId, { force: true })).resolves.toBeUndefined();
    });
});

// ── catalog projection & search ──────────────────────────────────────────────

describe('searchCatalog', () => {
    async function catalog() {
        await applyPayload(
            db,
            bootstrap({
                products: [
                    product(1, 'Crème Brûlée'),
                    product(2, 'Pizza Margherita'),
                    product(3, 'Café'),
                    product(4, 'Petit Café'),
                ],
                product_variants: [
                    variant(11, 1, { display_name: 'Crème Brûlée', default_code: 'DES-07' }),
                    variant(12, 2, { display_name: 'Pizza Margherita', barcode: '5901234123457' }),
                    variant(13, 3, { display_name: 'Café Grand', default_code: 'CAF-L' }),
                    variant(14, 4, { display_name: 'Petit Café' }),
                ],
            }),
        );
        return loadCatalog(db, 1);
    }

    it('matches on the product name, case- and accent-insensitively', async () => {
        const index = await catalog();
        expect(searchCatalog(index, 'CREME').map((v) => v.id)).toEqual([11]);
        expect(searchCatalog(index, 'brulee').map((v) => v.id)).toEqual([11]);
        expect(searchCatalog(index, 'Crème').map((v) => v.id)).toEqual([11]);
    });

    it('matches on the internal reference', async () => {
        const index = await catalog();
        expect(searchCatalog(index, 'caf-l').map((v) => v.id)).toEqual([13]);
    });

    it('matches on the barcode', async () => {
        const index = await catalog();
        expect(searchCatalog(index, '5901234123457').map((v) => v.id)).toEqual([12]);
    });

    it('ranks prefix matches ahead of substring matches', async () => {
        const index = await catalog();
        // 13 starts with "cafe"; 14 ("petit cafe …") only contains it.
        expect(searchCatalog(index, 'cafe').map((v) => v.id)).toEqual([13, 14]);
    });

    it('returns nothing for an empty query and honours the limit', async () => {
        const index = await catalog();
        expect(searchCatalog(index, '   ')).toEqual([]);
        expect(searchCatalog(index, 'cafe', 1)).toHaveLength(1);
    });

    it('builds the barcode index and the per-product variant buckets', async () => {
        const index = await catalog();
        expect(index.barcodeIndex.get('5901234123457')?.id).toBe(12);
        expect(index.variantsByProduct.get(1)?.map((v) => v.id)).toEqual([11]);
        expect(index.productsById.get(2)?.name).toBe('Pizza Margherita');
    });
});

describe('searchCustomers', () => {
    beforeEach(async () => {
        await applyPayload(
            db,
            bootstrap({
                customers: [
                    { id: 1, name: 'Élodie Durand', phone: '+32 475 12 34 56', mobile: null },
                    { id: 2, name: 'Marc Dupont', phone: '02/345.67.89', mobile: null },
                ],
            }),
        );
    });

    it('finds by folded name', async () => {
        expect((await searchCustomers(db, 'elodie')).map((c) => c.id)).toEqual([1]);
    });

    it('finds by typed digits anywhere in the number', async () => {
        expect((await searchCustomers(db, '475')).map((c) => c.id)).toEqual([1]);
        expect((await searchCustomers(db, '3456')).map((c) => c.id)).toEqual([1, 2]);
    });

    it('returns nothing for an empty query', async () => {
        expect(await searchCustomers(db, '')).toEqual([]);
    });
});

describe('meta helpers', () => {
    it('round-trips a value and falls back when absent', async () => {
        expect(await getMeta(db, 'missing', 'fallback')).toBe('fallback');
        await setMeta(db, 'missing', { a: 1 });
        expect(await getMeta(db, 'missing', null)).toEqual({ a: 1 });
    });
});
