import type { PaymentMethodRow, PaymentRow } from '@domain/types';

import type { RegisterKey } from '../i18n';

/**
 * The seam between the payment screen and a card terminal (REG-210, REG-212).
 *
 * Full driver work is Phase 5 and **no driver is registered today**. This exists anyway, and
 * deliberately so: REG-210 says to design it as a registry from day one, and the alternative — the
 * screen reaching for a terminal directly once one arrives — is how the cancel path ends up written
 * twice, once per provider.
 *
 * What matters right now is the *absence* case, because it is the only case. Cancelling used to
 * flip `payment_status` to `'cancelled'` locally and nothing else, which reads as "the terminal was
 * told" while a real capture stays live on the device. The customer is then charged for a payment
 * the register believes it cancelled. With no driver, this module says so rather than pretending:
 * the register cannot reach the terminal, so the *cashier* is the driver, and the flow has to route
 * through the button they press on the terminal itself.
 */

export type TerminalCancelResult =
    | { readonly ok: true }
    /** `reason` is an i18n key the screen shows verbatim. */
    | { readonly ok: false; readonly reason: RegisterKey };

export type TerminalDriver = {
    /** Matches `payment_methods.terminal_provider`. */
    readonly provider: string;
    /** Reverse an in-flight authorisation. Must resolve, never throw. */
    cancel(payment: PaymentRow): Promise<TerminalCancelResult>;
};

const drivers = new Map<string, TerminalDriver>();

export function registerTerminalDriver(driver: TerminalDriver): void {
    drivers.set(driver.provider, driver);
}

/** Test seam; also what a config reload uses. */
export function clearTerminalDrivers(): void {
    drivers.clear();
}

export function terminalDriverFor(method: PaymentMethodRow | undefined): TerminalDriver | null {
    if (method?.method_type !== 'card_terminal') return null;
    if (method.terminal_provider === null) return null;

    return drivers.get(method.terminal_provider) ?? null;
}

/** Is this line an authorisation that may still be live on a terminal? */
export function isInFlight(payment: PaymentRow, method: PaymentMethodRow | undefined): boolean {
    if (method?.method_type !== 'card_terminal') return false;

    // `authorized` counts: the money is held even though it has not captured, and dropping the line
    // leaves the hold on the customer's card with nothing pointing at it.
    return payment.payment_status === 'pending' || payment.payment_status === 'authorized';
}

/**
 * Cancel on the terminal before the line is allowed to go (REG-212).
 *
 * Returns `ok` for every line that is *not* in flight, because there is nothing to reverse — a
 * cash line, a card line already refused, a capture that completed. Only a live authorisation has
 * to be answered for.
 */
export async function cancelOnTerminal(
    payment: PaymentRow,
    method: PaymentMethodRow | undefined,
): Promise<TerminalCancelResult> {
    if (!isInFlight(payment, method)) return { ok: true };

    const driver = terminalDriverFor(method);

    if (driver === null) {
        // No integration, so the register genuinely does not know whether the terminal captured.
        // Refusing is the only answer that cannot lose money: the cashier cancels on the terminal,
        // marks the line cancelled, and then the delete goes through.
        return { ok: false, reason: 'reg.pay.terminalCancelManually' };
    }

    return driver.cancel(payment);
}
