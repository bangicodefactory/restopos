import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRuntime, setRuntime } from '../data/runtime';
import { usePosSessionStore } from '../state/session-store';
import { closeSession, drainBeforeClose } from './session-actions';

/**
 * BAN-425 — empty the outbox before the summaries are frozen (REG-017).
 *
 * A sale still queued when the session closes syncs afterwards, finds its session gone and is
 * rerouted into a rescue session: money taken during the shift, sitting outside the Z-report that
 * is supposed to account for it. The rescue path is the right net for a till that crashed. It is
 * the wrong outcome for a till being closed deliberately with the queue in plain sight.
 */

type Stats = {
    total: number;
    pending: number;
    inflight: number;
    error: number;
    quarantined: number;
    oldestAgeMs: number;
    blocksSessionClose: boolean;
};

function stats(overrides: Partial<Stats> = {}): Stats {
    return {
        total: 0,
        pending: 0,
        inflight: 0,
        error: 0,
        quarantined: 0,
        oldestAgeMs: 0,
        blocksSessionClose: false,
        ...overrides,
    };
}

/** A syncer whose queue empties after `passes` drains, or never if `stuck`. */
function syncer(options: { passes?: number; stuck?: boolean; quarantined?: number } = {}) {
    let remaining = options.passes ?? 0;
    const quarantined = options.quarantined ?? 0;

    const snapshot = (): Stats =>
        stats({
            total: remaining + quarantined,
            pending: remaining,
            quarantined,
            blocksSessionClose: remaining > 0,
        });

    return {
        stats: vi.fn(async () => snapshot()),
        drain: vi.fn(async () => {
            if (options.stuck) return { sent: 0, failed: 0 };
            if (remaining > 0) remaining -= 1;

            return { sent: 1, failed: 0 };
        }),
    };
}

const CLOSING = {
    session_id: 1,
    opening_balance: '100.0000',
    cash_in: '0.0000',
    cash_out: '0.0000',
    expected_cash: '100.0000',
    payment_totals: [],
    order_count: 0,
    draft_order_count: 0,
    amount_authorized_diff: '0',
    enforces_maximum_difference: false,
};

function install(sync: ReturnType<typeof syncer>, api: unknown = { post: vi.fn().mockResolvedValue({ data: null }) }) {
    setRuntime({ syncer: sync, api } as never);
}

beforeEach(() => {
    clearRuntime();
    usePosSessionStore.setState((state) => ({ ...state, error: null, session: null }));
});

describe('drainBeforeClose', () => {
    it('keeps draining until nothing is left that blocks', () => {
        const sync = syncer({ passes: 3 });
        install(sync);

        return drainBeforeClose().then((result) => {
            expect(result.drained).toBe(true);
            // `drain()` sends one batch, so one call would have left two entries behind.
            expect(sync.drain).toHaveBeenCalledTimes(3);
        });
    });

    it('does nothing when the queue is already empty', async () => {
        const sync = syncer({ passes: 0 });
        install(sync);

        await expect(drainBeforeClose()).resolves.toMatchObject({ drained: true });
        expect(sync.drain).not.toHaveBeenCalled();
    });

    it('gives up rather than spinning against a queue that cannot move', async () => {
        // Offline, or every remaining entry waiting on a backoff timer. Another pass would say the
        // same thing, and a close screen that hangs is worse than one that refuses.
        const sync = syncer({ passes: 2, stuck: true });
        install(sync);

        await expect(drainBeforeClose()).resolves.toMatchObject({ drained: false });
        expect(sync.drain).toHaveBeenCalledTimes(1);
    });

    it('waits out a drain that is already in flight', async () => {
        // `OutboxSyncer.drain()` answers `{sent: 0, failed: 0}` when one is already running, and it
        // runs on a timer — so a close-time drain collides with a scheduled one routinely. Judging
        // progress on that number rather than on the queue would abandon the close while the queue
        // is emptying underneath it, and refuse a close that was seconds from being fine.
        let remaining = 3;
        const sync = {
            // Always "busy": every call reports no work done.
            drain: vi.fn(async () => ({ sent: 0, failed: 0 })),
            // …while the other drain empties the queue regardless.
            stats: vi.fn(async () => {
                const snapshot = stats({
                    total: remaining,
                    pending: remaining,
                    blocksSessionClose: remaining > 0,
                });
                if (remaining > 0) remaining -= 1;

                return snapshot;
            }),
        };

        install(sync as never);

        await expect(drainBeforeClose()).resolves.toMatchObject({ drained: true });
    });

    it('stops rather than spinning on a queue that keeps refilling', async () => {
        // The exit below is "the queue did not move between two reads", which anything enqueuing
        // concurrently defeats — a print's `audit.batch`, a queued cash move. Unbounded, that is a
        // close button that spins forever on a till at 2am.
        let n = 1000;
        const sync = {
            drain: vi.fn(async () => { n += 1; return { sent: 1, failed: 0 }; }),
            stats: vi.fn(async () => stats({ total: n, pending: n, blocksSessionClose: true })),
        };

        install(sync as never);

        await expect(drainBeforeClose()).resolves.toMatchObject({ drained: false });
        // Bounded, not infinite — the exact ceiling matters less than there being one.
        expect(sync.drain.mock.calls.length).toBeLessThanOrEqual(200);
    });

    it('does not wait for entries the server has already refused', async () => {
        // `blocksSessionClose` excludes quarantined entries on purpose: they will never send, so
        // blocking on them would strand the till forever. They are counted and reported instead.
        const sync = syncer({ passes: 0, quarantined: 2 });
        install(sync);

        await expect(drainBeforeClose()).resolves.toEqual({ drained: true, quarantined: 2, sent: 0 });
    });
});

