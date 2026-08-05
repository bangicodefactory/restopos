import { describe, expect, it, vi } from 'vitest';

import { cacheMedia, imageKey, logoKey, mediaPath, mediaToWarm, warmMediaCache } from './store';

/**
 * BAN-480 — the media read path.
 *
 * The keys are the load-bearing part. `shared/db/quota.ts` evicts blobs whose key starts with
 * `product:` and spares everything else, so a product photo is disposable and a receipt logo — which
 * a printer blocks on — is not. Get the prefix wrong and the failure is invisible until a till under
 * storage pressure prints a receipt with no logo.
 */

/** A stand-in for the Dexie blob table, plus the catalogue tables `mediaToWarm` reads. */
function fakeDb(seed: Record<string, unknown> = {}, tables: Record<string, unknown[]> = {}) {
    const blobs = new Map<string, unknown>(Object.entries(seed));

    return {
        blobs: {
            get: (key: string) => Promise.resolve(blobs.get(key)),
            put: (row: { key: string }) => {
                blobs.set(row.key, row);

                return Promise.resolve(row.key);
            },
        },
        products: { toArray: () => Promise.resolve(tables.products ?? []) },
        posCategories: { toArray: () => Promise.resolve(tables.posCategories ?? []) },
        configs: { toArray: () => Promise.resolve(tables.configs ?? []) },
        _blobs: blobs,
    } as never;
}

function fakeApi(blob: Blob | null = new Blob(['x'], { type: 'image/png' })) {
    const get = vi.fn().mockImplementation(() =>
        blob === null
            ? Promise.reject(new Error('offline'))
            : Promise.resolve({ data: blob, status: 200, etag: null, notModified: false }),
    );

    return { api: { get } as never, get };
}

describe('keys', () => {
    it('prefixes product images so the quota sweep can evict them', () => {
        // `quota.ts` filters on exactly this prefix.
        expect(imageKey(7)).toBe('product:7');
    });

    it('prefixes the receipt logo so the quota sweep spares it', () => {
        // And this is the key `receipt.ts` already builds when it sets `logoKey` on the doc.
        expect(logoKey(3)).toBe('logo:3');
    });

    it('addresses media by id, which is what the payload carries', () => {
        expect(mediaPath(12)).toBe('pos/media/12');
    });
});

describe('cacheMedia', () => {
    it('stores the bytes under the given key', async () => {
        const db = fakeDb();
        const { api, get } = fakeApi();

        await expect(cacheMedia(db, api, 7)).resolves.toBe(true);

        expect(get).toHaveBeenCalledWith('pos/media/7', {
            headers: { Accept: 'image/*' },
            responseType: 'blob',
        });
        expect((db as unknown as { _blobs: Map<string, unknown> })._blobs.has('product:7')).toBe(true);
    });

    it('does not re-fetch something already held', async () => {
        // The whole point of the blob store: a scrolled grid on a warmed till makes no requests.
        const db = fakeDb({ 'product:7': { key: 'product:7' } });
        const { api, get } = fakeApi();

        await expect(cacheMedia(db, api, 7)).resolves.toBe(true);
        expect(get).not.toHaveBeenCalled();
    });

    it('reports failure rather than throwing when offline', async () => {
        // An image is the one thing on a till allowed to be missing; the caller draws a placeholder.
        const db = fakeDb();
        const { api } = fakeApi(null);

        await expect(cacheMedia(db, api, 7)).resolves.toBe(false);
    });

    it('honours an explicit key, so the logo does not land in the evictable bucket', async () => {
        const db = fakeDb();
        const { api } = fakeApi();

        await cacheMedia(db, api, 3, logoKey(3));

        const keys = [...(db as unknown as { _blobs: Map<string, unknown> })._blobs.keys()];

        expect(keys).toEqual(['logo:3']);
    });
});

describe('warmMediaCache', () => {
    it('keeps going when one image fails', async () => {
        const db = fakeDb();
        const get = vi
            .fn()
            .mockRejectedValueOnce(new Error('gone'))
            .mockResolvedValue({ data: new Blob(['x']), status: 200, etag: null, notModified: false });

        const result = await warmMediaCache(db, { get } as never, [
            { id: 1, key: imageKey(1) },
            { id: 2, key: imageKey(2) },
            { id: 3, key: imageKey(3) },
        ]);

        // One dead row must not cost the other two.
        expect(result).toEqual({ cached: 2, failed: 1 });
    });

    it('requests nothing for an empty list', async () => {
        const { api, get } = fakeApi();

        await warmMediaCache(fakeDb(), api, []);

        expect(get).not.toHaveBeenCalled();
    });
});

describe('mediaToWarm', () => {
    it('collects product, category and logo media with the right keys', async () => {
        const db = fakeDb({}, {
            products: [{ image_media_id: 1 }, { image_media_id: null }],
            posCategories: [{ image_media_id: 2 }],
            configs: [{ receipt_logo_media_id: 3 }],
        });

        const out = await mediaToWarm(db);

        expect(out).toEqual([
            { id: 1, key: 'product:1' },
            { id: 2, key: 'product:2' },
            { id: 3, key: 'logo:3' },
        ]);
    });

    it('does not ask for the same image twice', async () => {
        // Two products sharing a photo is one fetch, not two.
        const db = fakeDb({}, {
            products: [{ image_media_id: 5 }, { image_media_id: 5 }],
            posCategories: [],
            configs: [],
        });

        expect(await mediaToWarm(db)).toEqual([{ id: 5, key: 'product:5' }]);
    });
});
