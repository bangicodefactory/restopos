import type { PaymentStatus } from '@domain/enums';
import type { CashRounding } from '@domain/tax/types';
import type { OrderLineRow, PaymentMethodRow, PaymentRow } from '@domain/types';
import { asUuid } from '@domain/types';
import { describe, expect, it } from 'vitest';

import {
    cashLinesAreRounded,
    isLargeOverpay,
    needsCustomer,
    orphanedPayments,
    precheckPayment,
    strippablePayments,
    tradingLines,
} from './payment-prechecks';
import type { PrecheckInput } from './payment-prechecks';

/**
 * BAN-434 / REG-216 — what has to be true before an order may be validated.
 *
 * The screen had four of the spec's checks and was missing four more, each of which loses money in
 * a different direction: an unrounded cash tender counts the drawer short every sale, a mis-keyed
 * €12 100 goes through silently, an abandoned zero line and a terminal line still waiting both get
 * pushed as though money was taken.
 *
 * `precheckPayment` is exercised as the screen composes it — strip first, then judge — rather than
 * each predicate being trusted on its own. The order is where the bugs are: judging before
 * stripping answers "is this paid?" against rows that carry no money.
 */

const CASH: PaymentMethodRow = {
    id: 1,
    company_id: 1,
    name: 'Espèces',
    method_type: 'cash',
    is_cash_count: true,
    identify_customer: false,
    split_transactions: false,
    payment_provider_id: null,
    terminal_provider: null,
    image_media_id: null,
    sequence: 1,
    active: true,
};
const CARD: PaymentMethodRow = { ...CASH, id: 2, name: 'Carte', method_type: 'card_terminal', is_cash_count: false };
const ACCOUNT: PaymentMethodRow = { ...CASH, id: 3, name: 'On account', method_type: 'customer_account', is_cash_count: false };
const IDENTIFIED: PaymentMethodRow = { ...CASH, id: 4, name: 'Meal voucher', method_type: 'voucher', is_cash_count: false, identify_customer: true };
const METHODS = [CASH, CARD, ACCOUNT, IDENTIFIED];

const HALF_UP_5C: CashRounding = { rounding: '0.05', method: 'half_up' };

let counter = 0;
function payment(methodId: number, amount: string, status: PaymentStatus = 'done'): PaymentRow {
    counter += 1;
    return {
        uuid: asUuid(`payment-${counter}`),
        id: null,
        order_uuid: asUuid('order-1'),
        pos_session_id: 1,
        payment_method_id: methodId,
        currency_id: 1,
        amount,
        is_change: false,
        is_refund: false,
        label: null,
        paid_at: '2026-01-01T00:00:00.000Z',
        customer_id: null,
        employee_id: null,
        payment_status: status,
        card_brand: null,
        card_last4: null,
        auth_code: null,
        transaction_reference: null,
        terminal_ticket: null,
        rev: 0,
    };
}

function line(quantity: number): OrderLineRow {
    counter += 1;
    return { uuid: asUuid(`line-${counter}`), quantity } as OrderLineRow;
}

function input(overrides: Partial<PrecheckInput> = {}): PrecheckInput {
    return {
        lines: [line(1)],
        payments: [payment(CASH.id, '12.10')],
        methods: METHODS,
        cashRounding: null,
        total: '12.10',
        customerId: null,
        hasCashMethod: true,
        ...overrides,
    };
}

describe('stripping what is not a tender', () => {
    it('drops a zero-amount line the cashier opened and abandoned', () => {
        const zero = payment(CASH.id, '0');

        expect(strippablePayments([payment(CASH.id, '12.10'), zero])).toEqual([zero.uuid]);
    });

    it('drops a terminal line that is still waiting for an answer', () => {
        // Pushing it settles the order against money nobody has confirmed was taken.
        const pending = payment(CARD.id, '12.10', 'pending');

        expect(strippablePayments([pending])).toEqual([pending.uuid]);
    });

    it('keeps a failed or cancelled line, which is the record of an attempt', () => {
        const failed = payment(CARD.id, '12.10', 'failed');
        const cancelled = payment(CARD.id, '12.10', 'cancelled');

        expect(strippablePayments([failed, cancelled])).toEqual([]);
    });

    it('never strips a change line', () => {
        const change: PaymentRow = { ...payment(CASH.id, '0'), is_change: true };

        expect(strippablePayments([change])).toEqual([]);
    });

    it('reports what to strip even when something else blocks', () => {
        // The screen must drop these rows either way; they are not a tender whatever else is wrong.
        const zero = payment(CASH.id, '0');
        const result = precheckPayment(input({ lines: [], payments: [zero] }));

        expect(result.block).toBe('empty_order');
        expect(result.strip).toEqual([zero.uuid]);
    });
});

