/**
 * The single declared list of self-order operations that require a live server (BAN-450, XCT-016).
 *
 * Browsing the menu and building the cart work offline against the cached catalogue — the cart is
 * persisted and survives a reload. Anything that talks to the venue — sending the order, paying,
 * cancelling — is online-only: there is no customer-facing outbox, so these must be refused (and
 * their buttons disabled) while offline rather than failing after a tap. The UI reads this one list.
 */
export const SELF_ORDER_ONLINE_ONLY = ['submit', 'pay-online', 'cancel-order'] as const;

export type SelfOrderOperation =
    | (typeof SELF_ORDER_ONLINE_ONLY)[number]
    | 'browse-menu'
    | 'edit-cart';

/** Whether an operation needs connectivity — the one check every self-order surface calls. */
export function requiresConnection(operation: SelfOrderOperation): boolean {
    return (SELF_ORDER_ONLINE_ONLY as readonly string[]).includes(operation);
}

/** Whether an operation may be performed while offline. */
export function availableOffline(operation: SelfOrderOperation): boolean {
    return !requiresConnection(operation);
}
