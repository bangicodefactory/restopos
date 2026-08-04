/**
 * Offline / long-dark contract for the KDS (BAN-450).
 *
 * The board's normal offline model is adopt-then-replay: a paint of the last server board with the
 * still-unacknowledged local actions replayed on top. That is correct for a short blip. Over a long
 * dark period two things go wrong: the action queue grows without bound, and replaying a stale queue
 * on reconnect re-applies decisions the *other* stations already made differently on the live board.
 *
 * So past a threshold the display is declared **stale**: the queue stops growing, a banner says the
 * board may be out of date, and on reconnect the local queue is dropped and the server board is
 * re-projected wholesale rather than replayed. The server — kept current by the other stations — is
 * the better authority after an hour in the dark.
 */

/** Hard cap on the optimistic action queue. A busy pass does a handful of writes a minute, so 200 is
 *  ~30+ minutes of activity; beyond it the display is clearly stale and recovers by re-projection. */
export const MAX_QUEUE = 200;

/** How long since the last successful sync before the board is treated as stale (5 minutes). */
export const STALE_AFTER_MS = 5 * 60_000;

export type BoardSyncState = {
    online: boolean;
    /** Epoch ms of the last successful board fetch, or null if never. */
    lastSyncAt: number | null;
    queueLength: number;
};

/**
 * Is the board stale — old enough (or backed up enough) that its queue should be dropped and the
 * server re-projected rather than replayed? True when the queue has hit the cap, or when the display
 * has been offline past the staleness window.
 */
export function boardStale(state: BoardSyncState, now: number): boolean {
    if (state.queueLength >= MAX_QUEUE) {
        return true;
    }
    if (state.online || state.lastSyncAt === null) {
        return false;
    }
    return now - state.lastSyncAt > STALE_AFTER_MS;
}

/**
 * What to do with the local queue when connectivity returns:
 *  - `reproject` — the board was stale, so discard the queue and adopt the pure server board;
 *  - `replay` — a short blip, so drain the queue and replay it on the fresh board (the normal model).
 */
export function reconnectStrategy(state: BoardSyncState, now: number): 'reproject' | 'replay' {
    return boardStale(state, now) ? 'reproject' : 'replay';
}
