import { Decimal } from '@domain/money/decimal';
import { isFullyPaid } from '@domain/tax/rounder';
import type { CashRounding } from '@domain/tax/types';
import type { PaymentStatus } from '@domain/enums';
import type { PaymentMethodRow, PaymentRow } from '@domain/types';
import { asUuid } from '@domain/types';
import { describe, expect, it } from 'vitest';

import { cashRounded, hasCashTender } from './PaymentScreen';

/**
 * REG-176 / REG-202 — the payment screen's half of the cash-rounding fix.
 *
 * The screen's two decisions are exercised here as the screen composes them: what a fresh payment
 * line pre-fills with, and whether the remaining due closes the order.
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
const METHODS = [CASH, CARD];

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

const HALF_UP_5C: CashRounding = { rounding: '0.05', method: 'half_up' };
const UP_5C: CashRounding = { rounding: '0.05', method: 'up' };

/** Exactly what `PaymentScreen` computes for the validate button and the guard. */
function settles(due: string, payments: readonly PaymentRow[], rounding: CashRounding | null): boolean {
    const tolerated = rounding !== null && hasCashTender(payments, METHODS);
    return isFullyPaid(due, tolerated ? rounding.rounding : null, tolerated ? rounding.method : undefined);
}

describe('cashRounded — the payment line pre-fill (REG-202)', () => {
    it('snaps the remaining due to the rounding step', () => {
        expect(cashRounded(Decimal.of('17.52'), HALF_UP_5C).withScale(2).toString()).toBe('17.50');
        expect(cashRounded(Decimal.of('12.33'), HALF_UP_5C).withScale(2).toString()).toBe('12.35');
        expect(cashRounded(Decimal.of('17.52'), UP_5C).withScale(2).toString()).toBe('17.55');
    });

    it('leaves an already-rounded due alone', () => {
        expect(cashRounded(Decimal.of('12.35'), HALF_UP_5C).withScale(2).toString()).toBe('12.35');
    });

    it('passes the due straight through with no cash rounding configured', () => {
        expect(cashRounded(Decimal.of('17.52'), null).withScale(2).toString()).toBe('17.52');
    });

    it('does not invent an amount when nothing is due', () => {
        expect(cashRounded(Decimal.of('0.00'), HALF_UP_5C).withScale(2).toString()).toBe('0.00');
    });

    it('is applied to a cash line and withheld from a card line', () => {
        // What the screen passes: the config's rounding for a cash method, `null` for anything else.
        const prefill = (method: PaymentMethodRow): string =>
            cashRounded(Decimal.of('17.52'), method.is_cash_count ? HALF_UP_5C : null)
                .withScale(2)
                .toString();

        expect(prefill(CASH)).toBe('17.50');
        expect(prefill(CARD)).toBe('17.52');
    });
});

describe('hasCashTender', () => {
    it('sees cash on the order, ignores card', () => {
        expect(hasCashTender([payment(CASH.id, '10.00')], METHODS)).toBe(true);
        expect(hasCashTender([payment(CARD.id, '10.00')], METHODS)).toBe(false);
    });

    it('ignores a failed or cancelled cash line', () => {
        expect(hasCashTender([payment(CASH.id, '10.00', 'failed')], METHODS)).toBe(false);
        expect(hasCashTender([payment(CASH.id, '10.00', 'cancelled')], METHODS)).toBe(false);
    });

    it('is false on an order with no payments at all', () => {
        expect(hasCashTender([], METHODS)).toBe(false);
    });
});

describe('the fully-paid decision (REG-176)', () => {
    it('settles a cash-rounded order tendered at the rounded amount', () => {
        // Raw total 17.52 → rounded 17.50; the cashier tenders 17.50 and the due is exactly nil.
        expect(settles('0.00', [payment(CASH.id, '17.50')], HALF_UP_5C)).toBe(true);
    });

    it('settles a cash tender that falls short by no more than the tolerance', () => {
        expect(settles('0.02', [payment(CASH.id, '17.50')], HALF_UP_5C)).toBe(true);
        expect(settles('0.05', [payment(CASH.id, '17.50')], UP_5C)).toBe(true);
    });

    it('still refuses a cash tender short by more than the rounding could explain', () => {
        expect(settles('0.03', [payment(CASH.id, '17.50')], HALF_UP_5C)).toBe(false);
        expect(settles('0.50', [payment(CASH.id, '17.00')], UP_5C)).toBe(false);
    });

    it('leaves non-cash methods on the strict test', () => {
        expect(settles('0.02', [payment(CARD.id, '17.50')], HALF_UP_5C)).toBe(false);
        expect(settles('0.05', [payment(CARD.id, '17.50')], UP_5C)).toBe(false);
        expect(settles('0.00', [payment(CARD.id, '17.52')], HALF_UP_5C)).toBe(true);
    });

    it('grants the tolerance on a split tender as soon as one line is cash', () => {
        expect(settles('0.02', [payment(CARD.id, '10.00'), payment(CASH.id, '7.50')], HALF_UP_5C)).toBe(true);
    });

    it('is the strict test when the register has no cash rounding', () => {
        expect(settles('0.02', [payment(CASH.id, '17.50')], null)).toBe(false);
        expect(settles('0.00', [payment(CASH.id, '17.52')], null)).toBe(true);
        expect(settles('-2.48', [payment(CASH.id, '20.00')], null)).toBe(true);
    });
});
