import { Decimal } from '@domain/money/decimal';
import { describe, expect, it } from 'vitest';

import { clampSplitAmount, evenSplitAmounts, isFullySplit, remainderAfter, tenderTargetFor } from './split-order';

/**
 * RST-104, RST-105 (BAN-487) — dividing a bill by money.
 *
 * The property that matters is not "each share is about a quarter". It is that **the shares sum to
 * the total, exactly, every time**: `10.00 / 3` rounded to the cent is `3.33`, and three of those is
 * `9.99`. A cent lost on every split table is a drawer that never reconciles, and it is invisible
 * until someone counts.
 *
 * So the sum is asserted for every case here, not just the tidy ones.
 */

function sum(parts: string[]): string {
    return parts.reduce((total, part) => total.add(part), Decimal.of('0')).toString();
}

describe('an even split', () => {
    it('divides a bill that halves cleanly', () => {
        expect(evenSplitAmounts('40.00', 4)).toEqual(['10.00', '10.00', '10.00', '10.00']);
    });

    it('sums to the total when the division does not come out evenly', () => {
        const shares = evenSplitAmounts('10.00', 3);

        expect(shares).toEqual(['3.34', '3.33', '3.33']);
        expect(sum(shares)).toBe('10.00');
    });

    it('gives the extra minor units to the earliest payers', () => {
        // Two cents to hand out across four. The guest who pays first absorbs it; loading it onto
        // the last would mean the person left holding the tab also pays the most.
        const shares = evenSplitAmounts('10.02', 4);

        expect(shares).toEqual(['2.51', '2.51', '2.50', '2.50']);
        expect(sum(shares)).toBe('10.02');
    });

    it('never spreads the shares by more than one minor unit', () => {
        for (const total of ['0.01', '0.07', '1.00', '9.99', '10.00', '33.33', '100.01', '1234.56']) {
            for (const parts of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13]) {
                const shares = evenSplitAmounts(total, parts);

                expect(sum(shares)).toBe(Decimal.of(total).toString());

                const values = shares.map((share) => Number(share));
                expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(0.011);
            }
        }
    });

    it('handles a total smaller than the number of guests', () => {
        // Three people splitting a 2-cent bill: two pay a cent, one pays nothing. Still exact.
        const shares = evenSplitAmounts('0.02', 3);

        expect(shares).toEqual(['0.01', '0.01', '0.00']);
        expect(sum(shares)).toBe('0.02');
    });

    it('gives one share back when the split is one way', () => {
        expect(evenSplitAmounts('12.34', 1)).toEqual(['12.34']);
    });

    it('splits a zero bill without inventing money', () => {
        expect(evenSplitAmounts('0.00', 3)).toEqual(['0.00', '0.00', '0.00']);
    });

    it('mirrors the rule for a negative total, which is a refund being split', () => {
        const shares = evenSplitAmounts('-10.00', 3);

        expect(shares).toEqual(['-3.34', '-3.33', '-3.33']);
        expect(sum(shares)).toBe('-10.00');
    });

    it('respects a currency with no minor unit', () => {
        // Yen. A "cent" here is a whole unit, and a 0.5 share would not be spendable.
        const shares = evenSplitAmounts('100', 3, 0);

        expect(shares).toEqual(['34', '33', '33']);
        expect(sum(shares)).toBe('100');
    });

    it('refuses a nonsensical number of ways rather than dividing by zero', () => {
        expect(() => evenSplitAmounts('10.00', 0)).toThrow(RangeError);
        expect(() => evenSplitAmounts('10.00', -2)).toThrow(RangeError);
        expect(() => evenSplitAmounts('10.00', 2.5)).toThrow(RangeError);
    });
});

describe('the remainder a split leaves', () => {
    it('is what is still owed', () => {
        expect(remainderAfter('40.00', '10.00')).toBe('30.00');
    });

    it('is zero, not negative, when the table has overpaid', () => {
        // An overpayment is change, not a negative bill. A negative remainder would make the
        // keep-splitting loop offer to collect money nobody owes.
        expect(remainderAfter('40.00', '45.00')).toBe('0.00');
    });

    it('reports a settled bill', () => {
        expect(isFullySplit(remainderAfter('40.00', '40.00'))).toBe(true);
        expect(isFullySplit(remainderAfter('40.00', '39.99'))).toBe(false);
    });
});

describe('clamping what a waiter types', () => {
    it('takes an amount the bill can absorb', () => {
        expect(clampSplitAmount('15.00', '40.00')).toBe('15.00');
    });

    it('caps at the outstanding balance rather than making change on a part-paid bill', () => {
        // Handing change out of the drawer against an order that is not finished would also make
        // the next guest's share come off a total already overpaid.
        expect(clampSplitAmount('50.00', '40.00')).toBe('40.00');
    });

    it('settles exactly when the typed amount is the balance', () => {
        expect(clampSplitAmount('40.00', '40.00')).toBe('40.00');
    });

    it('treats zero and negatives as nothing', () => {
        expect(clampSplitAmount('0.00', '40.00')).toBe('0.00');
        expect(clampSplitAmount('-5.00', '40.00')).toBe('0.00');
    });
});

/**
 * The share has to name its bill (review of #62).
 *
 * As a bare amount it was a global that outlived the split: take one guest's quarter, walk away to
 * another table without finishing, and the *next* order's payment screen pre-filled with a stale
 * share of a bill it had nothing to do with. A wrong tender on the wrong sale, and quiet about it.
 *
 * Clearing it on every exit was the alternative and it is the weaker one — it works only for the
 * exits somebody remembered to write.
 */
describe('which bill a share belongs to', () => {
    const SHARE = { orderUuid: 'order-a', amount: '10.00' };

    it('pre-fills the share on the bill it was taken against', () => {
        expect(tenderTargetFor('order-a', SHARE, '40.00')).toBe('10.00');
    });

    it('pre-fills the full balance on any other bill', () => {
        expect(tenderTargetFor('order-b', SHARE, '25.00')).toBe('25.00');
    });

    it('pre-fills the full balance when no split is running', () => {
        expect(tenderTargetFor('order-a', null, '25.00')).toBe('25.00');
    });

    it('never offers more than the bill still owes', () => {
        // Part-paid since the share was taken: €10 of a €6 balance would tender change against an
        // order that is not finished.
        expect(tenderTargetFor('order-a', SHARE, '6.00')).toBe('6.00');
    });
});
