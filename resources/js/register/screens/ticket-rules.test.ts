import type { OrderRow, PaymentRow } from '@domain/types';
import { describe, expect, it } from 'vitest';

import { canDeleteOrder, clampPageSize, needsKitchenWithdrawal } from './ticket-rules';

/**
 * BAN-465 / REG-295 — the two things the delete button was missing.
 *
 * It was guarded on `state === 'draft'` plus the permission, which lets a cashier delete a draft
 * whose card payment the terminal has already captured. That erases the till's only record of money
 * that has moved: nothing is left to reconcile the settlement against, and nothing is left to refund
 * the customer from.
 */

function order(overrides: Partial<OrderRow> = {}): OrderRow {
    return {
        uuid: 'o1',
        state: 'draft',
        last_prep_sent_at: null,
        prep_state: 'none',
        ...overrides,
    } as OrderRow;
}

function payment(overrides: Partial<PaymentRow> = {}): PaymentRow {
    return {
        uuid: 'p1',
        payment_method_id: 1,
        payment_status: 'done',
        is_change: false,
        ...overrides,
    } as PaymentRow;
}

/** Method 2 is the card terminal; method 1 is cash. */
const isElectronic = (id: number): boolean => id === 2;

describe('canDeleteOrder', () => {
    it('allows deleting an untouched draft', () => {
        expect(canDeleteOrder(order(), [], { isElectronic })).toBe(true);
    });

    it('refuses when a card payment has been captured', () => {
        const payments = [payment({ payment_method_id: 2, payment_status: 'done' })];

        expect(canDeleteOrder(order(), payments, { isElectronic })).toBe(false);
    });

    it('refuses when a card payment is merely authorized', () => {
        // The money is ringfenced on the customer's card either way; only the capture is pending.
        const payments = [payment({ payment_method_id: 2, payment_status: 'authorized' })];

        expect(canDeleteOrder(order(), payments, { isElectronic })).toBe(false);
    });

    it('allows deleting when the electronic payment failed or was reversed', () => {
        for (const status of ['failed', 'cancelled', 'reversed', 'pending'] as const) {
            const payments = [payment({ payment_method_id: 2, payment_status: status })];

            expect(canDeleteOrder(order(), payments, { isElectronic })).toBe(true);
        }
    });

    it('allows deleting with a cash payment — the notes are still in the drawer', () => {
        const payments = [payment({ payment_method_id: 1, payment_status: 'done' })];

        expect(canDeleteOrder(order(), payments, { isElectronic })).toBe(true);
    });

    it('ignores change lines', () => {
        // Change is money going the other way; it is not a capture to protect.
        const payments = [payment({ payment_method_id: 2, payment_status: 'done', is_change: true })];

        expect(canDeleteOrder(order(), payments, { isElectronic })).toBe(true);
    });

    it('refuses anything that is no longer a draft', () => {
        expect(canDeleteOrder(order({ state: 'paid' }), [], { isElectronic })).toBe(false);
        expect(canDeleteOrder(null, [], { isElectronic })).toBe(false);
    });
});

describe('needsKitchenWithdrawal', () => {
    it('is false for a draft nobody fired', () => {
        expect(needsKitchenWithdrawal(order())).toBe(false);
    });

    it('is true once anything reached the pass', () => {
        expect(needsKitchenWithdrawal(order({ last_prep_sent_at: '2026-08-05T10:00:00Z' }))).toBe(true);
        expect(needsKitchenWithdrawal(order({ prep_state: 'sent' }))).toBe(true);
    });
});

describe('clampPageSize', () => {
    it('snaps to the nearest offered size', () => {
        expect(clampPageSize(50)).toBe(50);
        expect(clampPageSize(30)).toBe(25);
        expect(clampPageSize(10_000)).toBe(200);
    });

    it('falls back rather than producing NaN', () => {
        expect(clampPageSize(Number.NaN)).toBe(50);
    });
});
