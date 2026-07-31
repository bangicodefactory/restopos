import type { CounterStore } from '@domain/sequence/index';
import type { OutboxEntry, OutboxStorage } from '@domain/sync/outbox';
import type { Uuid } from '@domain/types';

import { META, type PosDb } from './schema';

/**
 * Dexie-backed implementations of the storage contracts `packages/domain` declares.
 *
 * The domain layer owns the *policy* (backoff, coalescing, reference formatting); this file owns
 * the *storage*. That split is what lets the whole outbox policy be unit-tested in microseconds
 * against a Map, and what keeps Dexie out of `packages/domain`.
 */

export function createDexieOutboxStorage(db: PosDb): OutboxStorage {
    return {
        async put(entry: OutboxEntry): Promise<void> {
            await db.outbox.put(entry);
        },

        async get(id: Uuid): Promise<OutboxEntry | undefined> {
            return db.outbox.get(id as string);
        },

        async delete(id: Uuid): Promise<void> {
            await db.outbox.delete(id as string);
        },

        async all(): Promise<OutboxEntry[]> {
            return db.outbox.orderBy('seq').toArray();
        },

        /**
         * Monotonic sequence. Dexie has no autoincrement on a non-primary field, so we allocate
         * from `meta` inside a read-write transaction — atomic against concurrent enqueues in the
         * same tab, and IndexedDB serialises across tabs.
         */
        async nextSeq(): Promise<number> {
            return db.transaction('rw', db.meta, async () => {
                const row = await db.meta.get('seq.outbox');
                const next = (typeof row?.value === 'number' ? row.value : 0) + 1;
                await db.meta.put({ key: 'seq.outbox', value: next });
                return next;
            });
        },
    };
}

/**
 * The order-reference counter (spec 03 §6.1).
 *
 * `increment` must be durable **before** the reference is used, otherwise a crash between minting
 * and flushing can hand the same reference to two orders. Dexie's rw transaction gives us that.
 */
export function createDexieCounterStore(db: PosDb): CounterStore {
    return {
        async increment(key: string): Promise<number> {
            return db.transaction('rw', db.meta, async () => {
                const row = await db.meta.get(key);
                const next = (typeof row?.value === 'number' ? row.value : 0) + 1;
                await db.meta.put({ key, value: next });
                return next;
            });
        },

        async get(key: string): Promise<number | null> {
            const row = await db.meta.get(key);
            return typeof row?.value === 'number' ? row.value : null;
        },

        async set(key: string, value: number): Promise<void> {
            await db.meta.put({ key, value });
        },
    };
}

/** Blob store for receipt assets — must survive cache eviction, hence IndexedDB (spec 03 §8.1). */
export function createBlobStore(db: PosDb) {
    return {
        async get(key: string): Promise<Blob | null> {
            const row = await db.blobs.get(key);
            return row?.blob ?? null;
        },

        async put(key: string, blob: Blob, contentType: string): Promise<void> {
            await db.blobs.put({ key, blob, contentType, fetchedAt: Date.now() });
        },

        async has(key: string): Promise<boolean> {
            return (await db.blobs.where('key').equals(key).count()) > 0;
        },

        /** Fetch-once-and-cache. Receipt assets are warmed eagerly; product images lazily. */
        async ensure(key: string, url: string, fetchImpl: typeof fetch = fetch): Promise<Blob | null> {
            const existing = await this.get(key);
            if (existing) return existing;
            try {
                const response = await fetchImpl(url);
                if (!response.ok) return null;
                const blob = await response.blob();
                await this.put(key, blob, response.headers.get('content-type') ?? blob.type);
                return blob;
            } catch {
                return null;
            }
        },
    };
}

export type BlobStore = ReturnType<typeof createBlobStore>;

/** Convenience: the meta keys used by more than one module. */
export { META };
