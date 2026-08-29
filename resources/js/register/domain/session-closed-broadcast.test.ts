import { beforeEach, describe, expect, it } from 'vitest';

import { usePosSessionStore } from '../state/session-store';
import { applySessionClosedBroadcast } from './session-actions';

/**
 * BAN-438 / REG-024 — a session closed on another till.
 *
 * `error.sessionClosed` ("This session was closed on another device") had been translated into
 * three languages before anything consumed it: the register subscribed to no broadcasts at all, so
 * a second till kept ringing sales into a session whose summaries had already been frozen. The
 * shell now subscribes to `pos.session.{id}` and routes the event here.
 */

function openSession(id: number): void {
    usePosSessionStore.setState((state) => ({
        ...state,
        session: { id, state: 'opened' } as never,
    }));
}

beforeEach(() => {
    usePosSessionStore.setState((state) => ({ ...state, session: null, error: null }));
});

describe('applySessionClosedBroadcast', () => {
    it('closes the local session and asks the caller to say so', () => {
        openSession(7);

        expect(applySessionClosedBroadcast({ session_id: 7 })).toBe(true);
        expect(usePosSessionStore.getState().session?.state).toBe('closed');
    });

    it('says nothing on the till that did the closing', () => {
        // That device's own store has already moved off an open session, which is how this tells
        // the two apart. `emitted_by_device_uuid` is populated now (BAN-402) and this path still
        // does not use it: the state question also silences a back-office close, where there is no
        // emitting device to compare against.
        usePosSessionStore.setState((state) => ({
            ...state,
            session: { id: 7, state: 'closed' } as never,
        }));

        expect(applySessionClosedBroadcast({ session_id: 7 })).toBe(false);
    });

    it('ignores a close for a session this till is not trading in', () => {
        // A stale subscription, or a rescue session's close arriving on a channel still being
        // listened to. Marking the wrong session closed locks a till that is trading perfectly.
        openSession(7);

        expect(applySessionClosedBroadcast({ session_id: 99 })).toBe(false);
        expect(usePosSessionStore.getState().session?.state).toBe('opened');
    });

    it('does nothing when this till has no session at all', () => {
        expect(applySessionClosedBroadcast({ session_id: 7 })).toBe(false);
    });

    it('accepts a payload with no session id rather than dropping the warning', () => {
        // Older server builds broadcast without one. Losing the notice is worse than acting on a
        // close that could only have come from this session's own channel.
        openSession(7);

        expect(applySessionClosedBroadcast({})).toBe(true);
        expect(usePosSessionStore.getState().session?.state).toBe('closed');
    });

    it('survives a malformed payload', () => {
        openSession(7);

        expect(applySessionClosedBroadcast(null)).toBe(true);
    });
});
