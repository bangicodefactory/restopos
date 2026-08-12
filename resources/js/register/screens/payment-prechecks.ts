import { Decimal, ZERO } from '@domain/money/decimal';
import { CashRoundingCalculator } from '@domain/tax/rounder';
import type { CashRounding } from '@domain/tax/types';
import type { OrderLineRow, PaymentMethodRow, PaymentRow } from '@domain/types';

/**
 * What has to be true before an order may be validated (REG-216).
 *
 * Kept out of the JSX and unit-tested directly, which is the house pattern for a decision that
 * costs money — `settlesOrder`, `quickAmountsFor`, `needsKitchenPromptBeforePay` all live this way.
 * A rule embedded in a click handler can only be reached by rendering, and the combinations here
 * are the point: eight inputs, and the bugs live in the order they are judged in rather than in any
 * one of them. The DOM test covers the wiring; this covers the decision.
 *
 * The order of operations is deliberate and is Odoo's: **strip first, then judge**. A zero-amount
 * line the cashier opened and abandoned, or a terminal line still waiting for an answer, is not a
 * tender — leaving either in place makes "is this paid?" answer against rows that carry no money,
 * and pushes them to the server where a pending line would be booked as taken.
 *
 * One check named in the spec is deliberately absent. REG-216 lists "missing-lot confirmation", but
 * lot / serial tracking (REG-076) is P2 and unbuilt: there is no lot column anywhere in the schema,
 * so there is nothing to confirm. Adding a stub that always passes would read as coverage.
 */

/** Why validation cannot proceed at all. */
export type PrecheckBlock =
    | 'empty_order'
    | 'not_enough'
    | 'overpay_no_cash'
    | 'unrounded_cash'
    | 'needs_customer';

/** Something the cashier has to agree to before it goes through. */
export type PrecheckConfirm = 'large_overpay';

export type PrecheckResult = {
    /** Payment uuids to drop before anything else. Always act on these, blocked or not. */
    readonly strip: readonly string[];
    /** The first blocking problem, or null. */
    readonly block: PrecheckBlock | null;
    /** A confirmation to ask for once nothing blocks, or null. */
    readonly confirm: PrecheckConfirm | null;
};

export type PrecheckInput = {
    readonly lines: readonly OrderLineRow[];
    readonly payments: readonly PaymentRow[];
    readonly methods: readonly PaymentMethodRow[];
    readonly cashRounding: CashRounding | null;
    /** Remaining due after the payments that survive stripping. */
    readonly due: string;
    /** Change owed on those same payments. */
    readonly change: string;
    /** What the order is actually worth — the denominator for the overpay ratio. */
    readonly total: string;
    readonly customerId: number | null;
    /** Does the settlement clear the order? `settlesOrder`, passed in rather than recomputed. */
    readonly settled: boolean;
    readonly hasCashMethod: boolean;
};

/**
 * How far past the due a tender has to be before it is treated as a typo (REG-216).
 *
 * Odoo's number, and the reasoning holds: a mis-keyed amount is usually a factor-of-ten slip, and
 * three orders of magnitude is far past any of them. €12.10 taken as €12 100 is a fat finger; the
 * cashier is asked rather than blocked, because a genuinely huge tender is not the register's call.
 */
export const LargeOverpayFactor = '1000';

/**
 * Lines that carry no quantity are not a sale.
 *
 * A zero-qty line reaches the kitchen as an item nobody ordered and the receipt as a row worth
 * nothing. Odoo drops them at validation; so do we, and an order that is *only* such lines is empty.
 */
export function tradingLines(lines: readonly OrderLineRow[]): readonly OrderLineRow[] {
    return lines.filter((line) => line.quantity !== 0);
}

/**
 * Payment lines that are not tenders and must not be validated with the order.
 *
 * Two kinds. A **zero-amount** line is a keystroke the cashier abandoned. A **pending** line is a
 * terminal that has not answered — pushing it settles the order against money nobody has confirmed
 * was taken, and the server books `payment_status` as sent. Cancelled and failed lines are left
 * alone: they already say they took nothing, and they are part of the audit trail of the attempt.
 */
export function strippablePayments(payments: readonly PaymentRow[]): readonly string[] {
    return payments
        .filter(
            (payment) =>
                !payment.is_change &&
                (payment.payment_status === 'pending' || Decimal.of(payment.amount).isZero()),
        )
        .map((payment) => payment.uuid);
}

