import 'fake-indexeddb/auto';

import type { OrderCommand, SyncPushRequest, SyncPushResponse, SyncRecordResult } from '@domain/sync/wire';
import type { Uuid } from '@domain/types';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PosDb, dbNameFor } from '../db';
import { ApiClient } from './http';
import { OutboxSyncer, type SyncEvent } from './outbox-syncer';

/**
 * Unit coverage for spec 03 §3.6 — the push engine.
 *
 * The three rules under test, in the order the module states them: never block the sale, never lose
 * money, never double-post.
 */

const uuid = (value: string): Uuid => value as Uuid;

let configId = 7000;
let db: PosDb;
let syncer: OutboxSyncer;
let fetchImpl: ReturnType<typeof vi.fn>;
let requests: Array<{ url: string; body: SyncPushRequest; headers: Record<string, string> }>;
let events: SyncEvent[];

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** Swapped per test; the recording wrapper around it stays in place. */
let responder: () => Response;

function respondWith(results: SyncRecordResult[]): void {
    responder = () =>
        jsonResponse({ server_time: '2026-07-28T12:00:00.000Z', results } satisfies SyncPushResponse);
}

function respondWithStatus(status: number): void {
    responder = () => jsonResponse({ message: 'boom' }, status);
}

function respondWithNetworkFailure(): void {
    responder = () => {
        throw new TypeError('Failed to fetch');
    };
}

function orderCommand(id: string, overrides: Partial<OrderCommand> = {}): OrderCommand {
    return {
        uuid: uuid(id),
        op: 'upsert',
        base_rev: null,
        order: { state: 'draft' },
        lines: [],
        payments: [],
        courses: [],
        approvals: [],
        ...overrides,
    };
}

function ok(id: string, extra: Partial<SyncRecordResult> = {}): SyncRecordResult {
    return { uuid: uuid(id), status: 'ok', server_rev: 'rev-1', ...extra };
}

