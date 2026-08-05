import type { OrderRow, PaymentRow } from '@domain/types';

import type { OrderIndexRecord } from '../data/order-lookup';

/**
 * The ticket screen's decisions, extracted from the component (REG-295, REG-301).
 *
 * They live here rather than inline so they can be tested without mounting a React tree, and so the
 * two "can the cashier do this" questions read as rules rather than as conditions inside JSX.
 */

/** Payment methods whose money has already left the customer's card, not a drawer. */
const ELECTRONIC_STATUSES = new Set(['done', 'authorized']);

/**
 * Whether deleting this order is allowed at all (REG-295).
 *
 * The delete button used to be guarded on `state === 'draft'` plus the permission. That misses the
 * case that matters: a draft can hold a **completed electronic payment** — the terminal captured
 * the card before the order was finalised, which is the normal flow for pay-first counters. Deleting
 * it would erase the till's only record of money that has already moved, leaving a settlement the
 * end-of-day reconciliation cannot explain and the customer cannot be refunded from.
 *
 * Cash is different: it is still in the drawer and the cashier can hand it back, so a cash payment
 * on a draft does not block the delete.
 */
export function canDeleteOrder(
    order: OrderRow | null,
    payments: PaymentRow[],
    options: { isElectronic: (paymentMethodId: number) => boolean },
): boolean {
    if (order === null || order.state !== 'draft') return false;

    return !payments.some(
        (payment) =>
            !payment.is_change &&
            options.isElectronic(payment.payment_method_id) &&
            ELECTRONIC_STATUSES.has(payment.payment_status),
    );
}

/**
 * Whether deleting this order must also withdraw its kitchen ticket (REG-295).
 *
 * True once anything has been fired. The kitchen is a separate system that heard "make this" and
 * has no other way of hearing "stop" — the order simply disappearing from the till is not a signal
 * that reaches the pass.
 */
export function needsKitchenWithdrawal(order: OrderRow | null): boolean {
    if (order === null) return false;

    return order.last_prep_sent_at !== null || order.prep_state === 'sent';
}

/**
 * A row in the ticket list: either a hydrated order, or an index record whose body is not here.
 *
 * The stub exists because a body fetch can fail on its own — the till drops off the network halfway
 * through a page, or the order was deleted server-side between the index and the hydrate. Rendering
 * only hydrated orders meant that row silently vanished, which reads as "that order does not exist"
 * to the cashier looking straight at the receipt in their hand. The index already carries enough to
 * show it honestly: name, receipt, state and total.
 */
export type TicketRow =
    | { kind: 'order'; uuid: string; order: OrderRow }
    | { kind: 'stub'; uuid: string; record: OrderIndexRecord };

/**
 * Merge the server's answer with the local working set, for a server-backed filter.
 *
 * The server decided the result set — it can match on invoice, customer and cardholder, fields this
 * till has never held — so its records are never re-filtered through the local search term. Doing
 * that would throw away the very matches that made the round trip worth making.
 *
 * Locally unsynced orders are appended regardless: they are this till's own unpushed work, and the
 * server cannot know about them yet.
 */
export function mergeTicketRows(
    records: OrderIndexRecord[],
    ordersByUuid: Record<string, OrderRow>,
    localUnsynced: OrderRow[],
): TicketRow[] {
    const rows = new Map<string, TicketRow>();

    for (const record of records) {
        const order = ordersByUuid[record.uuid];
        rows.set(
            record.uuid,
            order
                ? { kind: 'order', uuid: record.uuid, order }
                : { kind: 'stub', uuid: record.uuid, record },
        );
    }

    for (const order of localUnsynced) {
        rows.set(order.uuid, { kind: 'order', uuid: order.uuid, order });
    }

    return [...rows.values()].sort((a, b) => sortKey(b) - sortKey(a));
}

/**
 * Newest first, across both shapes.
 *
 * A stub has no `updatedAtLocal` — it was never a local row — so its server timestamp stands in.
 * Mixing a local clock and a server clock in one sort is imprecise by a few seconds of drift, which
 * is the right trade: the alternative is stubs bunched at one end of the list regardless of age.
 */
function sortKey(row: TicketRow): number {
    return row.kind === 'order' ? row.order.updatedAtLocal : (Date.parse(row.record.updated_at) || 0);
}

/**
 * How many rows the ticket list shows (REG-301).
 *
 * Was a hardcoded `.slice(0, 200)`, which is not a page size — it is a silent truncation. A till
 * that took 201 orders lost the 201st with no indication that anything was missing, and the only
 * way to reach it was to search for something you could already name.
 */
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

export const DEFAULT_PAGE_SIZE = 50;

export function clampPageSize(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_PAGE_SIZE;

    return PAGE_SIZE_OPTIONS.reduce((best, option) =>
        Math.abs(option - value) < Math.abs(best - value) ? option : best,
    );
}
