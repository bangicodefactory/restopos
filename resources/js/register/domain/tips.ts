import { Decimal } from '@domain/money/decimal';
import type { PaymentRow } from '@domain/types';

/**
 * Tips on a settled order (RST-125).
 *
 * A tip is applied after the receipt prints — that is what a tip is — so both the line guard and the
 * payment guard have to let one through on an order that is otherwise frozen. The server's door is
 * narrow and deliberate: an increase, on the amount alone, no larger than the tip the order
 * declares. This is the client half, and it has to aim at the same target, because a till that tops
 * up the wrong tender produces a push the server refuses and a screen that says it worked.
 *
 * Which tender gets the tip is not arbitrary. A tip goes on the **card**: it is added at the
 * terminal or written on the slip, and the acquirer charges the total plus the tip. Cash tips need
 * no adjustment at all — the money is already in the drawer and the count will find it.
 */

/** Payments that can carry a tip: settled, not change, not a refund. */
function tippable(payments: readonly PaymentRow[]): PaymentRow[] {
    return payments.filter(
        (payment) =>
            !payment.is_change &&
            !payment.is_refund &&
            payment.payment_status !== 'failed' &&
            payment.payment_status !== 'cancelled',
    );
}

/**
 * Which tender the tip should be added to, and what it becomes.
 *
 * The largest tippable payment wins a split tender, which is the closest thing to a rule a waiter
 * would recognise: the tip goes on the card that paid for most of the meal. `null` when there is
 * nothing to top up — a cash-only sale needs no adjustment, because the tip is already in the
 * drawer and the drawer count will find it.
 *
 * @param delta how much the tip grew by; negative when a tip is reduced or taken back off
 */
export function tipTopUp(
    payments: readonly PaymentRow[],
    delta: string,
): { paymentUuid: string; amount: string } | null {
    const growth = Decimal.of(delta);

    if (growth.isZero()) return null;

    const candidates = tippable(payments);
    if (candidates.length === 0) return null;

    const target = candidates.reduce((biggest, payment) =>
        Decimal.of(payment.amount).sub(biggest.amount).signum() > 0 ? payment : biggest,
    );

    const next = Decimal.of(target.amount).add(growth);

    // Never below zero: taking a tip back off cannot turn a tender negative, which would read as a
    // refund on a settled sale.
    if (next.signum() < 0) return null;

    return { paymentUuid: target.uuid, amount: next.withScale(2).toString() };
}

/** How much the tip moved by, given what the order already recorded. */
export function tipDelta(previous: string | null | undefined, next: string): string {
    return Decimal.of(next).sub(Decimal.of(previous ?? '0')).withScale(2).toString();
}