/**
 * Is every cash tender an amount the drawer can physically make? (REG-202/REG-216)
 *
 * Only asked when cash rounding is configured. The pre-fill already rounds, but the numpad does
 * not: a cashier who types 12.13 against a 0.05 step has entered an amount no drawer can hold, and
 * the session then counts short by a few cents per sale with nothing to point at.
 *
 * Card lines are exempt — a terminal charges the exact figure, which is the same reason the
 * fully-paid tolerance is a cash-only concession.
 */
export function cashLinesAreRounded(
    payments: readonly PaymentRow[],
    methods: readonly PaymentMethodRow[],
    cashRounding: CashRounding | null,
): boolean {
    if (cashRounding === null) return true;

    const calculator = new CashRoundingCalculator(cashRounding);

    return payments.every((payment) => {
        if (payment.is_change) return true;
        if (payment.payment_status === 'failed' || payment.payment_status === 'cancelled') return true;

        const method = methods.find((candidate) => candidate.id === payment.payment_method_id);
        if (method?.is_cash_count !== true) return true;

        const amount = Decimal.of(payment.amount);

        return calculator.apply(amount).roundedTotal.eq(amount);
    });
}

/** Does any surviving payment line need a customer attached? (REG-208, REG-216) */
export function needsCustomer(
    payments: readonly PaymentRow[],
    methods: readonly PaymentMethodRow[],
): boolean {
    return payments.some((payment) => {
        const method = methods.find((candidate) => candidate.id === payment.payment_method_id);

        // `identify_customer` is the configurable flag; `customer_account` is structural — a tab
        // with nobody's name on it is money that vanishes, and the server rejects it outright.
        return method?.identify_customer === true || method?.method_type === 'customer_account';
    });
}

/**
 * Is this tender so far past the total that it is more likely a typo? (REG-216)
 *
 * Measured against the order total rather than the change, so the ratio means "they handed over N
 * times what this costs". A zero-value order has no ratio and is never flagged — the empty-order
 * check owns that case.
 */
export function isLargeOverpay(total: string, change: string): boolean {
    const owed = Decimal.of(total);

    if (owed.signum() <= 0) return false;
    if (Decimal.of(change).signum() <= 0) return false;

    // tendered = total + change, so tendered > 1000 × total ⟺ change > 999 × total.
    return Decimal.of(change).gt(owed.mul(Decimal.of(LargeOverpayFactor).sub('1')));
}

/** The whole decision, in the order the screen should act on it. */
export function precheckPayment(input: PrecheckInput): PrecheckResult {
    const strip = strippablePayments(input.payments);
    const stripped = new Set(strip);
    const live = input.payments.filter((payment) => !stripped.has(payment.uuid));

    const block = firstBlock(input, live);

    return {
        strip,
        block,
        // Never asked while something blocks: a cashier should not confirm a huge tender on an
        // order that is about to be refused for a different reason.
        confirm: block === null && isLargeOverpay(input.total, input.change) ? 'large_overpay' : null,
    };
}

function firstBlock(input: PrecheckInput, live: readonly PaymentRow[]): PrecheckBlock | null {
    if (tradingLines(input.lines).length === 0) return 'empty_order';

    if (needsCustomer(live, input.methods) && input.customerId == null) return 'needs_customer';

    if (!cashLinesAreRounded(live, input.methods, input.cashRounding)) return 'unrounded_cash';

    if (!input.settled) return 'not_enough';

    if (Decimal.of(input.change).signum() > 0 && !input.hasCashMethod) return 'overpay_no_cash';

    return null;
}

/**
 * Payment lines whose method is no longer on this register (REG-219).
 *
 * An order can sit open across a config change — a floating tab, a table left overnight — and come
 * back holding a tender the venue has stopped accepting. Validating it would push a
 * `payment_method_id` the config no longer carries, and the cashier has no way to see why the
 * screen refuses, because the line renders with a dash for a name.
 *
 * Dropped on mount rather than blocked, because there is nothing for the cashier to decide: the
 * method is gone. The amount comes back as due and is tendered again with something that exists.
 */
export function orphanedPayments(
    payments: readonly PaymentRow[],
    configuredMethodIds: readonly number[],
): readonly string[] {
    const configured = new Set(configuredMethodIds);

    return payments
        // A change line belongs to the server and is re-derived from the tenders; removing it here
        // would make the screen briefly disagree with what the order is worth.
        .filter((payment) => !payment.is_change && !configured.has(payment.payment_method_id))
        .map((payment) => payment.uuid);
}

/** Total of the live tenders, for a caller that has stripped lines and needs the due again. */
export function tenderedTotal(payments: readonly PaymentRow[]): string {
    return payments
        .filter((payment) => !payment.is_change)
        .reduce((sum, payment) => sum.add(Decimal.of(payment.amount)), ZERO)
        .withScale(2)
        .toString();
}
