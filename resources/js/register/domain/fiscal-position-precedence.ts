/**
 * Which fiscal position wins (REG-175).
 *
 * Four things want to set the tax mapping on an order, and they arrive in whatever sequence the
 * service happens to take: the register's default at creation, the preset when the waiter picks
 * "takeaway", the customer's own mapping when they are attached, and the cashier choosing one by
 * hand. Every one of them called `setFiscalPosition` directly, so the winner was **whichever ran
 * last** — attach a customer after choosing takeaway and the takeaway rate silently reverted.
 *
 * On a bill that is a wrong VAT rate on a real sale, decided by the order the waiter happened to tap
 * things in. So the source is recorded alongside the value and a weaker source cannot overwrite a
 * stronger one:
 *
 * | Source | Beats | Why |
 * |---|---|---|
 * | `manual` | everything | somebody looked at this order and decided |
 * | `preset` | partner, default | the service mode is a fact about *this* sale |
 * | `partner` | default | the customer's mapping is a fact about them, not this sale |
 * | `default` | nothing | the register's fallback |
 *
 * Preset above partner is the arguable one, and it is Odoo's order. A takeaway sale is takeaway
 * whoever is buying; an exempt customer buying takeaway is a case for the manual override, which is
 * exactly what `manual` is for.
 *
 * Clearing is not an exception: a `null` from a source strong enough to write is a real decision
 * ("no mapping"), so it is recorded as one and holds against weaker sources.
 */

export type FiscalPositionSource = 'default' | 'partner' | 'preset' | 'manual';

const RANK: Record<FiscalPositionSource, number> = {
    default: 0,
    partner: 1,
    preset: 2,
    manual: 3,
};

export type FiscalPositionState = {
    fiscalPositionId: number | null;
    source: FiscalPositionSource;
};

/**
 * Should `next` replace what is already on the order?
 *
 * Equal ranks *do* replace: choosing a second preset must move the mapping, and re-attaching a
 * different customer must move it too. What is refused is only a **weaker** source overwriting a
 * stronger one.
 */
export function winsFiscalPosition(current: FiscalPositionSource, next: FiscalPositionSource): boolean {
    return RANK[next] >= RANK[current];
}

/** Apply a proposal, keeping whichever decision is stronger. */
export function resolveFiscalPosition(
    current: FiscalPositionState,
    proposal: FiscalPositionState,
): FiscalPositionState {
    return winsFiscalPosition(current.source, proposal.source) ? proposal : current;
}
