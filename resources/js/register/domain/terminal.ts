import { Decimal } from '@domain/money/decimal';
import type { PaymentStatus } from '@domain/enums';
import type { OrderRow, PaymentMethodRow, PaymentRow } from '@domain/types';

import type { RegisterKey } from '../i18n';

/**
 * The seam between the payment screen and a card terminal (REG-210, REG-212, XCT-060).
 *
 * **No vendor driver ships today, and this module is not one.** It is the registry drivers plug
 * into, plus the rules that hold whether or not a driver is present. Building it first is REG-210's
 * instruction — "design as a driver registry from day one even if we ship only one driver" — and the
 * alternative, the screen reaching for a terminal directly once one arrives, is how the cancel path
 * ends up written once per provider.
 *
 * ## Why the absence case is the interesting one
 *
 * Every venue today has no driver, so the absence case is not an edge — it is production. The screen
 * used to hand the cashier a **Send to the terminal** button that flipped `payment_status` to
 * `'pending'` and did nothing else: the line then read "Waiting for the terminal…" while nothing had
 * been sent anywhere. A cashier watching that screen believes a card is being taken. That button is
 * gone when there is no driver, because a button that cannot do the thing it is named after is worse
 * than no button.
 *
 * ## Two different questions about cancelling
 *
 * `cancelOnTerminal` and `requestTerminalCancel` look alike and are opposites, so they are named
 * apart deliberately:
 *
 *  - {@link cancelOnTerminal} is the **delete guard** (REG-212). "This row is about to disappear —
 *    may it?" With no driver the answer is *no*, because the register genuinely does not know
 *    whether the terminal captured, and refusing is the only answer that cannot lose money.
 *  - {@link requestTerminalCancel} is the **Cancel button**. "Cancel it." With no driver the cashier
 *    is the driver — they press cancel on the device and this records what they did. Refusing here
 *    would leave them no way to mark the line cancelled and therefore no way to delete it, which
 *    deadlocks the screen against its own guard.
 *
 * ## What a driver is given
 *
 * The payment row and the method row, and nothing else. `payment_methods.terminal_config` is
 * `$hidden` and `encrypted:array` on the model — it is deliberately never shipped to the register —
 * so a driver carries its own transport configuration from the device it runs on, not from the
 * catalogue.
 */

/**
 * What the terminal reports back about the payment it handled.
 *
 * The same five fields the payment row carries, so a result can be applied with
 * `setPaymentStatus(uuid, status, metadata)` and nothing has to be translated on the way. Never a
 * PAN — `card_last4` is the most a terminal is allowed to hand back.
 */
export type TerminalMetadata = Readonly<
    Partial<
        Pick<
            PaymentRow,
            'card_brand' | 'card_last4' | 'auth_code' | 'transaction_reference' | 'terminal_ticket'
        >
    >
>;

/** The terminal answered, and this is what the line becomes. */
export type TerminalOk = {
    readonly ok: true;
    readonly status: PaymentStatus;
    readonly metadata?: TerminalMetadata;
};

/** The operation did not happen. `reason` is an i18n key the screen shows verbatim. */
export type TerminalRefusal = { readonly ok: false; readonly reason: RegisterKey };

export type TerminalResult = TerminalOk | TerminalRefusal;

/**
 * The verbs a terminal has to support (XCT-060).
 *
 * Every one resolves — none of them throws. A driver that throws anyway is caught by `attempt` and
 * turned into a refusal, because an unhandled rejection would leave the screen locked on a line it
 * is still awaiting.
 */
export type TerminalDriver = {
    /** Matches `payment_methods.terminal_provider`. */
    readonly provider: string;
    /** Present the amount and wait for the customer. Resolves with the terminal's own verdict. */
    send(payment: PaymentRow, method: PaymentMethodRow): Promise<TerminalResult>;
    /** Abort an authorisation that has not captured. */
    cancel(payment: PaymentRow): Promise<TerminalResult>;
    /** Undo a capture that completed. */
    reverse(payment: PaymentRow): Promise<TerminalResult>;
    /** Add a tip to a capture the terminal is still holding (RST-128). */
    adjust(payment: PaymentRow, tip: string): Promise<TerminalResult>;
    /** Ask the terminal what it believes the state of this payment is. */
    status(payment: PaymentRow): Promise<TerminalResult>;
};

