import { Decimal } from '@domain/money/decimal';
import { epsilonForDigits, isZeroAtPrecision, stepForDigits } from '@domain/money/precision';
import { CashRoundingCalculator, fullyPaidTolerance, isFullyPaid } from '@domain/tax/rounder';
import { describe, expect, it } from 'vitest';

/**
 * REG-176 / REG-202 / REG-177 — the cash-rounding fully-paid tolerance.
 *
 * The bug this pins down: with cash rounding on, "fully paid" was a raw `due > 0` sign test, so an
 * order the receipt says costs 17.50 could not be settled by tendering 17.50 whenever the rounding
 * method moved the total away from the raw figure. The tolerance below is what closes it.
 */

const FIVE_CENTS = '0.05';

describe('fullyPaidTolerance', () => {
    it('is half a step under HALF-UP — the most the total can have moved', () => {
        expect(fullyPaidTolerance(FIVE_CENTS, 'half_up').toString()).toBe('0.025');
        expect(fullyPaidTolerance('0.01', 'half_up').toString()).toBe('0.005');
        expect(fullyPaidTolerance('0.5', 'half_up').toString()).toBe('0.25');
    });

    it('is a full step under a directional method', () => {
        expect(fullyPaidTolerance(FIVE_CENTS, 'up').eq(FIVE_CENTS)).toBe(true);
        expect(fullyPaidTolerance(FIVE_CENTS, 'down').eq(FIVE_CENTS)).toBe(true);
        expect(fullyPaidTolerance(FIVE_CENTS, 'half_down').eq(FIVE_CENTS)).toBe(true);
        expect(fullyPaidTolerance(FIVE_CENTS, 'half_even').eq(FIVE_CENTS)).toBe(true);
    });

    it('is zero when no cash rounding is configured', () => {
        expect(fullyPaidTolerance(null).isZero()).toBe(true);
        expect(fullyPaidTolerance(undefined).isZero()).toBe(true);
        expect(fullyPaidTolerance('0', 'up').isZero()).toBe(true);
    });
});

describe('isFullyPaid — HALF-UP', () => {
    const paid = (due: string): boolean => isFullyPaid(due, FIVE_CENTS, 'half_up');

    it('accepts the positive boundary and rejects anything past it', () => {
        expect(paid('0.025')).toBe(true);
        expect(paid('0.026')).toBe(false);
        expect(paid('0.03')).toBe(false);
        expect(paid('0.05')).toBe(false);
    });

    it('accepts the negative boundary and every overpayment beyond it', () => {
        expect(paid('-0.025')).toBe(true);
        expect(paid('-0.026')).toBe(true);
        expect(paid('-5.00')).toBe(true);
    });

    it('accepts exact settlement and rejects a whole order', () => {
        expect(paid('0')).toBe(true);
        expect(paid('0.00')).toBe(true);
        expect(paid('17.50')).toBe(false);
    });
});

describe('isFullyPaid — directional (non HALF-UP)', () => {
    const paid = (due: string): boolean => isFullyPaid(due, FIVE_CENTS, 'up');

    it('accepts the positive boundary at a full step and rejects anything past it', () => {
        expect(paid('0.05')).toBe(true);
        expect(paid('0.051')).toBe(false);
        expect(paid('0.06')).toBe(false);
    });

    it('accepts the negative boundary and every overpayment beyond it', () => {
        expect(paid('-0.05')).toBe(true);
        expect(paid('-0.051')).toBe(true);
        expect(paid('-12.00')).toBe(true);
    });

    it('is wider than the HALF-UP band by exactly half a step', () => {
        expect(isFullyPaid('0.04', FIVE_CENTS, 'up')).toBe(true);
        expect(isFullyPaid('0.04', FIVE_CENTS, 'half_up')).toBe(false);
    });
});

describe('isFullyPaid — no cash rounding', () => {
    it('collapses to the strict sign test the register had before', () => {
        for (const due of ['0.01', '0.001', '0.05']) {
            expect(isFullyPaid(due)).toBe(false);
            expect(isFullyPaid(due)).toBe(!(Decimal.of(due).signum() > 0));
        }
        for (const due of ['0', '-0.01', '-5.00']) {
            expect(isFullyPaid(due)).toBe(true);
            expect(isFullyPaid(due)).toBe(!(Decimal.of(due).signum() > 0));
        }
    });
});

describe('settling a rounded order end to end', () => {
    /** What the payment screen does: due = roundedTotal − tendered. */
    const dueAfter = (rawTotal: string, tendered: string, method: 'half_up' | 'up' | 'down'): Decimal => {
        const rounded = new CashRoundingCalculator({ rounding: FIVE_CENTS, method }).apply(
            Decimal.of(rawTotal),
        ).roundedTotal;
        return rounded.sub(tendered);
    };

    it('a raw due of 17.52 is settled by tendering the rounded 17.50, whatever the method', () => {
        expect(isFullyPaid(dueAfter('17.52', '17.50', 'half_up'), FIVE_CENTS, 'half_up')).toBe(true);
        expect(isFullyPaid(dueAfter('17.52', '17.50', 'down'), FIVE_CENTS, 'down')).toBe(true);
        // `up` rounds 17.52 to 17.55; the 5-cent short-fall is exactly one step, so it still settles.
        expect(isFullyPaid(dueAfter('17.52', '17.50', 'up'), FIVE_CENTS, 'up')).toBe(true);
    });

    it('a rounded total of 12.35 is settled by tendering 12.35', () => {
        expect(isFullyPaid(dueAfter('12.34', '12.35', 'half_up'), FIVE_CENTS, 'half_up')).toBe(true);
        expect(dueAfter('12.34', '12.35', 'half_up').toString()).toBe('0.00');
    });

    it('still refuses a tender that is short by more than the rounding could explain', () => {
        expect(isFullyPaid(dueAfter('17.52', '17.00', 'half_up'), FIVE_CENTS, 'half_up')).toBe(false);
        expect(isFullyPaid(dueAfter('17.52', '17.40', 'up'), FIVE_CENTS, 'up')).toBe(false);
    });
});

describe('precision-aware zero (REG-177)', () => {
    it('derives the step and the epsilon from the digit count', () => {
        expect(stepForDigits(3).toString()).toBe('0.001');
        expect(stepForDigits(0).toString()).toBe('1');
        expect(epsilonForDigits(2).toString()).toBe('0.005');
    });

    it('treats a residue below half a unit in the last place as zero', () => {
        expect(isZeroAtPrecision('0.0001', 2)).toBe(true);
        expect(isZeroAtPrecision('-0.0001', 2)).toBe(true);
        expect(isZeroAtPrecision('0.005', 2)).toBe(false);
        expect(isZeroAtPrecision('0.01', 2)).toBe(false);
        expect(isZeroAtPrecision('0.0004', 3)).toBe(true);
        expect(isZeroAtPrecision('0.0005', 3)).toBe(false);
    });
});
