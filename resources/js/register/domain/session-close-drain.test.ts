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

    it('does not wait for entries the server has already refused', async () => {
        // `blocksSessionClose` excludes quarantined entries on purpose: they will never send, so
        // blocking on them would strand the till forever. They are counted and reported instead.
        const sync = syncer({ passes: 0, quarantined: 2 });
        install(sync);

        await expect(drainBeforeClose()).resolves.toEqual({ drained: true, quarantined: 2 });
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
