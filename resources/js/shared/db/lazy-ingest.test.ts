import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getMeta, ingestCatalogRows, setMeta } from './hydrate';
import { META, PosDb, dbNameFor } from './schema';

/**
 * BAN-421 — caching a lazily fetched product without pretending it was a delta.
 *
 * `applyPayload` is the only other writer of these tables and it does two things this must not: it
 * advances the sync watermark and it applies tombstones. Both are correct for a delta and both are
 * corrupting for a search result, which is why this is a separate function rather than a fourth
 * argument on that one.
 */

let configId = 7000;
let db: PosDb;

beforeEach(() => {
    configId += 1;
    db = new PosDb(configId);
});

afterEach(async () => {
    db.close();
    await Dexie.delete(dbNameFor(configId));
});

const product = {
    id: 1,
    uuid: 'p-1',
    name: 'Café Grand',
    default_code: 'CAF-L',
    barcode: '5901234123457',
    updated_at: '2026-08-01T10:00:00Z',
};

describe('ingestCatalogRows', () => {
    it('writes the rows with the same precomputed search fields the bootstrap would', async () => {
        const written = await ingestCatalogRows(db, {
            products: [product],
            product_variants: [{ id: 11, product_id: 1, display_name: 'Café Grand', barcode: '5901234123457' }],
        });

        expect(written).toBe(2);
        // Folded and lowercased, exactly as `TRANSFORMS` does on a bootstrap — a lazily cached row
        // that skipped this would be scannable and unfindable by name.
        expect((await db.products.get(1))?.searchText).toBe('cafe grand caf-l 5901234123457');
        expect((await db.variants.get(11))?.searchText).toBe('cafe grand cafe grand 5901234123457');
    });

    it('never advances the sync watermark', async () => {
        // This is the whole reason for the separate writer. `applyPayload` stamps `watermark.*` from
        // the payload's `server_time`, and the delta puller sends that back as `?since=`. Advancing
        // it on the strength of one scanned product would tell the server "I have everything up to
        // now", and every row changed since the last real delta would be skipped — permanently,
        // because the watermark only moves forward.
        await setMeta(db, META.watermarkGlobal, '2026-08-01T09:00:00Z');
        await setMeta(db, META.configRevision, 4);

        await ingestCatalogRows(db, { products: [product] });

        expect(await getMeta(db, META.watermarkGlobal, 'moved')).toBe('2026-08-01T09:00:00Z');
        expect(await getMeta(db, META.configRevision, -1)).toBe(4);
        expect(await getMeta(db, META.watermarkFor('products'), 'unset')).toBe('unset');
    });

    it('folds the parent name in from the replica when the payload carries only the variant', async () => {
        await ingestCatalogRows(db, { products: [product] });

        await ingestCatalogRows(db, {
            product_variants: [{ id: 12, product_id: 1, display_name: 'Café Petit' }],
        });

        // Otherwise the same variant would search differently depending on which request happened to
        // carry it — searching "café grand petit" after a bootstrap and "café petit" after a scan.
        expect((await db.variants.get(12))?.searchText).toBe('cafe grand cafe petit');
    });

    it('writes nothing, and opens no transaction, for an empty payload', async () => {
        await expect(ingestCatalogRows(db, {})).resolves.toBe(0);
        expect(await db.products.count()).toBe(0);
    });

    it('overwrites a cached row rather than duplicating it', async () => {
        await ingestCatalogRows(db, { products: [product] });
        await ingestCatalogRows(db, { products: [{ ...product, name: 'Café Grand bio' }] });

        expect(await db.products.count()).toBe(1);
        expect((await db.products.get(1))?.name).toBe('Café Grand bio');
    });
});