describe('zero-quantity lines', () => {
    it('does not count a zero-qty line as something sold', () => {
        expect(tradingLines([line(0), line(2)])).toHaveLength(1);
    });

    it('treats an order of nothing but zero-qty lines as empty', () => {
        // It would otherwise reach the kitchen as an item nobody ordered and the receipt as a row
        // worth nothing.
        expect(precheckPayment(input({ lines: [line(0)] })).block).toBe('empty_order');
    });

    it('lets a refund line through, which is negative rather than zero', () => {
        expect(precheckPayment(input({ lines: [line(-1)] })).block).toBeNull();
    });
});

describe('cash tenders the drawer can make (REG-202)', () => {
    it('accepts an amount on the rounding step', () => {
        expect(cashLinesAreRounded([payment(CASH.id, '12.10')], METHODS, HALF_UP_5C)).toBe(true);
    });

    it('refuses an amount the drawer has no coin for', () => {
        // The pre-fill rounds, but the numpad does not: typed by hand, this counts the session
        // short by a few cents a sale with nothing to point at.
        expect(cashLinesAreRounded([payment(CASH.id, '12.13')], METHODS, HALF_UP_5C)).toBe(false);
        expect(precheckPayment(input({ payments: [payment(CASH.id, '12.13')], cashRounding: HALF_UP_5C })).block)
            .toBe('unrounded_cash');
    });

    it('exempts a card line, which is charged the exact figure', () => {
        expect(cashLinesAreRounded([payment(CARD.id, '12.13')], METHODS, HALF_UP_5C)).toBe(true);
    });

    it('asks nothing at all when the venue has no cash rounding', () => {
        expect(cashLinesAreRounded([payment(CASH.id, '12.13')], METHODS, null)).toBe(true);
    });

    it('ignores a line that took nothing', () => {
        expect(cashLinesAreRounded([payment(CASH.id, '12.13', 'cancelled')], METHODS, HALF_UP_5C)).toBe(true);
    });
});

describe('a tender that looks like a typo (REG-216)', () => {
    it('flags more than a thousand times the total', () => {
        // €12.10 taken as €12 110 — change 12 097.90, a ratio of about 1001×. Note that €12 100
        // exactly is *not* flagged: it is 1000×, which the boundary test below pins.
        expect(isLargeOverpay('12.10', '12097.90')).toBe(true);
        expect(precheckPayment(input({ payments: [payment(CASH.id, '12110.00')] })).confirm).toBe('large_overpay');
    });

    it('leaves an ordinary large note alone', () => {
        expect(isLargeOverpay('12.10', '37.90')).toBe(false);
        expect(precheckPayment(input({ payments: [payment(CASH.id, '50.00')] })).confirm).toBeNull();
    });

    it('sits exactly on the boundary without firing', () => {
        // Tendered = 1000 × total is the limit, not past it.
        expect(isLargeOverpay('1.00', '999.00')).toBe(false);
        expect(isLargeOverpay('1.00', '999.01')).toBe(true);
    });

    it('never flags an order worth nothing, which the empty check owns', () => {
        expect(isLargeOverpay('0.00', '50.00')).toBe(false);
    });

    it('does not ask for a confirmation while something else blocks', () => {
        // Confirming a huge tender on an order about to be refused for another reason is a prompt
        // the cashier learns to dismiss.
        // A huge *pending* tender: stripped, so nothing is settled and nothing is confirmed.
        const result = precheckPayment(input({ payments: [payment(CASH.id, '12110.00', 'pending')] }));

        expect(result.block).toBe('not_enough');
        expect(result.confirm).toBeNull();
    });
});

describe('tenders that need a name attached', () => {
    it('requires a customer for an on-account tender', () => {
        // Structural, not configurable: the server rejects a tab with nobody to bill.
        expect(needsCustomer([payment(ACCOUNT.id, '12.10')], METHODS)).toBe(true);
        expect(precheckPayment(input({ payments: [payment(ACCOUNT.id, '12.10')] })).block).toBe('needs_customer');
    });

    it('requires a customer for a method flagged identify_customer', () => {
        expect(precheckPayment(input({ payments: [payment(IDENTIFIED.id, '12.10')] })).block).toBe('needs_customer');
    });

    it('is satisfied once a customer is on the order', () => {
        expect(precheckPayment(input({ payments: [payment(ACCOUNT.id, '12.10')], customerId: 7 })).block).toBeNull();
    });

    it('does not demand a customer for a line that is about to be stripped', () => {
        // A pending on-account line is not a tender yet, so it cannot be what forces the prompt.
        const result = precheckPayment(input({ payments: [payment(ACCOUNT.id, '12.10', 'pending')] }));

        expect(result.block).toBe('not_enough');
    });
});

