import { beforeEach, describe, expect, it } from 'vitest';

import {
    DEFAULT_BACKOFF,
    Outbox,
    computeBackoff,
    createMemoryOutboxStorage,
    type OutboxStorage,
} from '../src/sync/outbox';
import { classifyHttpError, isRetryable } from '../src/sync/wire';
import type { Uuid } from '../src/types';

/** Unit coverage for docs/spec/03-architecture.md §3.6.4 and §3.6.6. */

const uuid = (s: string): Uuid => s as Uuid;

describe('backoff policy', () => {
    const noJitter = (): number => 1; // 0.5 + 1*0.5 = 1 → the full delay

    it('is zero before the first attempt', () => {
        expect(computeBackoff(0)).toBe(0);
    });

    it('keeps the first three attempts inside a few seconds', () => {
        for (let attempt = 1; attempt <= 3; attempt++) {
            expect(computeBackoff(attempt, DEFAULT_BACKOFF, noJitter)).toBeLessThanOrEqual(1_500);
        }
    });

    it('grows exponentially after the fast attempts', () => {
        expect(computeBackoff(4, DEFAULT_BACKOFF, noJitter)).toBe(1_000);
        expect(computeBackoff(5, DEFAULT_BACKOFF, noJitter)).toBe(2_000);
        expect(computeBackoff(6, DEFAULT_BACKOFF, noJitter)).toBe(4_000);
    });

    it('caps at 30 s', () => {
        for (let attempt = 10; attempt <= 20; attempt++) {
            expect(computeBackoff(attempt, DEFAULT_BACKOFF, noJitter)).toBeLessThanOrEqual(30_000);
        }
        expect(computeBackoff(19, DEFAULT_BACKOFF, noJitter)).toBe(30_000);
    });

    it('never stops retrying network errors — it slows to a 60 s beat instead', () => {
        expect(computeBackoff(500, DEFAULT_BACKOFF, noJitter)).toBe(60_000);
    });

    it('applies full jitter so a venue of tills does not retry in lockstep', () => {
        const low = computeBackoff(6, DEFAULT_BACKOFF, () => 0);
        const high = computeBackoff(6, DEFAULT_BACKOFF, () => 1);
        expect(low).toBe(2_000); // 4000 * 0.5
        expect(high).toBe(4_000);
        expect(low).toBeLessThan(high);
    });
});

describe('error classification', () => {
    it('treats a missing status as offline and retryable', () => {
        const error = classifyHttpError(undefined);
        expect(error.kind).toBe('offline');
        expect(isRetryable(error)).toBe(true);
    });

    it('never retries auth, version, validation or conflicts', () => {
        expect(isRetryable(classifyHttpError(401))).toBe(false);
        expect(isRetryable(classifyHttpError(410))).toBe(false);
        expect(isRetryable(classifyHttpError(426))).toBe(false);
        expect(isRetryable(classifyHttpError(422))).toBe(false);
        expect(isRetryable(classifyHttpError(409))).toBe(false);
    });

    it('retries 5xx', () => {
        expect(isRetryable(classifyHttpError(503))).toBe(true);
    });

    // BAN-442 — the server can now say *this one will never work*.
    it('still retries a 5xx that names no code, which is the default and the safe one', () => {
        // A till must not discard a sale because the server had a bad minute.
        expect(isRetryable(classifyHttpError(500))).toBe(true);
        expect(isRetryable(classifyHttpError(500, { error: { code: 'server_error' } }))).toBe(true);
    });

    it('quarantines a 5xx the server marks permanent', () => {
        // A constraint violation fails identically on every retry, and an entry that retries
        // forever blocks the session close forever — `blocksSessionClose` counts everything not
        // quarantined. Quarantine is not discard: it surfaces to a manager.
        const error = classifyHttpError(500, { error: { code: 'server_data_error', message: 'nope' } });

        expect(error.kind).toBe('rejected');
        expect(isRetryable(error)).toBe(false);
    });

    it('carries the code through so a manager sees why', () => {
        const error = classifyHttpError(500, { error: { code: 'server_data_error', message: 'nope' } });

        expect(error).toMatchObject({ code: 'server_data_error', message: 'nope' });
    });

    it('does not treat an unrecognised code as permanent', () => {
        // Anything not on the published list keeps retrying — the list is the contract, not the
        // presence of a code.
        expect(isRetryable(classifyHttpError(500, { error: { code: 'something_new' } }))).toBe(true);
    });
});

