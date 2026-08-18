import { Decimal } from '@domain/money/decimal';
import type { OrderRow } from '@domain/types';

/**
 * Entering a tip (RST-123, RST-127).
 *
 * The money side of a tip is settled — `tips.ts` decides which tender it lands on and
 * `order-actions.setTip` applies it (RST-125). What was missing is everything around the number: a
 * screen to type it on, a guard on the ones that are obviously wrong, and a way to work through a
 * whole shift instead of one receipt at a time.
 *
 * The guard is the part worth being careful about. A tip is entered on a settled sale, and the
 * amount is often read off a signed slip by someone who did not take the payment — so the failure is
 * not fraud, it is a decimal point. `18.00` typed into the field of a `12.10` bill is a 149 % tip,
 * and it will balance perfectly: the tender is topped up, the order reconciles, and nothing is wrong
 * until the acquirer's statement arrives. Nothing downstream can catch it, which is why it is caught
 * here.
 */

/** Above this, a tip is confirmed before it is applied (RST-123). */
export const TIP_CONFIRM_PERCENT = 25;

/** The percentage presets a waiter taps rather than types. */
export const TIP_PRESETS = ['15', '20', '25'] as const;

/** `percent` of `total`, rounded to the currency's two places. */
export function tipFromPercent(total: string, percent: string): string {
    return Decimal.of(total).mul(percent).div('100', 4).withScale(2).toString();
}

/**
 * What proportion of the bill this tip is, as a percentage.
 *
 * Zero when the bill is zero: a tip on a nil bill has no proportion to be a percentage *of*, and
 * dividing would be an error rather than a large number.
 */
export function tipPercentOf(total: string, amount: string): string {
    const bill = Decimal.of(total);

    if (bill.isZero()) return '0';

    return Decimal.of(amount).mul('100').div(bill.toString(), 4).withScale(2).toString();
}

/** Is this tip large enough to be worth asking about first? */
export function needsTipConfirmation(total: string, amount: string): boolean {
    // A tip on a nil bill is unusual enough to confirm on its own — there is no total for it to be a
    // sane proportion of, so the percentage test cannot speak for it.
    if (Decimal.of(total).isZero()) return !Decimal.of(amount).isZero();

    return Decimal.of(tipPercentOf(total, amount)).gt(String(TIP_CONFIRM_PERCENT));
}

/** A typed tip, or null when the text is not a usable amount. */
export function parseTip(input: string): string | null {
    const trimmed = input.trim();

    if (trimmed === '') return null;
    if (!/^\d+([.,]\d{0,2})?$/.test(trimmed)) return null;

    return Decimal.of(trimmed.replace(',', '.')).withScale(2).toString();
}

/**
 * A row in the shift-wide settlement grid (RST-127).
 *
 * Tips arrive in a batch at the end of service — a stack of signed card slips — and settling them
 * one receipt at a time means finding each order first. The grid is the whole shift's unsettled card
 * sales in one list, so the work is "type, type, type" rather than "search, type, back, search".
 */
export type SettlementRow = {
    orderUuid: string;
    /** What the customer is called on the slip: the order name, or its receipt number. */
    label: string;
    total: string;
    /** What is already on the order — a tip settled earlier in the same pass. */
    tip: string;
};

/**
 * The orders a manager still has to settle: paid, untipped, and not already dealt with.
 *
 * Refunds are excluded — nobody tips a refund, and a negative row in this grid would be an invitation
 * to type a number into it.
 */
export function settlementRows(
    orders: readonly OrderRow[],
    /**
     * What the bill comes to. Passed in rather than read off `amount_total`, which is
     * server-authoritative and still `"0"` on any order that has not round-tripped — offline, that is
     * every order.
     *
     * Reading the column looked right and was wrong twice over: every row would show a nil bill, so
     * the grid could not be checked against the slips in hand, and every tip would look like a tip on
     * a zero total and ask for confirmation. A prompt that fires on all of them is a prompt everyone
     * taps through, which is the one failure the confirmation cannot survive.
     */
    totalOf: (orderUuid: string) => string,
): SettlementRow[] {
    return orders
        .filter((order) => order.state === 'paid' && !order.is_refund && !order.is_tipped)
        .map((order) => ({
            orderUuid: order.uuid,
            label: order.floating_order_name ?? order.name ?? order.receipt_number,
            total: totalOf(order.uuid),
            tip: order.tip_amount ?? '0',
        }));
}

/** What the whole pass adds up to, for the manager to check against the slips in their hand. */
export function settlementTotal(entries: Readonly<Record<string, string>>): string {
    return Object.values(entries)
        .reduce((sum, amount) => sum.add(Decimal.of(parseTip(amount) ?? '0')), Decimal.of('0'))
        .withScale(2)
        .toString();
}
