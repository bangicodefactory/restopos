import type { SyncRecordResult } from '@domain/sync/wire';
import { describe, expect, it } from 'vitest';

import { conflictAction } from './conflict-reread';

/**
 * REG-372, RST-058 (BAN-474) — doing something with the server's answer.
 *
 * The outbox has always told conflict, rejection and supersession apart, and the register did
 * nothing with that beyond colouring the order red. The waiter carried on looking at a bill the
 * server had already refused — worst of all on a table order, where the other till is looking at
 * the version that won.
 */

function result(overrides: Partial<SyncRecordResult>): SyncRecordResult {
    return {
        uuid: 'order-a',
        status: 'ok',
        server_rev: 'rev-1',
        ...overrides,
    } as SyncRecordResult;
}

describe('an ordinary acknowledgement', () => {
    it('asks for nothing', () => {
        expect(conflictAction(result({ status: 'ok' }))).toEqual({ kind: 'none' });
    });
});

describe('a conflict', () => {
    it('re-reads the order rather than leaving a rejected view on screen', () => {
        expect(conflictAction(result({ status: 'conflict' }))).toEqual({
            kind: 'reread',
            orderUuid: 'order-a',
        });
    });

    it('re-reads a superseded order too, because nothing is wrong with the sale', () => {
        // Superseded means the server holds a better version of this exact order. Quarantining it
        // would report a healthy sale to the manager as refused.
        expect(conflictAction(result({ status: 'superseded' }))).toEqual({
            kind: 'reread',
            orderUuid: 'order-a',
        });
    });
});

describe('an order merged into another table bill', () => {
    it('adopts the survivor rather than re-reading a uuid that no longer exists', () => {
        // Two tills opened the same table and the server merged them (RST-058). Re-reading the
        // pushed uuid would 404 — the survivor is what to fetch and what to put in front of the
        // waiter.
        expect(
            conflictAction(result({ status: 'superseded', merged_into_uuid: 'order-b' as never })),
        ).toEqual({ kind: 'adopt', orderUuid: 'order-a', survivorUuid: 'order-b' });
    });

    it('takes precedence over the bare status, which is what caused the regression', () => {
        // BAN-471's server change first reported this as an invented `merged` status. `SyncStatus`
        // does not contain it, so the client fell through to its rejected branch and **quarantined a
        // sale that had succeeded** — reporting it to the manager as refused at session close.
        //
        // Reported as `superseded` now, with the survivor naming where the waiter should go.
        const action = conflictAction(result({ status: 'superseded', merged_into_uuid: 'order-b' as never }));

        expect(action.kind).not.toBe('quarantine');
        expect(action.kind).toBe('adopt');
    });
});

describe('a genuine refusal', () => {
    it('is quarantined with the reason, for a manager to look at', () => {
        expect(
            conflictAction(result({ status: 'rejected', error: { code: 'order_not_writable', message: 'no' } })),
        ).toEqual({ kind: 'quarantine', orderUuid: 'order-a', code: 'order_not_writable' });
    });

    it('falls back to the conflict code when there is no error block', () => {
        expect(
            conflictAction(result({ status: 'rejected', conflict: { code: 'stale_write', message: 'no' } })),
        ).toEqual({ kind: 'quarantine', orderUuid: 'order-a', code: 'stale_write' });
    });

    it('still says something when the server explained nothing', () => {
        expect(conflictAction(result({ status: 'rejected' })).kind).toBe('quarantine');
    });
});