describe('an uncaptured tender never settles an order (review of #51)', () => {
    it('does not validate an order whose only tender is still on the terminal', () => {
        // The bug this exists for: `useTotals` counts a pending line as paid (`settledPayments`
        // excludes only failed/cancelled), so the screen used to hand in `settled: true`. The
        // precheck then stripped the line *and* saw nothing blocking — and the order validated with
        // no payment rows at all. A sale recorded as settled that nobody paid for.
        const result = precheckPayment(input({ payments: [payment(CARD.id, '12.10', 'pending')] }));

        expect(result.strip).toHaveLength(1);
        expect(result.block).toBe('not_enough');
        expect(result.due).toBe('12.10');
    });

    it('does not validate one whose only tender is authorised but uncaptured', () => {
        // `isInFlight` refuses to let this line be deleted without a terminal cancel, so it cannot
        // also be solid enough to settle the order.
        const result = precheckPayment(input({ payments: [payment(CARD.id, '12.10', 'authorized')] }));

        expect(result.strip).toHaveLength(1);
        expect(result.block).toBe('not_enough');
    });

    it('settles on the cash that is really there when a pending line sits beside it', () => {
        const result = precheckPayment(
            input({ payments: [payment(CASH.id, '12.10'), payment(CARD.id, '99.00', 'pending')] }),
        );

        expect(result.strip).toHaveLength(1);
        expect(result.block).toBeNull();
        // The pending 99.00 must not become change out of the drawer.
        expect(result.change).toBe('0.00');
    });

    it('reports the due left behind once the stripped lines are gone', () => {
        const result = precheckPayment(
            input({ payments: [payment(CASH.id, '5.00'), payment(CARD.id, '7.10', 'pending')] }),
        );

        expect(result.due).toBe('7.10');
        expect(result.block).toBe('not_enough');
    });

    it('still tolerates a cash-rounded short close, which is a real concession', () => {
        // 12.10 owed, 12.10 taken in cash against a 0.05 step — the tolerance survives the rewrite.
        const result = precheckPayment(
            input({ payments: [payment(CASH.id, '12.10')], cashRounding: HALF_UP_5C }),
        );

        expect(result.block).toBeNull();
    });
});

describe('methods the register no longer carries (REG-219)', () => {
    it('drops a line whose method has been taken off the config', () => {
        // A floating tab or a table left overnight comes back holding a tender the venue has
        // stopped accepting; the line renders with a dash for a name, so the cashier cannot see why
        // validating fails.
        const stale = payment(IDENTIFIED.id, '12.10');

        expect(orphanedPayments([payment(CASH.id, '5.00'), stale], [CASH.id])).toEqual([stale.uuid]);
    });

    it('keeps every line whose method is still configured', () => {
        expect(orphanedPayments([payment(CASH.id, '5.00')], [CASH.id, CARD.id])).toEqual([]);
    });

    it('leaves the change line alone, because the server owns it', () => {
        // Removing it would make the screen briefly disagree with what the order is worth.
        const change: PaymentRow = { ...payment(IDENTIFIED.id, '-5.00'), is_change: true };

        expect(orphanedPayments([change], [CASH.id])).toEqual([]);
    });

    it('drops everything when the config carries no methods at all', () => {
        expect(orphanedPayments([payment(CASH.id, '5.00')], [])).toHaveLength(1);
    });
});

describe('the checks that were already there', () => {
    it('still refuses an order with no lines', () => {
        expect(precheckPayment(input({ lines: [] })).block).toBe('empty_order');
    });

    it('still refuses a settlement that does not cover the order', () => {
        expect(precheckPayment(input({ payments: [payment(CASH.id, '5.00')] })).block).toBe('not_enough');
    });

    it('still refuses change with no cash method to give it from', () => {
        expect(precheckPayment(input({ payments: [payment(CARD.id, '20.00')], hasCashMethod: false })).block)
            .toBe('overpay_no_cash');
    });

    it('passes a plain, fully-tendered cash sale', () => {
        const result = precheckPayment(input());

        expect(result.block).toBeNull();
        expect(result.confirm).toBeNull();
        expect(result.strip).toEqual([]);
    });
});
