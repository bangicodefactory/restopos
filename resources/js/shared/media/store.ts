import type { PosDb } from '../db';
import type { ApiClient } from '../sync';

/**
 * Media bytes for the offline clients (SLF-024, BAN-480).
 *
 * The schema has carried ~10 `*_media_id` foreign keys since it landed, with no code on either side
 * of them: every product tile drew a placeholder and every receipt printed without a logo.
 *
 * **Why the bytes come through `fetch` and live in IndexedDB, rather than an `<img src>` pointing at
 * the route.** A device authenticates with a bearer token and an `<img>` cannot carry a header, so
 * pointing one at `/api/pos/media/{id}` would be an anonymous request — which would mean either
 * serving media unauthenticated or not serving it at all. Fetching with the token and rendering from
 * an object URL keeps the route authorised.
 *
 * That choice was already made for us, and it is worth seeing where: `shared/db/quota.ts` evicts
 * blobs keyed `product:*` first and deliberately spares `logo:*`, because a product photo is
 * disposable and a receipt logo is what a printer blocks on. The storage policy for these keys
 * existed before anything wrote one.
 *
 * Offline falls out of it: after a bootstrap the bytes are in IndexedDB with the rest of the
 * replica, so a till with no uplink still draws its menu.
 */

/** Blob-store key for a product or category image — evictable under storage pressure. */
export function imageKey(mediaId: number): string {
    return `product:${mediaId}`;
}

/** Blob-store key for the receipt logo — spared by the quota sweep, because receipts need it. */
export function logoKey(mediaId: number): string {
    return `logo:${mediaId}`;
}

export function mediaPath(mediaId: number): string {
    return `pos/media/${mediaId}`;
}

/**
 * Fetch one media file into the blob store, unless it is already there.
 *
 * Returns false when the fetch failed — offline, or a row whose file has gone. Callers treat that
 * as "draw the placeholder", never as an error: an image is the one thing on a till that is allowed
 * to be missing.
 */
export async function cacheMedia(
    db: PosDb,
    api: ApiClient,
    mediaId: number,
    key = imageKey(mediaId),
): Promise<boolean> {
    const existing = await db.blobs.get(key);
    if (existing) return true;

    try {
        const response = await api.get<Blob>(mediaPath(mediaId), {
            headers: { Accept: 'image/*' },
            responseType: 'blob',
        });

        const blob = response.data;
        if (!(blob instanceof Blob)) return false;

        await db.blobs.put({
            key,
            blob,
            contentType: blob.type || 'application/octet-stream',
            fetchedAt: Date.now(),
        });

        return true;
    } catch {
        return false;
    }
}

/** The cached bytes for a key, or null. */
export async function mediaBlob(db: PosDb, key: string): Promise<Blob | null> {
    return (await db.blobs.get(key))?.blob ?? null;
}

/**
 * Warm the blob store for everything the clients will draw.
 *
 * Bounded concurrency, and failures are shrugged off one by one: a venue with two hundred product
 * photos on a slow line must not hold up a service, and one dead row must not stop the other
 * hundred and ninety-nine. Called after bootstrap, not during it — the catalogue has to be usable
 * before the pictures arrive.
 */
export async function warmMediaCache(
    db: PosDb,
    api: ApiClient,
    ids: Array<{ id: number; key: string }>,
    concurrency = 4,
): Promise<{ cached: number; failed: number }> {
    const queue = [...ids];
    let cached = 0;
    let failed = 0;

    const worker = async (): Promise<void> => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
            const ok = await cacheMedia(db, api, next.id, next.key);
            if (ok) cached += 1;
            else failed += 1;
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));

    return { cached, failed };
}

/**
 * Which media the clients need, from what the replica already knows.
 *
 * Product and category tiles are `product:` keys; the config's receipt logo is a `logo:` key. Both
 * come out of the same sweep so a caller cannot warm one and forget the other.
 */
export async function mediaToWarm(db: PosDb): Promise<Array<{ id: number; key: string }>> {
    const [products, categories, configs] = await Promise.all([
        db.products.toArray(),
        db.posCategories.toArray(),
        db.configs.toArray(),
    ]);

    const out = new Map<string, { id: number; key: string }>();

    for (const row of [...products, ...categories]) {
        const id = (row as { image_media_id?: number | null }).image_media_id;
        if (typeof id === 'number') out.set(imageKey(id), { id, key: imageKey(id) });
    }

    for (const config of configs) {
        const id = (config as { receipt_logo_media_id?: number | null }).receipt_logo_media_id;
        if (typeof id === 'number') out.set(logoKey(id), { id, key: logoKey(id) });
    }

    return [...out.values()];
}
