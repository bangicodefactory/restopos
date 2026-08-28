/**
 * The single declared list of register operations that require a live server (XCT-016, BAN-405).
 *
 * The register is offline-first and most of a shift is: ringing up, tendering, printing, sending
 * to the kitchen, splitting a bill, even **adding a customer** — which is offline on purpose here
 * and is not in Odoo (see `components/dialogs/CustomerDialog.tsx`). Those queue and replay.
 *
 * What cannot work offline is anything the server alone is entitled to decide. Opening and closing
 * a session is the clearest case: the closing totals are computed server-side from synced orders,
 * and a till that invented them offline would be inventing money (REG-014). Table bookings, floor
 * geometry and a lookup of orders older than the local replica are the same shape — a second till
 * may already have changed them, so a local answer is a guess.
 *
 * Before this list each surface guessed for itself: `table-booking.ts` threw its own hardcoded
 * offline error, `session-actions.ts` mapped an `ApiError`, `approval.ts` asked `browserOnline()`.
 * Three spellings of one rule is how they drift apart, and a screen that forgets to ask is a
 * button that fails with a network error instead of being visibly unavailable.
 */
export const REGISTER_ONLINE_ONLY = [
    'open-session',
    'close-session',
    'book-table',
    'edit-floor',
    'lookup-past-orders',
    'repair-data',
] as const;

export type RegisterOperation =
    | (typeof REGISTER_ONLINE_ONLY)[number]
    // Everything below queues and replays. Listed rather than left implicit so that adding an
    // operation forces a decision about which side of the line it falls on.
    | 'ring-up'
    | 'tender'
    | 'print-receipt'
    | 'send-to-kitchen'
    | 'split-bill'
    | 'add-customer'
    | 'manager-override';

/** Whether an operation needs connectivity — the one check every register surface calls. */
export function requiresConnection(operation: RegisterOperation): boolean {
    return (REGISTER_ONLINE_ONLY as readonly string[]).includes(operation);
}

/** Whether an operation may be performed while offline (it queues and replays). */
export function availableOffline(operation: RegisterOperation): boolean {
    return !requiresConnection(operation);
}