const drivers = new Map<string, TerminalDriver>();

/**
 * `terminal_provider` values that mean "no terminal".
 *
 * `none` is the column's **default** (`2025_01_01_000104_create_config_tables.php`), so it is what
 * an unconfigured method ships to the register — not `null`. Checking only for `null`, as the first
 * version did, would let a driver registered under the literal provider `'none'` claim every
 * unconfigured card method on the register.
 */
const NO_TERMINAL = new Set(['', 'none']);

export function registerTerminalDriver(driver: TerminalDriver): void {
    drivers.set(driver.provider, driver);
}

/** Test seam; also what a config reload uses. */
export function clearTerminalDrivers(): void {
    drivers.clear();
}

export function terminalDriverFor(method: PaymentMethodRow | undefined): TerminalDriver | null {
    if (method?.method_type !== 'card_terminal') return null;

    const provider = method.terminal_provider;
    if (provider === null || NO_TERMINAL.has(provider)) return null;

    return drivers.get(provider) ?? null;
}

/** Does this method have a driver behind it? What the screen asks before rendering the buttons. */
export function hasTerminalDriver(method: PaymentMethodRow | undefined): boolean {
    return terminalDriverFor(method) !== null;
}

/** Is this line an authorisation that may still be live on a terminal? */
export function isInFlight(payment: PaymentRow, method: PaymentMethodRow | undefined): boolean {
    if (method?.method_type !== 'card_terminal') return false;

    // `authorized` counts: the money is held even though it has not captured, and dropping the line
    // leaves the hold on the customer's card with nothing pointing at it.
    return payment.payment_status === 'pending' || payment.payment_status === 'authorized';
}

/**
 * Is this money going *out*? (REG-210)
 *
 * Three signals rather than one, because they can disagree. `order.is_refund` marks the whole
 * document; `payment.is_refund` is set from the sign when the line is created; and a row that
 * arrived from the server carries whatever the server stored. Any one of them is enough — a sale
 * presented on a terminal for a negative amount is not a refund, it is a malformed sale.
 */
function isMoneyGoingOut(payment: PaymentRow, order: OrderRow | null | undefined): boolean {
    return order?.is_refund === true || payment.is_refund || Decimal.of(payment.amount).signum() < 0;
}

/**
 * Run a driver call so that a throw becomes a refusal.
 *
 * The contract says a driver never throws. A driver talking to a device over a socket will anyway —
 * a timeout, a dropped pairing, a vendor SDK rejecting — and an unhandled rejection here leaves the
 * screen's in-flight lock set forever on a line nobody can touch again.
 */
async function attempt(run: () => Promise<TerminalResult>): Promise<TerminalResult> {
    try {
        return await run();
    } catch {
        return { ok: false, reason: 'reg.pay.terminalFailed' };
    }
}

/**
 * Send the amount to the terminal (REG-210).
 *
 * Guard order is deliberate. **Refunds are refused first**, before the driver is even looked up, so
 * the answer is the same on every register whether or not one is configured: a refund is never
 * presented as a sale. 02-features REG-210 states it flatly — "Refund orders must not auto-send to
 * the terminal" — and the reason is that the terminal would take the money *again*. Reversing the
 * original capture is the operation that was meant; `reverseOnTerminal` is where it lives.
 *
 * A captured line is refused too. Re-sending it would present a second sale for the same tender,
 * which is the one mistake on this screen that charges a customer twice.
 */
export async function sendToTerminal(
    payment: PaymentRow,
    method: PaymentMethodRow | undefined,
    order: OrderRow | null | undefined,
): Promise<TerminalResult> {
    if (isMoneyGoingOut(payment, order)) return { ok: false, reason: 'reg.pay.terminalRefundNoSend' };
    if (payment.payment_status === 'done') return { ok: false, reason: 'reg.pay.terminalAlreadyDone' };

    const driver = terminalDriverFor(method);
    if (driver === null || method === undefined) return { ok: false, reason: 'reg.pay.terminalNoDriver' };

    return attempt(() => driver.send(payment, method));
}