/** Give the fire-and-forget drain kicked off by `start()` a chance to settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
    configId += 1;
    db = new PosDb(configId);
    requests = [];
    events = [];

    responder = () => jsonResponse({ server_time: '2026-07-28T12:00:00.000Z', results: [] });
    fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
        requests.push({
            url,
            body: JSON.parse(String(init.body)) as SyncPushRequest,
            headers: (init.headers ?? {}) as Record<string, string>,
        });
        return responder();
    });

    const api = new ApiClient({
        token: () => 'device-token',
        clientVersion: '1.2.3',
        fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    syncer = new OutboxSyncer({
        api,
        db,
        configId,
        deviceId: () => 'device-1',
        employeeId: () => 42,
        clientVersion: '1.2.3',
        pollIntervalMs: 60_000,
    });
    syncer.subscribe((event) => events.push(event));

    // The queue is empty here, so `start()`'s eager drain is a no-op and arms no timer.
    await syncer.start();
    await settle();
});

afterEach(async () => {
    syncer.stop();
    // Let the fire-and-forget `stats()` in drain's finally block land before the handle goes away.
    await settle();
    vi.unstubAllGlobals();
    db.close();
    await Dexie.delete(dbNameFor(configId));
});

// ─────────────────────────────────────────────────────────────────────────────

describe('draining the queue', () => {
    it('sends every claimable order in one request and clears the entries', async () => {
        respondWith([ok('order-a'), ok('order-b')]);
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-b'), targetUuid: uuid('order-b') });

        const result = await syncer.drain();

        expect(result).toEqual({ sent: 2, failed: 0 });
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(requests[0]?.body.orders.map((o) => o.uuid)).toEqual(['order-a', 'order-b']);
        expect(await db.outbox.count()).toBe(0);
    });

    it('carries the device, employee, version and an idempotency key', async () => {
        respondWith([ok('order-a')]);
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });

        await syncer.drain();

        expect(requests[0]?.url).toBe('/api/pos/sync');
        expect(requests[0]?.body).toMatchObject({
            device_id: 'device-1',
            employee_id: 42,
            client_version: '1.2.3',
        });
        expect(requests[0]?.headers['Idempotency-Key']).toMatch(/[0-9a-f-]{36}/);
        expect(requests[0]?.headers['Authorization']).toBe('Bearer device-token');
    });

    it('sends non-order intents as commands rather than orders', async () => {
        const entry = await syncer.outbox.enqueue({ kind: 'session.cash_move', payload: { amount: '20.00' } });
        respondWith([ok(entry.id)]);

        await syncer.drain();

        expect(requests[0]?.body.orders).toEqual([]);
        expect(requests[0]?.body.commands).toEqual([
            expect.objectContaining({ uuid: entry.id, kind: 'session.cash_move', payload: { amount: '20.00' } }),
        ]);
    });

    it('respects the parallelism cap and drains the rest on the next pass', async () => {
        syncer = new OutboxSyncer({
            api: new ApiClient({
                token: () => null,
                clientVersion: '1.2.3',
                fetchImpl: fetchImpl as unknown as typeof fetch,
            }),
            db,
            configId,
            deviceId: () => 'device-1',
            employeeId: () => null,
            clientVersion: '1.2.3',
            parallelism: 2,
            pollIntervalMs: 60_000,
        });
        await syncer.start();
        await settle();

        for (const id of ['a', 'b', 'c']) {
            await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand(id), targetUuid: uuid(id) });
        }
        respondWith([ok('a'), ok('b'), ok('c')]);

        expect(await syncer.drain()).toEqual({ sent: 2, failed: 0 });
        expect(await syncer.drain()).toEqual({ sent: 1, failed: 0 });
    });

    it('emits drain:start / entry:ok / drain:end', async () => {
        respondWith([ok('order-a')]);
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });

        events.length = 0;
        await syncer.drain();

        expect(events.map((e) => e.type)).toEqual(
            expect.arrayContaining(['drain:start', 'entry:ok', 'drain:end']),
        );
    });

    it('is a no-op on an empty queue', async () => {
        expect(await syncer.drain()).toEqual({ sent: 0, failed: 0 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('per-record results', () => {
    it('hands every result to onResult before deciding what to do with the entry', async () => {
        const onResult = vi.fn();
        syncer = new OutboxSyncer({
            api: new ApiClient({
                token: () => null,
                clientVersion: '1.2.3',
                fetchImpl: fetchImpl as unknown as typeof fetch,
            }),
            db,
            configId,
            deviceId: () => 'device-1',
            employeeId: () => null,
            clientVersion: '1.2.3',
            onResult,
            pollIntervalMs: 60_000,
        });
        await syncer.start();
        await settle();

        const good = ok('order-a', {
            order: {
                id: 501,
                name: 'SALLE/0042',
                sequence_number: 42,
                access_token: 'server-minted-token',
                state: 'paid',
                amount_untaxed: '10.00',
                amount_tax: '2.00',
                amount_total: '12.00',
                amount_paid: '12.00',
                amount_change: '0.00',
                amount_due: '0.00',
                updated_at: '2026-07-28T12:00:00.000Z',
            },
            lines: [{ uuid: uuid('line-1'), id: 9001, price_subtotal: '10.00', price_subtotal_incl: '12.00' }],
        });
        respondWith([good]);
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });

        await syncer.drain();

        expect(onResult).toHaveBeenCalledExactlyOnceWith(good);
    });

    it('treats "superseded" as done, exactly like "ok"', async () => {
        respondWith([{ uuid: uuid('order-a'), status: 'superseded', server_rev: 'rev-9' }]);
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });

        expect(await syncer.drain()).toEqual({ sent: 1, failed: 0 });
        expect(await db.outbox.count()).toBe(0);
    });

    it('retries rather than dropping a record the server said nothing about', async () => {
        respondWith([]);
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });

        expect(await syncer.drain()).toEqual({ sent: 0, failed: 1 });

        const [entry] = await db.outbox.toArray();
        expect(entry?.state).toBe('pending');
        expect(entry?.lastError).toMatchObject({ kind: 'unknown' });
    });
});

describe('quarantine — one poisoned order never blocks the queue', () => {
    it('quarantines a rejected record and still delivers the rest', async () => {
        respondWith([
            ok('order-a'),
            {
                uuid: uuid('order-b'),
                status: 'rejected',
                server_rev: null,
                error: { code: 'closed_session', message: 'Session is closed' },
            },
            ok('order-c'),
        ]);
        for (const id of ['order-a', 'order-b', 'order-c']) {
            await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand(id), targetUuid: uuid(id) });
        }

        const result = await syncer.drain();

        expect(result).toEqual({ sent: 2, failed: 1 });

        const remaining = await db.outbox.toArray();
        expect(remaining).toHaveLength(1);
        expect(remaining[0]).toMatchObject({
            targetUuid: 'order-b',
            state: 'quarantined',
            lastError: { kind: 'rejected', code: 'closed_session', message: 'Session is closed' },
        });
        expect(events.filter((e) => e.type === 'entry:quarantined')).toHaveLength(1);
    });

    it('a quarantined entry is never claimed again', async () => {
        respondWith([
            {
                uuid: uuid('order-b'),
                status: 'rejected',
                server_rev: null,
                error: { code: 'price_tamper', message: 'no' },
            },
        ]);
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-b'), targetUuid: uuid('order-b') });
        await syncer.drain();

        fetchImpl.mockClear();
        expect(await syncer.drain()).toEqual({ sent: 0, failed: 0 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('quarantines a conflict so the caller can re-diff instead of blindly retrying', async () => {
        respondWith([
            {
                uuid: uuid('order-a'),
                status: 'conflict',
                server_rev: 'rev-4',
                conflict: { code: 'stale_write', message: 'newer server state', serverState: { rev: 4 } },
            },
        ]);
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });

        expect(await syncer.drain()).toEqual({ sent: 0, failed: 1 });

        const [entry] = await db.outbox.toArray();
        expect(entry).toMatchObject({
            state: 'quarantined',
            lastError: { kind: 'conflict', reason: 'stale_write', serverState: { rev: 4 } },
        });
    });

    it('retryAll un-quarantines everything a manager asks to retry', async () => {
        respondWith([
            { uuid: uuid('order-a'), status: 'rejected', server_rev: null, error: { code: 'x', message: 'y' } },
        ]);
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });
        await syncer.drain();

        expect(await syncer.outbox.retryAll()).toBe(1);

        respondWith([ok('order-a')]);
        expect(await syncer.drain()).toEqual({ sent: 1, failed: 0 });
    });
});

describe('transport failures and backoff', () => {
    it('fails the whole batch on a 500 — nothing left the device', async () => {
        respondWithStatus(503);
        for (const id of ['order-a', 'order-b']) {
            await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand(id), targetUuid: uuid(id) });
        }

        expect(await syncer.drain()).toEqual({ sent: 0, failed: 2 });

        const entries = await db.outbox.toArray();
        expect(entries).toHaveLength(2);
        for (const entry of entries) {
            expect(entry.state).toBe('pending');
            expect(entry.attempts).toBe(1);
            expect(entry.lastError).toMatchObject({ kind: 'server_unreachable', status: 503 });
        }
        expect(events.filter((e) => e.type === 'entry:failed')).toHaveLength(2);
    });

    it('backs the entry off so the next drain does not hammer the server', async () => {
        respondWithStatus(500);
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });

        await syncer.drain();
        const backedOff = (await db.outbox.toArray())[0];
        expect(backedOff?.nextAttemptAt).toBeGreaterThan(Date.now());

        fetchImpl.mockClear();
        expect(await syncer.drain()).toEqual({ sent: 0, failed: 0 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('retries once the backoff has elapsed, and the attempt count keeps climbing', async () => {
        respondWithStatus(500);
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });
        await syncer.drain();

        // Fast-forward the backoff instead of waiting on a real timer.
        const stored = (await db.outbox.toArray())[0];
        await db.outbox.put({ ...(stored as NonNullable<typeof stored>), nextAttemptAt: Date.now() - 1 });

        respondWith([ok('order-a')]);
        expect(await syncer.drain()).toEqual({ sent: 1, failed: 0 });
        expect(await db.outbox.count()).toBe(0);
    });

    it('never quarantines a network error — a till offline for six hours must still be trying', async () => {
        respondWithNetworkFailure();
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });

        await syncer.drain();

        const [entry] = await db.outbox.toArray();
        expect(entry?.state).toBe('pending');
        expect(entry?.lastError).toMatchObject({ kind: 'offline' });
    });
});

describe('offline behaviour', () => {
    it('does not even try while the browser reports offline', async () => {
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });
        vi.stubGlobal('navigator', { onLine: false });

        expect(await syncer.drain()).toEqual({ sent: 0, failed: 0 });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(await db.outbox.count()).toBe(1);
    });

    it('queueing keeps working offline and drains when the link returns', async () => {
        vi.stubGlobal('navigator', { onLine: false });
        for (const id of ['order-a', 'order-b']) {
            await syncer.enqueueOrder(orderCommand(id));
        }
        expect(await db.outbox.count()).toBe(2);
        expect(fetchImpl).not.toHaveBeenCalled();

        vi.stubGlobal('navigator', { onLine: true });
        respondWith([ok('order-a'), ok('order-b')]);

        expect(await syncer.drain()).toEqual({ sent: 2, failed: 0 });
    });
});

describe('coalescing and recovery', () => {
    it('coalesces repeated pushes for the same order into one pending entry (create → update)', async () => {
        vi.stubGlobal('navigator', { onLine: false });

        await syncer.enqueueOrder(
            orderCommand('order-a', {
                base_rev: null,
                lines: [{ op: 'create', uuid: uuid('line-1'), quantity: 1 }],
            }),
        );
        await syncer.enqueueOrder(
            orderCommand('order-a', {
                base_rev: 'rev-1',
                lines: [{ op: 'update', uuid: uuid('line-1'), quantity: 3 }],
            }),
        );

        expect(await db.outbox.count()).toBe(1);

        vi.stubGlobal('navigator', { onLine: true });
        respondWith([ok('order-a')]);
        await syncer.drain();

        // Only the latest command is ever sent — the queue stays bounded during an outage.
        expect(requests).toHaveLength(1);
        expect(requests[0]?.body.orders[0]).toMatchObject({
            base_rev: 'rev-1',
            lines: [{ op: 'update', uuid: 'line-1', quantity: 3 }],
        });
    });

    it('recovers entries a crash left inflight', async () => {
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });
        const claimed = await syncer.outbox.claim(1);
        expect(claimed).toHaveLength(1);
        expect((await db.outbox.toArray())[0]?.state).toBe('inflight');

        expect(await syncer.outbox.recoverInflight()).toBe(1);
        expect((await db.outbox.toArray())[0]?.state).toBe('pending');
    });

    it('reports stats and blocks a session close while anything is unsent', async () => {
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });

        const stats = await syncer.stats();
        expect(stats).toMatchObject({ total: 1, pending: 1, quarantined: 0, blocksSessionClose: true });
        expect(events.at(-1)).toMatchObject({ type: 'stats' });

        respondWith([ok('order-a')]);
        await syncer.drain();
        expect(await syncer.stats()).toMatchObject({ total: 0, blocksSessionClose: false });
    });

    it('drains a session barrier on its own', async () => {
        const barrier = await syncer.outbox.enqueue({
            kind: 'session.close',
            payload: { session_id: 1 },
            barrier: true,
        });
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });

        respondWith([ok(barrier.id)]);
        expect(await syncer.drain()).toEqual({ sent: 1, failed: 0 });
        expect(requests.at(-1)?.body.orders).toEqual([]);
        expect(requests.at(-1)?.body.commands).toHaveLength(1);
    });

    it('a stopped syncer drains nothing', async () => {
        await syncer.outbox.enqueue({ kind: 'order.sync', payload: orderCommand('order-a'), targetUuid: uuid('order-a') });
        syncer.stop();

        expect(await syncer.drain()).toEqual({ sent: 0, failed: 0 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
