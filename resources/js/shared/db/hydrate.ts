import type { BootstrapResponse, DeltaResponse } from '@domain/sync/wire';
import type { CustomerRow, PosCategoryRow, ProductRow, ProductVariantRow } from '@domain/types';
import type { Table } from 'dexie';
import Dexie from 'dexie';

import { ENTITY_TABLES, LOAD_ORDER, META, UUID_KEYED_ENTITIES, dbNameFor, type PosDb } from './schema';

/**
 * Ingest of the bootstrap / delta payload (spec 03 §3.3 "Hydration", §3.5).
 *
 * Two things happen here that happen nowhere else:
 *
 *   1. **Search fields are precomputed.** `searchText` and `phoneDigits` are written at ingest, not
 *      at query time. This is the difference between a 1 ms product search and a janky one.
 *   2. **The whole payload is applied inside one Dexie transaction, in dependency order**, so
 *      referential integrity holds at every commit point and a failed delta leaves no half-state.
 */

/** Fold diacritics and lowercase. `Crème Brûlée` → `creme brulee`. */
export function normalizeSearch(input: string): string {
    return input
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/** Every digit of every phone number, so typing `475` finds `+32 475 …`. */
export function phoneDigitsOf(...values: Array<string | null | undefined>): string {
    return values
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.replace(/\D+/g, ''))
        // A number with no digits at all ("", "n/a") would otherwise leave a dangling separator,
        // and `"32475123456 "` is not equal to `"32475123456"` for anything that compares keys.
        .filter((v) => v !== '')
        .join(' ');
}

type Unknown = Record<string, unknown>;

function str(row: Unknown, key: string): string {
    const value = row[key];
    return typeof value === 'string' ? value : '';
}

/**
 * Per-entity ingest transform. Anything not listed passes through untouched — adding a bootstrap
 * entity is adding one line to `ENTITY_TABLES`, not a new protocol.
 */
const TRANSFORMS: Record<string, (row: Unknown, ctx: HydrateContext) => Unknown> = {
    products: (row) => ({
        ...row,
        searchText: normalizeSearch(
            [str(row, 'name'), str(row, 'default_code'), str(row, 'barcode')].filter(Boolean).join(' '),
        ),
    }),

    product_variants: (row, ctx) => {
        const productId = row['product_id'];
        const parent = typeof productId === 'number' ? ctx.productNames.get(productId) : undefined;
        return {
            ...row,
            searchText: normalizeSearch(
                [parent ?? '', str(row, 'display_name'), str(row, 'default_code'), str(row, 'barcode')]
                    .filter(Boolean)
                    .join(' '),
            ),
        };
    },

    customers: (row) => ({
        ...row,
        searchText: normalizeSearch(
            [str(row, 'name'), str(row, 'company_name'), str(row, 'email'), str(row, 'vat')]
                .filter(Boolean)
                .join(' '),
        ),
        phoneDigits: phoneDigitsOf(str(row, 'phone'), str(row, 'mobile')),
    }),

    pos_categories: (row, ctx) => ({ ...row, ancestorIds: ctx.ancestorsOf(row) }),

    pos_orders: (row) => ({
        // Server-sourced orders arrive fully synced; client bookkeeping is added here so every
        // order in the store has the same shape regardless of where it came from.
        syncState: 'synced',
        syncError: null,
        rev: 0,
        baseline: null,
        updatedAtLocal: Date.now(),
        ...row,
    }),
};

type HydrateContext = {
    productNames: Map<number, string>;
    ancestorsOf: (row: Unknown) => number[];
};

function buildContext(payload: Record<string, unknown[]>): HydrateContext {
    const productNames = new Map<number, string>();
    for (const row of (payload['products'] ?? []) as Unknown[]) {
        const id = row['id'];
        if (typeof id === 'number') productNames.set(id, str(row, 'name'));
    }

    const parents = new Map<number, number | null>();
    for (const row of (payload['pos_categories'] ?? []) as Unknown[]) {
        const id = row['id'];
        const parent = row['parent_id'];
        if (typeof id === 'number') parents.set(id, typeof parent === 'number' ? parent : null);
    }

    const ancestorsOf = (row: Unknown): number[] => {
        const out: number[] = [];
        let current = typeof row['parent_id'] === 'number' ? (row['parent_id'] as number) : null;
        // Bounded: a cycle in the category tree must not hang the boot.
        for (let depth = 0; current !== null && depth < 32; depth++) {
            out.unshift(current);
            current = parents.get(current) ?? null;
        }
        return out;
    };

    return { productNames, ancestorsOf };
}

export type HydrateResult = {
    entities: string[];
    upserted: number;
    deleted: number;
    serverTime: string;
    configRevision: number;
};