/**
 * The **Cancel** button (REG-212).
 *
 * Not the delete guard — see `cancelOnTerminal` and the note at the top of this module. With no
 * driver this succeeds and marks the line cancelled, because the cashier pressed cancel on the
 * device themselves and this is the only place they can record it.
 */
export async function requestTerminalCancel(
    payment: PaymentRow,
    method: PaymentMethodRow | undefined,
): Promise<TerminalResult> {
    if (payment.payment_status === 'cancelled') return { ok: true, status: 'cancelled' };

    const driver = terminalDriverFor(method);
    if (driver === null) return { ok: true, status: 'cancelled' };

    return attempt(() => driver.cancel(payment));
}

/**
 * Undo a capture that already completed (REG-212).
 *
 * Only a `done` line can be reversed: an authorisation is cancelled, not reversed, and reversing a
 * line the terminal never took would refund money that was never charged.
 */
export async function reverseOnTerminal(
    payment: PaymentRow,
    method: PaymentMethodRow | undefined,
): Promise<TerminalResult> {
    if (payment.payment_status !== 'done') return { ok: false, reason: 'reg.pay.terminalNothingToReverse' };

    const driver = terminalDriverFor(method);
    if (driver === null) return { ok: false, reason: 'reg.pay.terminalNoDriver' };

    return attempt(() => driver.reverse(payment));
}

/**
 * Add a tip to a capture the terminal is holding (RST-128).
 *
 * **Not yet called by any screen, and that is stated rather than hidden.** `setTip` tops the card
 * tender up in the register's own numbers (`order-actions.ts`, RST-125) and the acquirer is told by
 * the batch; routing that through the terminal is RST-128's own work, and it carries a question this
 * ticket cannot answer — whether an adjustment is legal against an authorisation that has not
 * captured differs per vendor. It ships here because the registry is the contract a driver is
 * written against, and a verb missing from the contract is a verb the first vendor driver invents
 * its own name for.
 */
export async function adjustOnTerminal(
    payment: PaymentRow,
    method: PaymentMethodRow | undefined,
    tip: string,
): Promise<TerminalResult> {
    if (payment.is_refund) return { ok: false, reason: 'reg.pay.terminalRefundNoSend' };

    // A tip rides on money the terminal is holding. Anything else has nothing to be added to.
    if (payment.payment_status !== 'done' && payment.payment_status !== 'authorized') {
        return { ok: false, reason: 'reg.pay.terminalNothingToAdjust' };
    }

    if (Decimal.of(tip).signum() <= 0) return { ok: false, reason: 'reg.pay.terminalAdjustInvalid' };

    const driver = terminalDriverFor(method);
    if (driver === null) return { ok: false, reason: 'reg.pay.terminalNoDriver' };

    return attempt(() => driver.adjust(payment, tip));
}

/**
 * Ask the terminal what it thinks (XCT-060 status polling).
 *
 * The answer to "the customer says it went through and the register says pending". Without it the
 * only way out of that standoff is **Force as paid**, which is the register guessing.
 */
export async function terminalStatus(
    payment: PaymentRow,
    method: PaymentMethodRow | undefined,
): Promise<TerminalResult> {
    const driver = terminalDriverFor(method);
    if (driver === null) return { ok: false, reason: 'reg.pay.terminalNoDriver' };

    return attempt(() => driver.status(payment));
}

/**
 * Cancel on the terminal before the line is allowed to go — the **delete guard** (REG-212).
 *
 * Returns `ok` for every line that is *not* in flight, because there is nothing to reverse — a cash
 * line, a card line already refused, a capture that completed. Only a live authorisation has to be
 * answered for.
 */
export async function cancelOnTerminal(
    payment: PaymentRow,
    method: PaymentMethodRow | undefined,
): Promise<TerminalResult> {
    if (!isInFlight(payment, method)) return { ok: true, status: payment.payment_status };

    const driver = terminalDriverFor(method);

    if (driver === null) {
        // No integration, so the register genuinely does not know whether the terminal captured.
        // Refusing is the only answer that cannot lose money: the cashier cancels on the terminal,
        // marks the line cancelled, and then the delete goes through.
        return { ok: false, reason: 'reg.pay.terminalCancelManually' };
    }

    return attempt(() => driver.cancel(payment));
}