describe('Outbox', () => {
    let storage: OutboxStorage;
    let clock: number;
    let ids: number;
    let outbox: Outbox;

    beforeEach(() => {
        storage = createMemoryOutboxStorage();
        clock = 1_000;
        ids = 0;
        outbox = new Outbox({
            storage,
            now: () => clock,
            random: () => 1,
            newId: () => `id-${++ids}`,
        });
    });

    it('enqueues in monotonic sequence order', async () => {
        const a = await outbox.enqueue({ kind: 'order.sync', payload: 1, targetUuid: uuid('o1') });
        const b = await outbox.enqueue({ kind: 'order.sync', payload: 2, targetUuid: uuid('o2') });
        expect(a.seq).toBeLessThan(b.seq);
    });

    it('coalesces a pending entry for the same target instead of appending', async () => {
        const first = await outbox.enqueue({ kind: 'order.sync', payload: { v: 1 }, targetUuid: uuid('o1') });
        const second = await outbox.enqueue({ kind: 'order.sync', payload: { v: 2 }, targetUuid: uuid('o1') });

        expect(second.id).toBe(first.id);
        expect(second.seq).toBe(first.seq); // causal order preserved
        expect(second.payload).toEqual({ v: 2 });
        expect((await storage.all())).toHaveLength(1);
    });

    it('does not coalesce into an in-flight entry — it creates a follow-up', async () => {
        await outbox.enqueue({ kind: 'order.sync', payload: { v: 1 }, targetUuid: uuid('o1') });
        await outbox.claim();
        await outbox.enqueue({ kind: 'order.sync', payload: { v: 2 }, targetUuid: uuid('o1') });

        const all = await storage.all();
        expect(all).toHaveLength(2);
        expect(all[0]?.state).toBe('inflight');
        expect(all[1]?.state).toBe('pending');
    });

    it('claims at most one entry per target and honours the parallelism cap', async () => {
        for (const t of ['o1', 'o2', 'o3', 'o4', 'o5']) {
            await outbox.enqueue({ kind: 'order.sync', payload: t, targetUuid: uuid(t) });
        }
        const claimed = await outbox.claim(4);
        expect(claimed).toHaveLength(4);
        expect(new Set(claimed.map((e) => e.targetUuid)).size).toBe(4);
    });

    it('never claims a second entry for a target that is already in flight', async () => {
        await outbox.enqueue({ kind: 'order.sync', payload: 1, targetUuid: uuid('o1') });
        await outbox.claim();
        await outbox.enqueue({ kind: 'order.sync', payload: 2, targetUuid: uuid('o1') });
        expect(await outbox.claim()).toHaveLength(0);
    });

    it('drains a barrier entry alone', async () => {
        await outbox.enqueue({ kind: 'session.close', payload: {}, targetUuid: uuid('s1'), barrier: true });
        await outbox.enqueue({ kind: 'order.sync', payload: {}, targetUuid: uuid('o1') });

        const claimed = await outbox.claim(4);
        expect(claimed).toHaveLength(1);
        expect(claimed[0]?.kind).toBe('session.close');
    });

    it('blocks further claims while a barrier is in flight', async () => {
        await outbox.enqueue({ kind: 'session.close', payload: {}, targetUuid: uuid('s1'), barrier: true });
        await outbox.claim();
        await outbox.enqueue({ kind: 'order.sync', payload: {}, targetUuid: uuid('o1') });
        expect(await outbox.claim()).toHaveLength(0);
    });

    it('removes an entry on success', async () => {
        const entry = await outbox.enqueue({ kind: 'order.sync', payload: {}, targetUuid: uuid('o1') });
        await outbox.claim();
        await outbox.succeed(entry.id);
        expect(await storage.all()).toHaveLength(0);
    });

    it('backs a retryable failure off and returns it to pending', async () => {
        const entry = await outbox.enqueue({ kind: 'order.sync', payload: {}, targetUuid: uuid('o1') });
        await outbox.claim();
        const failed = await outbox.fail(entry.id, { kind: 'offline' });

        expect(failed?.state).toBe('pending');
        expect(failed?.attempts).toBe(1);
        expect(failed?.nextAttemptAt).toBeGreaterThan(clock);
        expect(await outbox.claim()).toHaveLength(0); // still backing off
    });

    it('becomes claimable again once the backoff elapses', async () => {
        const entry = await outbox.enqueue({ kind: 'order.sync', payload: {}, targetUuid: uuid('o1') });
        await outbox.claim();
        const failed = await outbox.fail(entry.id, { kind: 'server_unreachable', status: 503 });
        clock = (failed?.nextAttemptAt ?? 0) + 1;
        expect(await outbox.claim()).toHaveLength(1);
    });

    it('quarantines a permanent rejection without retrying', async () => {
        const entry = await outbox.enqueue({ kind: 'order.sync', payload: {}, targetUuid: uuid('o1') });
        await outbox.claim();
        const failed = await outbox.fail(entry.id, { kind: 'rejected', code: 'unknown_product', message: 'x' });

        expect(failed?.state).toBe('quarantined');
        clock += 10_000_000;
        expect(await outbox.claim()).toHaveLength(0);
    });

    it('flags long-failing entries as error but keeps retrying them', async () => {
        const entry = await outbox.enqueue({ kind: 'order.sync', payload: {}, targetUuid: uuid('o1') });
        for (let i = 0; i < DEFAULT_BACKOFF.errorAfterAttempts + 1; i++) {
            await outbox.claim();
            const failed = await outbox.fail(entry.id, { kind: 'offline' });
            clock = (failed?.nextAttemptAt ?? clock) + 1;
        }
        const stored = await storage.get(entry.id);
        expect(stored?.state).toBe('error');
        expect(await outbox.claim()).toHaveLength(1); // still trying at hour six
    });

    it('a failed order never blocks the next one — the single most important offline rule', async () => {
        const bad = await outbox.enqueue({ kind: 'order.sync', payload: 'bad', targetUuid: uuid('o411') });
        await outbox.claim();
        await outbox.fail(bad.id, { kind: 'rejected', code: 'x', message: 'y' });

        await outbox.enqueue({ kind: 'order.sync', payload: 'good', targetUuid: uuid('o412') });
        const claimed = await outbox.claim();
        expect(claimed).toHaveLength(1);
        expect(claimed[0]?.targetUuid).toBe('o412');
    });

    it('retryNow clears the backoff and un-quarantines', async () => {
        const entry = await outbox.enqueue({ kind: 'order.sync', payload: {}, targetUuid: uuid('o1') });
        await outbox.claim();
        await outbox.fail(entry.id, { kind: 'rejected', code: 'x', message: 'y' });
        await outbox.retryNow(entry.id);
        expect(await outbox.claim()).toHaveLength(1);
    });

    it('retryAll revives every stuck entry and reports how many', async () => {
        for (const t of ['o1', 'o2']) {
            const e = await outbox.enqueue({ kind: 'order.sync', payload: {}, targetUuid: uuid(t) });
            await outbox.claim();
            await outbox.fail(e.id, { kind: 'rejected', code: 'x', message: 'y' });
        }
        expect(await outbox.retryAll()).toBe(2);
        expect(await outbox.claim(4)).toHaveLength(2);
    });

    it('recovers entries stranded in flight by a crash', async () => {
        await outbox.enqueue({ kind: 'order.sync', payload: {}, targetUuid: uuid('o1') });
        await outbox.claim();
        expect(await outbox.recoverInflight()).toBe(1);
        expect(await outbox.claim()).toHaveLength(1);
    });

    it('reports stats and gates the session close on unsent work', async () => {
        expect((await outbox.stats()).blocksSessionClose).toBe(false);

        const entry = await outbox.enqueue({ kind: 'order.sync', payload: {}, targetUuid: uuid('o1') });
        expect((await outbox.stats()).blocksSessionClose).toBe(true);

        await outbox.claim();
        await outbox.fail(entry.id, { kind: 'rejected', code: 'x', message: 'y' });
        const stats = await outbox.stats();
        expect(stats.quarantined).toBe(1);
        // Quarantined orders are surfaced to a manager, not a reason to keep the till open.
        expect(stats.blocksSessionClose).toBe(false);
    });

    it('reports the wait until the next attempt', async () => {
        expect(await outbox.msUntilNextAttempt()).toBeNull();
        const entry = await outbox.enqueue({ kind: 'order.sync', payload: {}, targetUuid: uuid('o1') });
        expect(await outbox.msUntilNextAttempt()).toBe(0);
        await outbox.claim();
        await outbox.fail(entry.id, { kind: 'offline' });
        expect(await outbox.msUntilNextAttempt()).toBeGreaterThan(0);
    });
});
