/**
 * The single declared list of KDS operations that require a live server (BAN-450, XCT-016).
 *
 * The board interactions a cook performs all shift — advancing a stage, recalling a card, toggling a
 * line — are deliberately **not** here: they apply optimistically and queue for replay, so they work
 * offline. Only device/setup operations, which have no meaning without the server, are online-only.
 * The UI disables exactly these when offline, from this one list, rather than each screen guessing.
 */
export const KITCHEN_ONLINE_ONLY = ['pair', 'choose-display', 'unpair'] as const;

export type KitchenOperation =
    | (typeof KITCHEN_ONLINE_ONLY)[number]
    | 'advance-stage'
    | 'recall'
    | 'toggle-line';

/** Whether an operation needs connectivity — the one check every KDS surface calls. */
export function requiresConnection(operation: KitchenOperation): boolean {
    return (KITCHEN_ONLINE_ONLY as readonly string[]).includes(operation);
}

/** Whether an operation may be performed while offline (it queues and replays). */
export function availableOffline(operation: KitchenOperation): boolean {
    return !requiresConnection(operation);
}
