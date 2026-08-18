import type { OrderRow, PosConfigRow } from '@domain/types';

/**
 * Orders that belong to another register (REG-373, REG-374, BAN-523).
 *
 * `DeltaService::orderDelta()` hands this till every draft on its **trusted peers** as well as its
 * own — that is the point of trusting them, and it is how a waiter picks up a bill started on the
 * terrace till. The rows arrive looking exactly like local ones: same columns, same amounts, and no
 * unit anywhere on an order row.
 *
 * Which is fine until a peer runs a different currency. Then `24.20` on screen is 24.20 of something
 * else, the payment screen offers this register's tenders against it, and the sale balances to a
 * number that was never the price. Nothing downstream can catch that — the arithmetic is all
 * internally consistent — so the till has to decline to open it.
 *
 * Same currency is the ordinary case and stays ordinary: the order opens, and the only difference is
 * a badge saying whose it is, so a waiter editing it knows they are on somebody else's bill.
 */

export type ForeignOrder = {
    /** The peer's name, for the badge. Null when the peer is not in the trusted list at all. */
    registerName: string | null;
    /** Can this till open it? False only when the currencies differ. */
    openable: boolean;
};

/** Null when the order belongs to this register — the common case, and no badge. */
export function foreignOrder(order: OrderRow, config: PosConfigRow | null): ForeignOrder | null {
    if (!config) return null;
    if (order.pos_config_id === config.id) return null;

    const peer = config.trusted_configs.find((candidate) => candidate.id === order.pos_config_id);

    // A config that is not on the trusted list should not have reached this till at all. Shown as
    // foreign and unopenable rather than hidden: an order the register cannot account for is a fact
    // worth putting on screen, and guessing it is safe to edit is the one option with a downside.
    if (!peer) return { registerName: null, openable: false };

    return { registerName: peer.name, openable: peer.currency_id === config.currency_id };
}

/** Shorthand for the ticket list, which asks this per row. */
export function isForeign(order: OrderRow, config: PosConfigRow | null): boolean {
    return foreignOrder(order, config) !== null;
}

/**
 * May this till open the order?
 *
 * Local orders and same-currency peers: yes. Everything else: no, and the caller says why rather
 * than doing nothing when the row is tapped.
 */
export function canOpenOrder(order: OrderRow, config: PosConfigRow | null): boolean {
    return foreignOrder(order, config)?.openable !== false;
}
