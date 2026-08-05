import type { OrderRow, PaymentRow } from '@domain/types';
import { describe, expect, it } from 'vitest';

import type { OrderIndexRecord } from '../data/order-lookup';
import {
    canDeleteOrder,
    clampPageSize,
    mergeTicketRows,
    needsKitchenWithdrawal,
} from './ticket-rules';

/**
 * BAN-465 / REG-295 — the two things the delete button was missing.
 *
 * It was guarded on `state === 'draft'` plus the permission, which lets a cashier delete a draft
 * whose card payment the terminal has already captured. That erases the till's only record of money
 * that has moved: nothing is left to reconcile the settlement against, and nothing is left to refund
 * the customer from.
 */

/** Overrides are loose so a test can write `uuid: 'a'` without branding every literal. */
function order(overrides: Record<string, unknown> = {}): OrderRow {
    return {
        uuid: 'o1',
        state: 'draft',
        last_prep_sent_at: null,
        prep_state: 'none',
        updatedAtLocal: 0,
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

describe('mergeTicketRows', () => {
    const record = (uuid: string, updatedAt = '2026-08-05T10:00:00Z'): OrderIndexRecord => ({
        id: 1,
        uuid,
        name: `A/${uuid}`,
        receipt_number: `RC-${uuid}`,
        state: 'paid',
        amount_total: '10.00',
        ordered_at: updatedAt,
        updated_at: updatedAt,
    });

    it('renders a hydrated order as an order row', () => {
        const rows = mergeTicketRows([record('a')], { a: order({ uuid: 'a' }) }, []);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.kind).toBe('order');
    });

    it('keeps an index record whose body never arrived, as a stub', () => {
        // This is the whole point: dropping the row tells a cashier holding the receipt that the
        // order does not exist. The index already knows enough to show it honestly.
        const rows = mergeTicketRows([record('missing')], {}, []);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'stub', uuid: 'missing' });
    });

    it('promotes a stub to an order row once the body lands', () => {
        const records = [record('a')];

        expect(mergeTicketRows(records, {}, [])[0]?.kind).toBe('stub');
        expect(mergeTicketRows(records, { a: order({ uuid: 'a' }) }, [])[0]?.kind).toBe('order');
    });

    it('appends local unsynced orders the server cannot know about yet', () => {
        const rows = mergeTicketRows([record('a')], { a: order({ uuid: 'a' }) }, [order({ uuid: 'local' })]);

        expect(rows.map((row) => row.uuid).sort()).toEqual(['a', 'local']);
    });

    it('does not duplicate an order that is both in the page and locally unsynced', () => {
        const shared = order({ uuid: 'a' });
        const rows = mergeTicketRows([record('a')], { a: shared }, [shared]);

        expect(rows).toHaveLength(1);
    });

    it('sorts newest first across both shapes', () => {
        const rows = mergeTicketRows(
            [record('old', '2026-08-05T09:00:00Z'), record('new', '2026-08-05T11:00:00Z')],
            { old: order({ uuid: 'old', updatedAtLocal: Date.parse('2026-08-05T09:00:00Z') }) },
            [],
        );

        // 'new' is a stub and 'old' is hydrated, so this only holds if the sort spans both shapes.
        expect(rows.map((row) => row.uuid)).toEqual(['new', 'old']);
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