describe('closeSession', () => {
    it('drains before it posts, never after', async () => {
        const order: string[] = [];
        const sync = {
            stats: vi.fn(async () => stats({ total: 0, blocksSessionClose: false })),
            drain: vi.fn(async () => ({ sent: 0, failed: 0 })),
        };
        const api = {
            post: vi.fn(async () => {
                order.push('post');

                return { data: null };
            }),
        };

        sync.stats.mockImplementation(async () => {
            order.push('stats');

            return stats({ blocksSessionClose: false });
        });

        install(sync as never, api);

        await closeSession({ sessionId: 1, countedCash: '0', countedByMethod: {}, employeeId: null });

        expect(order[0]).toBe('stats');
        expect(order).toContain('post');
    });

    it('refuses the close outright when the queue will not drain', async () => {
        // The whole point. Closing here would freeze summaries that do not include the queued sales,
        // and those sales would land in a rescue session minutes later.
        const sync = syncer({ passes: 1, stuck: true });
        const api = { post: vi.fn() };
        install(sync, api);

        await expect(
            closeSession({ sessionId: 1, countedCash: '0', countedByMethod: {}, employeeId: null }),
        ).resolves.toMatchObject({ ok: false, reason: 'unsent' });

        expect(api.post).not.toHaveBeenCalled();
        expect(usePosSessionStore.getState().error).toBe('unsent');
    });

    it('closes, and reports what the server refused', async () => {
        const sync = syncer({ passes: 1, quarantined: 3 });
        install(sync);

        await expect(
            closeSession({ sessionId: 1, countedCash: '0', countedByMethod: {}, employeeId: null }),
        ).resolves.toMatchObject({ ok: true, quarantined: 3 });
    });

    it('hands the close back when draining moves the expected cash', async () => {
        // The cashier counted 124.20 against an expected 100.00, because a 24.20 cash sale was still
        // queued. Draining sends it, the server now expects 124.20, and the +24.20 overage on screen
        // evaporates — but only if somebody looks. Posting here records correct money against a
        // figure nobody agreed to, and on a register with a variance threshold it has already called
        // a manager over to authorise a difference that no longer exists.
        const sync = syncer({ passes: 1 });
        const api = {
            get: vi.fn().mockResolvedValue({ data: { ...CLOSING, expected_cash: '124.2000' } }),
            post: vi.fn().mockResolvedValue({ data: null }),
        };
        install(sync, api);

        await expect(
            closeSession({
                sessionId: 1,
                countedCash: '124.20',
                countedByMethod: {},
                employeeId: null,
                expectedCash: '100.0000',
            }),
        ).resolves.toMatchObject({ ok: false, reason: 'expected_changed' });

        expect(api.post).not.toHaveBeenCalled();
    });

    it('goes through when the drain leaves the expectation where it was', async () => {
        // The ordinary case: the queue held a card sale, or a note edit, or nothing that moves cash.
        // Handing the close back here would be a second press for no reason.
        const sync = syncer({ passes: 1 });
        const api = {
            get: vi.fn().mockResolvedValue({ data: CLOSING }),
            post: vi.fn().mockResolvedValue({ data: null }),
        };
        install(sync, api);

        await expect(
            closeSession({
                sessionId: 1,
                countedCash: '100.00',
                countedByMethod: {},
                employeeId: null,
                expectedCash: '100.0000',
            }),
        ).resolves.toMatchObject({ ok: true });

        expect(api.post).toHaveBeenCalled();
    });

    it('hands the close back when the drain syncs a draft the pane never showed', async () => {
        // BAN-514. `drain()` sends whatever is queued, and a queued *draft* is an order the server
        // will then refuse to close over — so the drain manufactures the very blocker it was run to
        // clear. The pane loaded showing no drafts and would get back a bare 422 naming a condition
        // it was told the opposite of, with no force checkbox offered because it believes there is
        // nothing to force past.
        const sync = syncer({ passes: 1 });
        const api = {
            get: vi.fn().mockResolvedValue({ data: { ...CLOSING, draft_order_count: 1 } }),
            post: vi.fn().mockResolvedValue({ data: null }),
        };
        install(sync, api);

        await expect(
            closeSession({
                sessionId: 1,
                countedCash: '100.00',
                countedByMethod: {},
                employeeId: null,
                expectedCash: '100.0000',
                draftOrderCount: 0,
            }),
        ).resolves.toMatchObject({ ok: false, reason: 'drafts_arrived' });

        expect(api.post).not.toHaveBeenCalled();
    });

    it('does not hand it back over a draft the pane already displayed', async () => {
        // Seen and answered: the cashier either settled it or ticked force. Refusing here would be
        // a second press for something they have already dealt with.
        const sync = syncer({ passes: 1 });
        const api = {
            get: vi.fn().mockResolvedValue({ data: { ...CLOSING, draft_order_count: 1 } }),
            post: vi.fn().mockResolvedValue({ data: null }),
        };
        install(sync, api);

        await expect(
            closeSession({
                sessionId: 1,
                countedCash: '100.00',
                countedByMethod: {},
                employeeId: null,
                expectedCash: '100.0000',
                draftOrderCount: 1,
            }),
        ).resolves.toMatchObject({ ok: true });

        expect(api.post).toHaveBeenCalled();
    });

    it('lets a deliberate force through a draft that arrived mid-drain', async () => {
        // The cashier has already said "close anyway". Handing the close back at that point would
        // make the force checkbox impossible to satisfy — tick it, drain syncs another draft,
        // refused again.
        const sync = syncer({ passes: 1 });
        const api = {
            get: vi.fn().mockResolvedValue({ data: { ...CLOSING, draft_order_count: 2 } }),
            post: vi.fn().mockResolvedValue({ data: null }),
        };
        install(sync, api);

        await expect(
            closeSession({
                sessionId: 1,
                countedCash: '100.00',
                countedByMethod: {},
                employeeId: null,
                expectedCash: '100.0000',
                draftOrderCount: 0,
                force: true,
            }),
        ).resolves.toMatchObject({ ok: true });

        expect(api.post).toHaveBeenCalled();
    });

    it('hands back the fresh closing data with the refusal', async () => {
        // The pane has to be able to say what arrived. Without the payload it can only repeat the
        // count it already had, which is the count that was wrong.
        const sync = syncer({ passes: 1 });
        const api = {
            get: vi.fn().mockResolvedValue({ data: { ...CLOSING, draft_order_count: 3 } }),
            post: vi.fn().mockResolvedValue({ data: null }),
        };
        install(sync, api);

        const result = await closeSession({
            sessionId: 1,
            countedCash: '100.00',
            countedByMethod: {},
            employeeId: null,
            draftOrderCount: 0,
        });

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.closingData?.draft_order_count).toBe(3);
    });

    it('does not re-read the expectation when the drain sent nothing', async () => {
        // Nothing synced, so nothing can have moved. The extra round trip is pure latency on the
        // common path — a till whose queue was already empty.
        const sync = syncer({ passes: 0 });
        const api = { get: vi.fn(), post: vi.fn().mockResolvedValue({ data: null }) };
        install(sync, api);

        await closeSession({
            sessionId: 1,
            countedCash: '100.00',
            countedByMethod: {},
            employeeId: null,
            expectedCash: '100.0000',
        });

        expect(api.get).not.toHaveBeenCalled();
    });

    it('passes the closing note and the abandon flag to the server', async () => {
        const sync = syncer({ passes: 0 });
        const api = { post: vi.fn().mockResolvedValue({ data: null }) };
        install(sync, api);

        await closeSession({
            sessionId: 7,
            countedCash: '0',
            countedByMethod: {},
            employeeId: null,
            notes: 'Drawer 5 short.',
            abandon: true,
        });

        expect(api.post.mock.calls[0]?.[1]).toMatchObject({
            notes: 'Drawer 5 short.',
            abandon: true,
        });
    });
});
