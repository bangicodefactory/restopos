import type { OrderLineRow, PaymentMethodRow, PosConfigRow } from '@domain/types';

/**
 * One-tap tender buttons on the product screen (REG-209).
 *
 * The whole point is that a counter sale settles without a trip to the payment screen, so the
 * checks the payment screen would have run have to happen here instead. Two of them are structural
 * and are why this is a decision rather than a button:
 *
 *  - **Terminal and split methods are excluded.** The spec says so, and the reason is that neither
 *    can complete in one tap: a terminal has a conversation to hold and a split method has an
 *    amount to be told. A one-tap button for either would settle the order against a payment that
 *    has not happened yet.
 *
 *  - **Restaurant mode still asks about unsent kitchen changes (RST-143).** Fast payment is the
 *    easiest possible way to settle for food the kitchen was never told about, which is the exact
 *    failure RST-143 exists to prevent — so it reuses that predicate rather than bypassing it.
 *
 * The config flag and the pivot behind `fast_payment_method_ids` have existed in the schema and the
 * back office since the config tables were written; nothing read them until now.
 */

/** The methods that get a one-tap button, in the order the back office arranged them. */
export function fastPaymentMethods(
    config: Pick<PosConfigRow, 'use_fast_payment' | 'fast_payment_method_ids' | 'payment_method_ids'> | null,
    methods: readonly PaymentMethodRow[],
): readonly PaymentMethodRow[] {
    if (config?.use_fast_payment !== true) return [];

    return config.fast_payment_method_ids
        .map((id) => methods.find((method) => method.id === id))
        .filter((method): method is PaymentMethodRow => method !== undefined)
        // Still on the register, still usable in one tap. A method dropped from the config but left
        // on the fast list would otherwise put a button on screen that the payment screen refuses.
        .filter((method) => config.payment_method_ids.includes(method.id))
        .filter((method) => isOneTap(method));
}

/**
 * Can this method settle an order in a single tap?
 *
 * `split_transactions` is Odoo's flag for a method that may be spread across several payments —
 * a gift card being drawn down, typically. That needs an amount, so it needs the payment screen.
 */
export function isOneTap(method: PaymentMethodRow): boolean {
    if (method.method_type === 'card_terminal') return false;
    if (method.split_transactions) return false;

    // An on-account tender needs a customer, which the product screen has no way to prompt for
    // without becoming the payment screen. Left to the full flow.
    return method.method_type !== 'customer_account';
}

export type FastPayVerdict =
    | { readonly ok: true }
    /** `askKitchen` means show the RST-143 prompt, not that the tap was refused. */
    | { readonly ok: false; readonly reason: 'empty_order' | 'ask_kitchen' };

/**
 * What a fast-pay tap should do (REG-209).
 *
 * Exported as a plain predicate, the house pattern for a decision that costs money: the verdict is
 * unit-tested here and the wiring is tested through the DOM separately.
 */
export function fastPayVerdict({
    lines,
    restaurant,
    unsent,
}: {
    readonly lines: readonly OrderLineRow[];
    readonly restaurant: boolean;
    readonly unsent: number;
}): FastPayVerdict {
    if (lines.filter((line) => line.quantity !== 0).length === 0) {
        return { ok: false, reason: 'empty_order' };
    }

    if (restaurant && unsent > 0) {
        return { ok: false, reason: 'ask_kitchen' };
    }

    return { ok: true };
}
