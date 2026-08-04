import { describe, expect, it } from 'vitest';

import { MAX_QUEUE, STALE_AFTER_MS, boardStale, reconnectStrategy } from './offline';

const t0 = 1_000_000;

describe('boardStale (BAN-450)', () => {
    it('is never stale while online (below the queue cap)', () => {
        expect(boardStale({ online: true, lastSyncAt: t0, queueLength: 3 }, t0 + STALE_AFTER_MS * 3)).toBe(false);
    });

    it('is not stale offline within the staleness window', () => {
        expect(boardStale({ online: false, lastSyncAt: t0, queueLength: 3 }, t0 + STALE_AFTER_MS - 1)).toBe(false);
    });

    it('turns stale once offline past the window', () => {
        expect(boardStale({ online: false, lastSyncAt: t0, queueLength: 3 }, t0 + STALE_AFTER_MS + 1)).toBe(true);
    });

    it('is stale when the queue reaches the cap, even online', () => {
        expect(boardStale({ online: true, lastSyncAt: t0, queueLength: MAX_QUEUE }, t0)).toBe(true);
    });

    it('is not stale offline with no prior sync (nothing to be stale against)', () => {
        expect(boardStale({ online: false, lastSyncAt: null, queueLength: 0 }, t0 + STALE_AFTER_MS * 3)).toBe(false);
    });
});

describe('reconnectStrategy (BAN-450)', () => {
    it('re-projects the server board when stale, discarding the queue', () => {
        expect(reconnectStrategy({ online: false, lastSyncAt: t0, queueLength: 3 }, t0 + STALE_AFTER_MS + 1)).toBe('reproject');
        expect(reconnectStrategy({ online: false, lastSyncAt: t0, queueLength: MAX_QUEUE }, t0)).toBe('reproject');
    });

    it('replays the queue after a short blip', () => {
        expect(reconnectStrategy({ online: false, lastSyncAt: t0, queueLength: 3 }, t0 + 1_000)).toBe('replay');
    });
});
