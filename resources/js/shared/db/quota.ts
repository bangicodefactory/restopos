import type { PosDb } from './schema';

/**
 * Storage quota guards (spec 03 §8.6).
 *
 * The invariant this file exists to protect:
 *
 *   **Order data is never pruned while `syncState !== 'synced'`.**
 *
 * A pruner that can delete an unsynced sale is a defect, not a trade-off. Every deletion path here
 * goes through `disposableOrderUuids()`, which is unit-tested for exactly that.
 */

export type QuotaLevel = 'ok' | 'warn' | 'critical' | 'unknown';

export type QuotaState = {
    level: QuotaLevel;
    usage: number;
    quota: number;
    ratio: number;
    persisted: boolean;
};

export const QUOTA_WARN_RATIO = 0.7;
export const QUOTA_CRITICAL_RATIO = 0.9;

/** Local retention for synced orders, so the ticket list and reprints work offline. */
export const DEFAULT_RETENTION_DAYS = 30;
/** Shorter retention used when the pruner runs under pressure. */
export const PRESSURE_RETENTION_DAYS = 7;

export async function checkQuota(): Promise<QuotaState> {
    const storage = globalThis.navigator?.storage;
    if (!storage?.estimate) {
        return { level: 'unknown', usage: 0, quota: 0, ratio: 0, persisted: false };
    }
    const { usage = 0, quota = 0 } = await storage.estimate();
    const ratio = quota > 0 ? usage / quota : 0;
    const persisted = (await storage.persisted?.()) ?? false;
    const level: QuotaLevel = ratio > QUOTA_CRITICAL_RATIO ? 'critical' : ratio > QUOTA_WARN_RATIO ? 'warn' : 'ok';
    return { level, usage, quota, ratio, persisted };
}

/**
 * Ask the browser to keep our data. Installed PWAs on Android grant this silently; iOS ignores it.
 * A refusal is a telemetry warning, never an error — the app still works, it is just evictable.
 */
export async function requestPersistence(): Promise<boolean> {
    const storage = globalThis.navigator?.storage;
    if (!storage?.persist) return false;
    if (await storage.persisted?.()) return true;
    return storage.persist();
}

/**
 * The single gate every deletion path must pass through.
 *
 * An order is disposable only when **all** of these hold:
 *   - it is fully synced (`syncState === 'synced'`);
 *   - it is finished (`done` or `cancelled`) — a draft is a live tab, even a synced one;
 *   - it has no entry left in the outbox;
 *   - it is older than the retention window.
 */
export async function disposableOrderUuids(
    db: PosDb,
    options: { retentionDays?: number; now?: number } = {},
): Promise<string[]> {
    const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const now = options.now ?? Date.now();
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

    const queued = new Set<string>();
    for (const entry of await db.outbox.toArray()) {
        if (entry.targetUuid !== null) queued.add(entry.targetUuid);
    }

    const orders = await db.orders.toArray();
    return orders
        .filter(
            (order) =>
                order.syncState === 'synced' &&
                (order.state === 'done' || order.state === 'cancelled') &&
                !queued.has(order.uuid) &&
                order.updatedAtLocal < cutoff,
        )
        .map((order) => order.uuid as string);
}

export type PruneResult = {
    ordersDeleted: number;
    linesDeleted: number;
    auditDeleted: number;
    blobsDeleted: number;
    caches: string[];
};

/** Delete old, fully-settled orders and their children. Runs on boot and hourly. */
export async function pruneOrders(db: PosDb, options: { retentionDays?: number; now?: number } = {}): Promise<PruneResult> {
    const uuids = await disposableOrderUuids(db, options);
    if (uuids.length === 0) {
        return { ordersDeleted: 0, linesDeleted: 0, auditDeleted: 0, blobsDeleted: 0, caches: [] };
    }

    let linesDeleted = 0;
    await db.transaction('rw', [db.orders, db.lines, db.payments, db.courses, db.approvals], async () => {
        linesDeleted = await db.lines.where('order_uuid').anyOf(uuids).delete();
        await db.payments.where('order_uuid').anyOf(uuids).delete();
        await db.courses.where('order_uuid').anyOf(uuids).delete();
        await db.approvals.where('order_uuid').anyOf(uuids).delete();
        await db.orders.bulkDelete(uuids);
    });

    return { ordersDeleted: uuids.length, linesDeleted, auditDeleted: 0, blobsDeleted: 0, caches: [] };
}

/** Vacuum synced audit entries older than the window. */
export async function pruneAuditLog(db: PosDb, olderThanMs = 14 * 24 * 60 * 60 * 1000, now = Date.now()): Promise<number> {
    const cutoff = now - olderThanMs;
    const stale = await db.auditLog.filter((e) => e.syncedAt !== null && e.syncedAt < cutoff).toArray();
    if (stale.length === 0) return 0;
    await db.auditLog.bulkDelete(stale.map((e) => e.uuid as string));
    return stale.length;
}

/** Product images are always re-fetchable, so they are the first thing to go. */
export async function dropImageCaches(): Promise<string[]> {
    const caches = globalThis.caches;
    if (!caches) return [];
    const names = await caches.keys();
    const droppable = names.filter((name) => name.includes('product-images') || name.includes('images'));
    for (const name of droppable) await caches.delete(name);
    return droppable;
}

/**
 * The escalation ladder run at boot and hourly.
 *
 *   warn     → prune old orders at the shorter retention, vacuum the audit log
 *   critical → the above, plus drop the entire image cache and raise a manager banner
 */
export async function enforceQuota(db: PosDb, state?: QuotaState): Promise<PruneResult & { level: QuotaLevel }> {
    const quota = state ?? (await checkQuota());
    const result: PruneResult & { level: QuotaLevel } = {
        level: quota.level,
        ordersDeleted: 0,
        linesDeleted: 0,
        auditDeleted: 0,
        blobsDeleted: 0,
        caches: [],
    };

    if (quota.level === 'ok' || quota.level === 'unknown') {
        const pruned = await pruneOrders(db);
        return { ...result, ...pruned, level: quota.level };
    }

    const retentionDays = quota.level === 'critical' ? PRESSURE_RETENTION_DAYS : DEFAULT_RETENTION_DAYS;
    const pruned = await pruneOrders(db, { retentionDays });
    const auditDeleted = await pruneAuditLog(db);
    const caches = quota.level === 'critical' ? await dropImageCaches() : [];

    let blobsDeleted = 0;
    if (quota.level === 'critical') {
        // Keep receipt-critical blobs (logo, fonts); evict cached product imagery.
        const evictable = await db.blobs.filter((b) => b.key.startsWith('product:')).toArray();
        await db.blobs.bulkDelete(evictable.map((b) => b.key));
        blobsDeleted = evictable.length;
    }

    return { ...result, ...pruned, auditDeleted, caches, blobsDeleted, level: quota.level };
}

/**
 * A `QuotaExceededError` while writing to the outbox is a P0: we are about to lose a sale.
 * Drop every evictable cache, retry once, and if it still fails let the caller block new orders
 * with an unmissable error rather than silently swallowing the write.
 */
export async function withQuotaRescue<T>(db: PosDb, write: () => Promise<T>): Promise<T> {
    try {
        return await write();
    } catch (error) {
        if (!isQuotaError(error)) throw error;
        await dropImageCaches();
        await enforceQuota(db, { level: 'critical', usage: 0, quota: 0, ratio: 1, persisted: false });
        return write();
    }
}

export function isQuotaError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return error.name === 'QuotaExceededError' || /quota/i.test(error.message);
}
