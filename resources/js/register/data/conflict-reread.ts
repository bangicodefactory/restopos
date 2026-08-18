import type { SyncRecordResult } from '@domain/sync/wire';

/**
 * What a till should do with a push the server did not simply accept (REG-372, RST-058).
 *
 * The outbox already tells conflict, rejection and supersession apart, and then the register did
 * nothing with the answer beyond colouring the order red. The waiter carries on looking at a bill
 * the server has already refused — and on a table order that is the worst possible screen, because
 * the other till is looking at the version that won.
 *
 * Pure, and separate from the boot wiring, because the decision is the part worth testing: the
 * wiring is one `switch` and a fetch.
 */

export type ConflictAction =
    /** Nothing to do — an ordinary acknowledgement. */
    | { kind: 'none' }
    /** Pull the server's copy and replace the local one. */
    | { kind: 'reread'; orderUuid: string }
    /**
     * This order was folded into another. Adopt the survivor and stop showing the merged-away bill.
     */
    | { kind: 'adopt'; orderUuid: string; survivorUuid: string }
    /** Refused for good; leave it quarantined for a manager to look at. */
    | { kind: 'quarantine'; orderUuid: string; code: string };

export function conflictAction(result: SyncRecordResult): ConflictAction {
    const orderUuid = String(result.uuid);

    // Two tills opened the same table and the server merged them (RST-058). The pushed uuid no
    // longer exists server-side, so re-reading it would 404 — the survivor is what to fetch.
    //
    // Checked before the status, because this arrives as `superseded`: the local order really is
    // obsolete, and the only thing that distinguishes it from an ordinary supersession is that the
    // waiter has somewhere specific to be sent.
    if (result.merged_into_uuid) {
        return { kind: 'adopt', orderUuid, survivorUuid: String(result.merged_into_uuid) };
    }

    if (result.status === 'ok') return { kind: 'none' };

    // Superseded means the server holds a better version of this exact order. Re-read rather than
    // quarantine: there is nothing wrong with the sale, the till is simply behind.
    if (result.status === 'superseded' || result.status === 'conflict') {
        return { kind: 'reread', orderUuid };
    }

    return {
        kind: 'quarantine',
        orderUuid,
        code: result.error?.code ?? result.conflict?.code ?? 'rejected',
    };
}
