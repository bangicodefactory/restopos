import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_RETENTION_DAYS,
    PRESSURE_RETENTION_DAYS,
    QUOTA_CRITICAL_RATIO,
    QUOTA_WARN_RATIO,
    checkQuota,
    disposableOrderUuids,
    dropImageCaches,
    enforceQuota,
    isQuotaError,
    pruneAuditLog,
    pruneOrders,
    requestPersistence,
    withQuotaRescue,
} from './quota';
import { PosDb, dbNameFor } from './schema';

/**
 * Unit coverage for spec 03 §8.6.
 *
 * The invariant under test throughout: **no deletion path may touch an order whose `syncState` is
 * not `synced`.** Everything else here is retention policy; that one is money.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-28T12:00:00.000Z');

let configId = 6000;
let db: PosDb;

beforeEach(() => {
    configId += 1;
    db = new PosDb(configId);
});

afterEach(async () => {
    db.close();
    await Dexie.delete(dbNameFor(configId));
});

type OrderSeed = {
    uuid: string;
    state?: string;
    syncState?: string;
    ageDays?: number;
};

async function seedOrders(...orders: OrderSeed[]): Promise<void> {
    await db.orders.bulkPut(
        orders.map((o) => ({
            uuid: o.uuid,
            id: 1,
            state: o.state ?? 'done',
            syncState: o.syncState ?? 'synced',
            updatedAtLocal: NOW - (o.ageDays ?? 90) * DAY,
        })) as never[],
    );
}

describe('disposableOrderUuids', () => {
    it('offers only settled, synced, un-queued orders past the retention window', async () => {
        await seedOrders(
            { uuid: 'old-done' },
            { uuid: 'old-cancelled', state: 'cancelled' },
            { uuid: 'recent-done', ageDays: 1 },
            { uuid: 'old-draft', state: 'draft' },
            { uuid: 'old-paid', state: 'paid' },
        );

        expect((await disposableOrderUuids(db, { now: NOW })).sort()).toEqual(['old-cancelled', 'old-done']);
    });

    it.each(['local', 'queued', 'syncing', 'error', 'quarantined'])(
        'never offers an order in syncState %s, however old',
        async (syncState) => {
            await seedOrders({ uuid: 'unsynced', syncState, ageDays: 3650 });
            expect(await disposableOrderUuids(db, { now: NOW })).toEqual([]);
        },
    );

    it('never offers an order that still has an outbox entry', async () => {
        await seedOrders({ uuid: 'queued-order' });
        await db.outbox.put({
            id: 'e1',
            seq: 1,
            kind: 'order.sync',
            payload: {},
            targetUuid: 'queued-order',
            state: 'pending',
            attempts: 0,
            nextAttemptAt: 0,
            lastError: null,
            createdAt: 0,
            barrier: false,
        } as never);

        expect(await disposableOrderUuids(db, { now: NOW })).toEqual([]);
    });

    it('honours a shorter retention window', async () => {
        await seedOrders({ uuid: 'ten-days', ageDays: 10 });

        expect(await disposableOrderUuids(db, { now: NOW, retentionDays: DEFAULT_RETENTION_DAYS })).toEqual([]);
        expect(await disposableOrderUuids(db, { now: NOW, retentionDays: PRESSURE_RETENTION_DAYS })).toEqual([
            'ten-days',
        ]);
    });
});

describe('pruneOrders', () => {
    it('deletes the order and everything hanging off it', async () => {
        await seedOrders({ uuid: 'old' }, { uuid: 'keep', syncState: 'local' });
        await db.lines.bulkPut([
            { uuid: 'l1', order_uuid: 'old' },
            { uuid: 'l2', order_uuid: 'old' },
            { uuid: 'l3', order_uuid: 'keep' },
        ] as never[]);
        await db.payments.bulkPut([{ uuid: 'p1', order_uuid: 'old' }] as never[]);
        await db.courses.bulkPut([{ uuid: 'c1', order_uuid: 'old' }] as never[]);
        await db.approvals.bulkPut([{ uuid: 'a1', order_uuid: 'old' }] as never[]);

        const result = await pruneOrders(db, { now: NOW });

        expect(result).toMatchObject({ ordersDeleted: 1, linesDeleted: 2 });
        expect((await db.orders.toArray()).map((o) => o.uuid)).toEqual(['keep']);
        expect((await db.lines.toArray()).map((l) => l.uuid)).toEqual(['l3']);
        expect(await db.payments.count()).toBe(0);
        expect(await db.courses.count()).toBe(0);
        expect(await db.approvals.count()).toBe(0);
    });

    it('is a cheap no-op when nothing is disposable', async () => {
        await seedOrders({ uuid: 'fresh', ageDays: 1 });
        expect(await pruneOrders(db, { now: NOW })).toEqual({
            ordersDeleted: 0,
            linesDeleted: 0,
            auditDeleted: 0,
            blobsDeleted: 0,
            caches: [],
        });
    });
});

describe('pruneAuditLog', () => {
    it('vacuums only entries the server already has', async () => {
        await db.auditLog.bulkPut([
            { uuid: 'a1', kind: 'x', at: '', payload: {}, syncedAt: NOW - 30 * DAY },
            { uuid: 'a2', kind: 'x', at: '', payload: {}, syncedAt: NOW - 1 * DAY },
            { uuid: 'a3', kind: 'x', at: '', payload: {}, syncedAt: null },
        ] as never[]);

        expect(await pruneAuditLog(db, 14 * DAY, NOW)).toBe(1);
        expect((await db.auditLog.toArray()).map((e) => e.uuid).sort()).toEqual(['a2', 'a3']);
    });

    it('returns 0 when there is nothing stale', async () => {
        expect(await pruneAuditLog(db, 14 * DAY, NOW)).toBe(0);
    });
});

describe('checkQuota', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('reports unknown when the browser exposes no estimate', async () => {
        vi.stubGlobal('navigator', {});
        expect(await checkQuota()).toEqual({ level: 'unknown', usage: 0, quota: 0, ratio: 0, persisted: false });
    });

    it.each([
        { usage: 10, quota: 100, level: 'ok' },
        { usage: QUOTA_WARN_RATIO * 100 + 1, quota: 100, level: 'warn' },
        { usage: QUOTA_CRITICAL_RATIO * 100 + 1, quota: 100, level: 'critical' },
    ])('classifies $usage/$quota as $level', async ({ usage, quota, level }) => {
        vi.stubGlobal('navigator', {
            storage: { estimate: async () => ({ usage, quota }), persisted: async () => true },
        });

        const state = await checkQuota();
        expect(state.level).toBe(level);
        expect(state.persisted).toBe(true);
        expect(state.ratio).toBeCloseTo(usage / quota, 6);
    });
});

describe('requestPersistence', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('is false when the API is missing', async () => {
        vi.stubGlobal('navigator', {});
        expect(await requestPersistence()).toBe(false);
    });

    it('does not re-ask once already granted', async () => {
        const persist = vi.fn(async () => true);
        vi.stubGlobal('navigator', { storage: { persist, persisted: async () => true } });

        expect(await requestPersistence()).toBe(true);
        expect(persist).not.toHaveBeenCalled();
    });

    it('asks when not yet persisted', async () => {
        const persist = vi.fn(async () => false);
        vi.stubGlobal('navigator', { storage: { persist, persisted: async () => false } });

        expect(await requestPersistence()).toBe(false);
        expect(persist).toHaveBeenCalledOnce();
    });
});

describe('dropImageCaches', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('is a no-op without a Cache Storage API', async () => {
        vi.stubGlobal('caches', undefined);
        expect(await dropImageCaches()).toEqual([]);
    });

    it('drops only the image caches', async () => {
        const deleted: string[] = [];
        vi.stubGlobal('caches', {
            keys: async () => ['pos-shell-v1', 'product-images-v3', 'images-misc'],
            delete: async (name: string) => {
                deleted.push(name);
                return true;
            },
        });

        expect(await dropImageCaches()).toEqual(['product-images-v3', 'images-misc']);
        expect(deleted).toEqual(['product-images-v3', 'images-misc']);
    });
});

describe('enforceQuota escalation ladder', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    beforeEach(async () => {
        vi.stubGlobal('caches', { keys: async () => ['product-images-v1'], delete: async () => true });
        await db.blobs.bulkPut([
            { key: 'product:1', blob: null, contentType: 'image/png', fetchedAt: 0 },
            { key: 'logo:1', blob: null, contentType: 'image/png', fetchedAt: 0 },
        ] as never[]);
        await db.auditLog.put({ uuid: 'a1', kind: 'x', at: '', payload: {}, syncedAt: 0 } as never);
    });

    it('at "ok" it only prunes at the normal retention and touches no caches', async () => {
        const result = await enforceQuota(db, { level: 'ok', usage: 1, quota: 10, ratio: 0.1, persisted: true });

        expect(result.level).toBe('ok');
        expect(result.caches).toEqual([]);
        expect(result.blobsDeleted).toBe(0);
        expect(await db.blobs.count()).toBe(2);
    });

    it('at "warn" it vacuums the audit log but keeps the images', async () => {
        const result = await enforceQuota(db, { level: 'warn', usage: 8, quota: 10, ratio: 0.8, persisted: true });

        expect(result.auditDeleted).toBe(1);
        expect(result.caches).toEqual([]);
        expect(await db.blobs.count()).toBe(2);
    });

    it('at "critical" it also drops the image caches and the product blobs, keeping receipt assets', async () => {
        const result = await enforceQuota(db, {
            level: 'critical',
            usage: 95,
            quota: 100,
            ratio: 0.95,
            persisted: false,
        });

        expect(result.caches).toEqual(['product-images-v1']);
        expect(result.blobsDeleted).toBe(1);
        expect((await db.blobs.toArray()).map((b) => b.key)).toEqual(['logo:1']);
    });

    it('never evicts an unsynced order, even under critical pressure', async () => {
        await seedOrders({ uuid: 'unsynced', syncState: 'local', ageDays: 3650 });

        await enforceQuota(db, { level: 'critical', usage: 99, quota: 100, ratio: 0.99, persisted: false });

        expect(await db.orders.get('unsynced')).toBeDefined();
    });
});

describe('isQuotaError', () => {
    it.each([
        { error: Object.assign(new Error('boom'), { name: 'QuotaExceededError' }), expected: true },
        { error: new Error('the Quota is full'), expected: true },
        { error: new Error('network down'), expected: false },
        { error: 'not an error', expected: false },
        { error: null, expected: false },
    ])('classifies %o', ({ error, expected }) => {
        expect(isQuotaError(error)).toBe(expected);
    });
});

describe('withQuotaRescue', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('passes a successful write straight through', async () => {
        const write = vi.fn(async () => 'ok');
        expect(await withQuotaRescue(db, write)).toBe('ok');
        expect(write).toHaveBeenCalledOnce();
    });

    it('frees space and retries once on a quota error', async () => {
        vi.stubGlobal('caches', { keys: async () => ['product-images-v1'], delete: async () => true });
        const write = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(Object.assign(new Error('full'), { name: 'QuotaExceededError' }))
            .mockResolvedValueOnce('written');

        expect(await withQuotaRescue(db, write)).toBe('written');
        expect(write).toHaveBeenCalledTimes(2);
    });

    it('rethrows anything that is not a quota error without retrying', async () => {
        const write = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('constraint violation'));
        await expect(withQuotaRescue(db, write)).rejects.toThrow('constraint violation');
        expect(write).toHaveBeenCalledOnce();
    });
});