function tableFor(db: PosDb, entity: string): Table<unknown, string | number> | null {
    const name = ENTITY_TABLES[entity];
    if (!name) return null;
    return db[name] as unknown as Table<unknown, string | number>;
}

/**
 * Apply a bootstrap or delta payload.
 *
 * `since` semantics are the server's: we store `watermark.global = response.server_time` **only
 * after the IndexedDB write commits**, and the delta puller subtracts a one-second safety margin
 * before sending it back (spec 03 §3.2.4 "Clock discipline"). Upserts are idempotent, so the
 * overlap costs nothing and eliminates the "one product never updates" class of bug.
 */
export async function applyPayload(db: PosDb, payload: BootstrapResponse | DeltaResponse): Promise<HydrateResult> {
    const ctx = buildContext(payload.data);
    const entities = LOAD_ORDER.filter(
        (entity) => payload.data[entity] !== undefined || payload.tombstones?.[entity] !== undefined,
    );

    const tables = entities
        .map((entity) => tableFor(db, entity))
        .filter((t): t is Table<unknown, string | number> => t !== null);

    let upserted = 0;
    let deleted = 0;

    await db.transaction('rw', [...tables, db.meta], async () => {
        for (const entity of entities) {
            const table = tableFor(db, entity);
            if (!table) continue;

            const rows = (payload.data[entity] ?? []) as Unknown[];
            if (rows.length > 0) {
                const transform = TRANSFORMS[entity];
                const prepared = transform ? rows.map((row) => transform(row, ctx)) : rows;
                await table.bulkPut(prepared);
                upserted += prepared.length;
            }

            const tombstones = payload.tombstones?.[entity] ?? [];
            if (tombstones.length > 0) {
                const keys = UUID_KEYED_ENTITIES.has(entity)
                    ? await filterDeletableOrders(db, entity, tombstones.map(String))
                    : tombstones;
                if (keys.length > 0) {
                    await table.bulkDelete(keys as Array<string | number>);
                    deleted += keys.length;
                }
            }

            await db.meta.put({ key: META.watermarkFor(entity), value: payload.server_time });
        }

        await db.meta.put({ key: META.watermarkGlobal, value: payload.server_time });
        await db.meta.put({ key: META.configRevision, value: payload.config_revision });
        await db.meta.put({ key: META.lastBootstrapAt, value: Date.now() });
    });

    return {
        entities,
        upserted,
        deleted,
        serverTime: payload.server_time,
        configRevision: payload.config_revision,
    };
}

/**
 * A tombstone must never delete an order we have not pushed yet.
 *
 * The server can legitimately tombstone an order it considers gone (paid elsewhere, merged) while
 * the local copy still carries unsynced mutations. Dropping it would lose a sale, so we keep it and
 * let the sync engine resolve the conflict.
 */
async function filterDeletableOrders(db: PosDb, entity: string, uuids: string[]): Promise<string[]> {
    if (entity !== 'pos_orders') return uuids;
    const local = await db.orders.where('uuid').anyOf(uuids).toArray();
    const unsynced = new Set(local.filter((o) => o.syncState !== 'synced').map((o) => o.uuid as string));
    return uuids.filter((uuid) => !unsynced.has(uuid));
}

/**
 * Full-reload path (spec 01 §5.5 "Full-reload trigger").
 *
 * When `config_revision` changes the cached dataset is wholesale invalid. We do **not** simply
 * `Dexie.delete()`: unsynced orders, the outbox, the audit log and the device credentials must
 * survive, otherwise a config change during a shift destroys money and un-pairs the till.
 */
export async function resetForConfigRevision(db: PosDb, nextRevision: number): Promise<{ preservedOrders: number }> {
    const staticTables = LOAD_ORDER.filter((entity) => !UUID_KEYED_ENTITIES.has(entity))
        .map((entity) => tableFor(db, entity))
        .filter((t): t is Table<unknown, string | number> => t !== null);

    let preservedOrders = 0;

    await db.transaction('rw', [...staticTables, db.orders, db.lines, db.payments, db.courses, db.meta], async () => {
        for (const table of staticTables) await table.clear();

        // Orders: keep everything not yet acknowledged by the server; drop the rest, it is
        // re-fetchable and possibly priced against a stale catalog.
        const orders = await db.orders.toArray();
        const disposable = orders.filter((o) => o.syncState === 'synced' && o.state !== 'draft');
        preservedOrders = orders.length - disposable.length;

        const uuids = disposable.map((o) => o.uuid as string);
        if (uuids.length > 0) {
            await db.orders.bulkDelete(uuids);
            await db.lines.where('order_uuid').anyOf(uuids).delete();
            await db.payments.where('order_uuid').anyOf(uuids).delete();
            await db.courses.where('order_uuid').anyOf(uuids).delete();
        }

        // Every watermark is void; the next pull must be a full bootstrap.
        const metaRows = await db.meta.toArray();
        const watermarks = metaRows.filter((r) => r.key.startsWith('watermark.')).map((r) => r.key);
        if (watermarks.length > 0) await db.meta.bulkDelete(watermarks);
        await db.meta.delete(META.bootstrapEtag);
        await db.meta.put({ key: META.configRevision, value: nextRevision });
    });

    return { preservedOrders };
}

