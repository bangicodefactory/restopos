import type { PosSessionRow } from '@domain/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRuntime, setRuntime } from '../data/runtime';

import { fetchCurrentSession, openSessionFromDb } from './session-actions';
import { usePosSessionStore } from '../state/session-store';

/**
 * BAN-504 — the session a till trades on when the server cannot be reached.
 *
 * Booting offline is worth nothing if the till cannot then take an order, so `fetchCurrentSession`
 * falls back to the replica. The risk in that fallback is answering a *different* question than the
 * endpoint it stands in for: `PosConfig::currentSession()` is "not closed **and not a rescue
 * session**", and `PosSession::posLoadScope` replicates every open session — rescue ones included,
 * because a rescue session is open precisely by virtue of being unreconciled.
 *
 * A fallback that picked one of those would attribute a day's orders to a session nobody is trading
 * in, and only ever offline, which is where it is hardest to notice.
 */

function session(overrides: Partial<PosSessionRow> = {}): PosSessionRow {
    return {
        id: 1,
        state: 'opened',
        is_rescue: false,
        ...overrides,
    } as PosSessionRow;
}

/** A stand-in for the Dexie sessions table plus whatever the api mock needs. */
function runtime(rows: PosSessionRow[], api: unknown = { get: vi.fn().mockRejectedValue(new Error('offline')) }) {
    const stored = [...rows];

    setRuntime({
        db: {
            sessions: {
                toArray: () => Promise.resolve(stored),
                put: (row: PosSessionRow) => {
                    stored.push(row);

                    return Promise.resolve(row.id);
                },
                clear: () => {
                    stored.length = 0;

                    return Promise.resolve();
                },
            },
        },
        api,
    } as never);

    return stored;
}

beforeEach(() => {
    clearRuntime();
    usePosSessionStore.getState().setSession(null);
});

describe('openSessionFromDb', () => {
    it('finds the open session', () => {
        runtime([session({ id: 4 })]);

        return expect(openSessionFromDb()).resolves.toMatchObject({ id: 4 });
    });

    it('ignores a closed session', () => {
        runtime([session({ id: 4, state: 'closed' })]);

        return expect(openSessionFromDb()).resolves.toBeNull();
    });

    it('never returns a rescue session', async () => {
        // The bug this exists to prevent. A rescue session is open by definition and is replicated
        // like any other, so a predicate of "not closed" alone picks it up.
        runtime([session({ id: 2, is_rescue: true })]);

        await expect(openSessionFromDb()).resolves.toBeNull();
    });

    it('prefers the real session over an older rescue one', async () => {
        // Both open at once is the normal state of a venue carrying an unreconciled rescue session,
        // and Dexie hands rows back in primary-key order — so the older rescue row comes first.
        runtime([session({ id: 2, is_rescue: true }), session({ id: 9 })]);

        await expect(openSessionFromDb()).resolves.toMatchObject({ id: 9 });
    });

    it('takes the newest when several are open', async () => {
        runtime([session({ id: 3 }), session({ id: 11 }), session({ id: 7 })]);

        await expect(openSessionFromDb()).resolves.toMatchObject({ id: 11 });
    });
});

describe('fetchCurrentSession', () => {
    it('stores what the server returns, so the next cold boot has it', async () => {
        const remote = session({ id: 12 });
        const stored = runtime([], {
            get: vi.fn().mockResolvedValue({ data: { session: remote }, status: 200 }),
        });

        await expect(fetchCurrentSession()).resolves.toMatchObject({ id: 12 });
        expect(stored).toHaveLength(1);
    });

    it('trades on the local session when the server is unreachable', async () => {
        runtime([session({ id: 5 })]);

        await expect(fetchCurrentSession()).resolves.toMatchObject({ id: 5 });

        // And no error banner: this is the designed path, not a degraded one. Telling a cashier
        // something is wrong when the till is working correctly is its own kind of failure.
        expect(usePosSessionStore.getState().error).toBeNull();
    });

    it('reports the error only when there is nothing local to fall back to', async () => {
        runtime([]);

        await expect(fetchCurrentSession()).resolves.toBeNull();
        expect(usePosSessionStore.getState().error).not.toBeNull();
    });

    it('does not wipe the replicated table when the server reports no session', async () => {
        // `pos_sessions` is replicated: bootstrap and delta own it. Clearing it here would destroy
        // rows — rescue sessions among them — that no delta will bring back, because the watermark
        // has moved past them.
        const stored = runtime([session({ id: 2, is_rescue: true })], {
            get: vi.fn().mockResolvedValue({ data: { session: null }, status: 200 }),
        });

        await expect(fetchCurrentSession()).resolves.toBeNull();
        expect(stored).toHaveLength(1);
    });
});
