import type { OrderRow } from '@domain/types';
import { describe, expect, it } from 'vitest';

import {
    needsTipConfirmation,
    parseTip,
    settlementRows,
    settlementTotal,
    tipFromPercent,
    tipPercentOf,
} from './tip-entry';

/**
 * RST-123, RST-127 (BAN-522) — the number, before it becomes money.
 *
 * `tips.ts` already decides which tender a tip lands on and `setTip` applies it (RST-125). This is
 * the part in front of that: what a preset works out to, which amounts are worth a second look, and
 * which orders a manager still has to work through.
 *
 * The confirmation is the one that earns its place. A tip is entered on a **settled** sale, usually
 * read off a signed slip by someone who did not take the payment, so the realistic failure is a
 * decimal point rather than fraud — and a mistyped tip balances perfectly. The tender is topped up,
 * the order reconciles, and nothing looks wrong until the acquirer's statement arrives.
 */

function order(overrides: Partial<OrderRow>): OrderRow {
    return {
        uuid: 'order-1' as OrderRow['uuid'],
        state: 'paid',
        is_refund: false,
        is_tipped: false,
        amount_total: '20.00',
        tip_amount: '0',
        receipt_number: 'Bar/00012',
        name: null,
        floating_order_name: null,
        ...overrides,
    } as OrderRow;
}

describe('working out a preset', () => {
    it('takes the percentage of the bill', () => {
        expect(tipFromPercent('20.00', '15')).toBe('3.00');
        expect(tipFromPercent('20.00', '20')).toBe('4.00');
    });

    it('rounds to the money the till can actually take', () => {
        // 12.10 at 15 % is 1.815 — a third decimal place cannot be tendered or printed.
        expect(tipFromPercent('12.10', '15')).toBe('1.82');
    });

    it('is zero on a nil bill rather than an error', () => {
        expect(tipFromPercent('0.00', '20')).toBe('0.00');
    });
});

describe('reading a tip back as a percentage', () => {
    it('states the proportion', () => {
        expect(tipPercentOf('20.00', '4.00')).toBe('20.00');
    });

    it('is zero on a nil bill, because there is nothing to be a proportion of', () => {
        expect(tipPercentOf('0.00', '5.00')).toBe('0');
    });
});

describe('when a tip is worth confirming', () => {
    it('lets the presets through untouched', () => {
        for (const percent of ['15', '20', '25']) {
            expect(needsTipConfirmation('20.00', tipFromPercent('20.00', percent))).toBe(false);
        }
    });

    it('asks about anything above a quarter of the bill', () => {
        expect(needsTipConfirmation('20.00', '5.01')).toBe(true);
    });

    it('catches the misplaced decimal point, which is the realistic mistake', () => {
        // `18.00` typed into the field of a `12.10` bill. It balances, it reconciles, and nobody
        // finds out until the statement.
        expect(needsTipConfirmation('12.10', '18.00')).toBe(true);
    });

    it('does not ask about zero — taking a tip back off is not a large tip', () => {
        expect(needsTipConfirmation('20.00', '0')).toBe(false);
    });

    it('asks about any tip on a nil bill, which no percentage can speak for', () => {
        expect(needsTipConfirmation('0.00', '5.00')).toBe(true);
        expect(needsTipConfirmation('0.00', '0')).toBe(false);
    });

    it('is exactly at the boundary, not near it', () => {
        expect(needsTipConfirmation('20.00', '5.00')).toBe(false);
        expect(needsTipConfirmation('20.00', '5.01')).toBe(true);
    });
});

describe('reading what was typed', () => {
    it('takes an ordinary amount', () => {
        expect(parseTip('4.5')).toBe('4.50');
        expect(parseTip(' 4.50 ')).toBe('4.50');
    });

    it('takes a comma, because half the world types one', () => {
        expect(parseTip('4,50')).toBe('4.50');
    });

    it('refuses what is not an amount rather than guessing', () => {
        // `Decimal.of('abc')` would throw somewhere further along, on a settled order.
        expect(parseTip('abc')).toBeNull();
        expect(parseTip('')).toBeNull();
        expect(parseTip('-5')).toBeNull();
        expect(parseTip('4.567')).toBeNull();
    });

    it('takes a bare zero, which is how a tip is removed', () => {
        expect(parseTip('0')).toBe('0.00');
    });
});

describe('the settlement grid', () => {
    /**
     * The bill total is supplied rather than read off the row. `amount_total` is
     * server-authoritative and still `"0"` on anything that has not round-tripped — offline, on every
     * order — so a grid built from it would show a room full of nil bills and ask for confirmation on
     * every single tip (review of #75).
     */
    const totals = (): string => '20.00';

    it('lists the paid orders that still owe a tip', () => {
        const rows = settlementRows([
            order({ uuid: 'a' as OrderRow['uuid'] }),
            order({ uuid: 'b' as OrderRow['uuid'], state: 'draft' }),
            order({ uuid: 'c' as OrderRow['uuid'], is_tipped: true }),
        ], totals);

        expect(rows.map((row) => row.orderUuid)).toEqual(['a']);
    });

    it('leaves refunds out, because nobody tips a refund', () => {
        // A negative row in this grid is an invitation to type a number into it.
        expect(settlementRows([order({ uuid: 'r' as OrderRow['uuid'], is_refund: true })], totals)).toHaveLength(0);
    });

    it('labels a row with what is written on the slip', () => {
        expect(settlementRows([order({ floating_order_name: 'T 5' })], totals)[0]?.label).toBe('T 5');
        expect(settlementRows([order({ name: 'Bar/00012' })], totals)[0]?.label).toBe('Bar/00012');
        expect(settlementRows([order({})], totals)[0]?.label).toBe('Bar/00012');
    });

    it('takes the total from the computed figure, not the server column', () => {
        // The row's own `amount_total` is left at zero here, which is what a client-side order really
        // looks like before it syncs.
        const rows = settlementRows([order({ amount_total: '0' })], () => '31.40');

        expect(rows[0]?.total).toBe('31.40');
    });

    it('adds the pass up so it can be checked against the slips in hand', () => {
        expect(settlementTotal({ a: '3.00', b: '4.50', c: '' })).toBe('7.50');
    });

    it('ignores an unusable entry in the total rather than throwing mid-pass', () => {
        expect(settlementTotal({ a: '3.00', b: 'oops' })).toBe('3.00');
    });
});