/**
 * Nuclear option — used only by "unpair this device" in the settings screen, never automatically.
 * Refuses while unsynced orders exist unless explicitly forced.
 */
export async function destroyDatabase(configId: number, options?: { force?: boolean }): Promise<void> {
    if (options?.force !== true) {
        const db = new (await import('./schema')).PosDb(configId);
        const unsynced = await db.orders.where('syncState').notEqual('synced').count();
        db.close();
        if (unsynced > 0) {
            throw new Error(`Refusing to wipe: ${unsynced} order(s) have not reached the server.`);
        }
    }
    await Dexie.delete(dbNameFor(configId));
}

/** Read a meta value with a default. */
export async function getMeta<T>(db: PosDb, key: string, fallback: T): Promise<T> {
    const row = await db.meta.get(key);
    return row === undefined ? fallback : (row.value as T);
}

export async function setMeta(db: PosDb, key: string, value: unknown): Promise<void> {
    await db.meta.put({ key, value });
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory catalog projection
// ─────────────────────────────────────────────────────────────────────────────

export type CatalogSnapshot = {
    version: number;
    products: ProductRow[];
    variants: ProductVariantRow[];
    categories: PosCategoryRow[];
    productsById: Map<number, ProductRow>;
    variantsById: Map<number, ProductVariantRow>;
    variantsByProduct: Map<number, ProductVariantRow[]>;
    barcodeIndex: Map<string, ProductVariantRow>;
};

/**
 * Load the catalog into memory in one read transaction.
 *
 * The register must be interactive *before* the network is consulted, so this is on the critical
 * path: ~120 ms for 5 000 products on a 2019 tablet. The `CatalogSource` shape exists so this can
 * later move into a worker without touching call sites.
 */
export async function loadCatalog(db: PosDb, version: number): Promise<CatalogSnapshot> {
    const [products, variants, categories] = await db.transaction(
        'r',
        [db.products, db.variants, db.posCategories],
        async () => [await db.products.toArray(), await db.variants.toArray(), await db.posCategories.toArray()],
    );

    const productsById = new Map(products.map((p) => [p.id, p]));
    const variantsById = new Map(variants.map((v) => [v.id, v]));
    const variantsByProduct = new Map<number, ProductVariantRow[]>();
    const barcodeIndex = new Map<string, ProductVariantRow>();

    for (const variant of variants) {
        const bucket = variantsByProduct.get(variant.product_id);
        if (bucket) bucket.push(variant);
        else variantsByProduct.set(variant.product_id, [variant]);
        if (variant.barcode) barcodeIndex.set(variant.barcode, variant);
    }

    return { version, products, variants, categories, productsById, variantsById, variantsByProduct, barcodeIndex };
}

/** Substring search over the precomputed field. Returns variants, ranked prefix-matches first. */
export function searchCatalog(catalog: CatalogSnapshot, query: string, limit = 100): ProductVariantRow[] {
    const needle = normalizeSearch(query);
    if (needle === '') return [];

    const prefix: ProductVariantRow[] = [];
    const substring: ProductVariantRow[] = [];

    for (const variant of catalog.variants) {
        const index = variant.searchText.indexOf(needle);
        if (index === 0) prefix.push(variant);
        else if (index > 0) substring.push(variant);
        if (prefix.length >= limit) break;
    }

    return [...prefix, ...substring].slice(0, limit);
}

/** Customer search by name or by typed digits — both go through the precomputed fields. */
export async function searchCustomers(db: PosDb, query: string, limit = 50): Promise<CustomerRow[]> {
    const digits = query.replace(/\D+/g, '');
    if (digits.length >= 3) {
        const byPhone = await db.customers
            .filter((c) => c.phoneDigits.includes(digits))
            .limit(limit)
            .toArray();
        if (byPhone.length > 0) return byPhone;
    }
    const needle = normalizeSearch(query);
    if (needle === '') return [];
    return db.customers
        .filter((c) => c.searchText.includes(needle))
        .limit(limit)
        .toArray();
}
