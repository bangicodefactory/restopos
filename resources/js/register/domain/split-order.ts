import { Decimal } from '@domain/money/decimal';

import { getCatalog } from '../data/catalog';
import { linesOf, paymentsOf, useOrderStore } from '../state/order-store';
import { computeTotals } from './totals';

/**
 * Splitting a bill by money rather than by items (RST-104, RST-105).
 *
 * Quantity splitting moves lines onto a new order, and that is the right model for "she had the fish
 * and I had the steak": each bill is a real list of what was eaten, taxed line by line by the shared
 * engine.
 *
 * **An even split is not that, and must not pretend to be.** Four guests halving a table do not each
 * own a quarter of a pizza — there is nothing to move. Manufacturing four orders would mean inventing
 * synthetic lines with a blended tax rate, which is wrong the moment a bill mixes 10 % food and 20 %
 * drink: the four "quarters" would each carry a made-up rate, none of them would match the sale, and
 * the VAT return would be built on numbers nobody ordered.
 *
 * So a money split is modelled as what it actually is: **several payments against one order**. The
 * bill stays whole and correctly taxed, the register asks for a sequence of amounts, and the order
 * settles when they add up. That is also what makes the "continue splitting" loop trivial — the
 * remainder is not a new document, it is the same order's outstanding balance.
 *
 * Everything here is pure arithmetic on decimal strings, which is why it lives apart from the screen.
 */

/**
 * Divide `total` into `parts` shares that sum to **exactly** `total`.
 *
 * The obvious implementation — `total / parts`, rounded, repeated — does not add up: €10.00 across
 * three guests gives 3.33 × 3 = €9.99, and the till is a cent short on every such table. A cent lost
 * per split is not a rounding curiosity; it is a drawer that never reconciles.
 *
 * So the base share is rounded **down** and the remainder is handed out one minor unit at a time,
 * from the first share onwards. Deterministic, and the difference between any two shares is at most
 * one cent — which is the fairest distribution that still sums exactly.
 *
 * Earlier shares are the larger ones deliberately: the guest who pays first absorbs the extra cent,
 * and the alternative (loading it onto the last payer) means the person left holding the tab also
 * pays the most, which is the wrong way round.
 *
 * @param total  the amount to divide, as a decimal string
 * @param parts  how many ways, at least 1
 * @param scale  minor-unit digits for the currency (2 for euro, 0 for yen)
 */
export function evenSplitAmounts(total: string, parts: number, scale = 2): string[] {
    if (!Number.isInteger(parts) || parts < 1) {
        throw new RangeError('split_parts_invalid');
    }

    const amount = Decimal.of(total);

    // A negative total is a refund being split; the same rule applies, mirrored, and `div` with
    // `DOWN` truncates toward zero so the remainder stays the same sign as the total.
    const base = amount.div(String(parts), scale, 'down');
    const shares = Array.from({ length: parts }, () => base);

    // What rounding down left behind, in minor units — always smaller than `parts`.
    const step = Decimal.of('1').div(String(10 ** scale), scale, 'down');
    let remainder = amount.sub(base.mul(String(parts)));

    for (let i = 0; i < parts && !remainder.isZero(); i += 1) {
        const give = remainder.toString().startsWith('-') ? step.negate() : step;

        shares[i] = shares[i]!.add(give);
        remainder = remainder.sub(give);
    }

    return shares.map((share) => share.toString());
}

/**
 * What is still owed after taking `paid` off `total`, never below zero.
 *
 * Clamped because an overpayment is change, not a negative bill: a remainder that went negative
 * would make the "keep splitting" loop offer to collect money the table does not owe.
 */
export function remainderAfter(total: string, paid: string): string {
    const left = Decimal.of(total).sub(paid);

    return left.toString().startsWith('-') ? '0.00' : left.toString();
}

/**
 * Clamp a typed split amount to something the bill can actually take.
 *
 * A waiter typing more than the outstanding balance means "settle it", not "collect extra and hand
 * back change on a split" — the change would come out of a drawer against an order that is not
 * finished, and the next guest's share would be computed from a total already overpaid.
 */
export function clampSplitAmount(requested: string, outstanding: string): string {
    const want = Decimal.of(requested);

    if (want.toString().startsWith('-') || want.isZero()) return '0.00';

    return Decimal.of(outstanding).sub(want).toString().startsWith('-') ? Decimal.of(outstanding).toString() : want.toString();
}

/** Is the bill settled — nothing left to collect? */
export function isFullySplit(outstanding: string): boolean {
    return Decimal.of(outstanding).isZero();
}

/**
 * The bill a just-settled split came off, if it still owes money (RST-107).
 *
 * After collecting one guest's share the waiter's next act is almost always the next guest. Sending
 * them to a blank order means finding the table again for every person sitting at it — which is the
 * whole reason "split the bill" feels slow on a till that has no loop.
 *
 * Returns `null` for an ordinary sale, for a parent that is already settled, and for a parent that
 * has since gone away, so the receipt screen simply shows what it always did.
 */
export function splitRemainder(paidOrderUuid: string): { orderUuid: string; due: string } | null {
    const state = useOrderStore.getState();
    const paid = state.orders[paidOrderUuid];
    const parentUuid = paid?.split_from_order_uuid ?? null;

    if (parentUuid === null) return null;

    const parent = state.orders[parentUuid];
    if (!parent) return null;

    const due = computeTotals(parent, linesOf(state, parentUuid), paymentsOf(state, parentUuid), getCatalog()).due;

    return Decimal.of(due).signum() > 0 ? { orderUuid: parentUuid, due } : null;
}
