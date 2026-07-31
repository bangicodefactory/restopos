import { describe, expect, it } from 'vitest';

import { Decimal, MAX_SCALE } from '../src/money/decimal';
import { DOWN, HALF_DOWN, HALF_EVEN, HALF_UP, UP } from '../src/money/rounding';

/** Unit coverage for docs/spec/04-tax-engine.md §2 and §3. */

describe('Decimal parsing and rendering (§1.2, §2.1.4)', () => {
    it('round-trips decimal strings preserving scale', () => {
        for (const v of ['0', '-0.05', '12.1000', '1.5', '999999999999.999999999999']) {
            expect(Decimal.of(v).toString()).toBe(v);
        }
    });

    it('normalises negative zero (§2.1.2)', () => {
        expect(Decimal.of('-0.00').toString()).toBe('0.00');
        expect(Decimal.of('0').sub('0').signum()).toBe(0);
    });

    it('rejects anything that is not a plain decimal string', () => {
        for (const v of ['1e3', '+1', '.5', '1.', '', 'abc', '1,5', 'Infinity', 'NaN']) {
            expect(() => Decimal.of(v)).toThrow();
        }
    });
});

describe('arithmetic (§2.2)', () => {
    it('adds and subtracts exactly at max(scale)', () => {
        expect(Decimal.of('0.1').add('0.2').toString()).toBe('0.3');
        expect(Decimal.of('1.005').sub('1').toString()).toBe('0.005');
        expect(Decimal.of('10').sub('10.0000').toString()).toBe('0.0000');
    });

    it('multiplies exactly and clamps to MAX_SCALE (§2.2.3)', () => {
        expect(Decimal.of('1.11').mul('2.22').toString()).toBe('2.4642');
        const wide = Decimal.of('0.0000001').mul('0.0000001');
        expect(wide.scale).toBe(MAX_SCALE);
        expect(wide.toString()).toBe('0.000000000000');
    });

    it('compares by value, not by scale (§2.2.6)', () => {
        expect(Decimal.of('1.50').eq('1.5')).toBe(true);
        expect(Decimal.of('-1.50').lt('-1.4')).toBe(true);
    });

    it('throws on division by zero', () => {
        expect(() => Decimal.of('1').div('0')).toThrow();
    });
});

describe('rounding modes (§3.1, §3.2)', () => {
    const cases: [string, string, string, string, string, string][] = [
        // value    half_up  half_down half_even up      down
        ['2.5', '3', '2', '2', '3', '2'],
        ['-2.5', '-3', '-2', '-2', '-3', '-2'],
        ['3.5', '4', '3', '4', '4', '3'],
        ['2.1', '2', '2', '2', '3', '2'],
        ['-2.1', '-2', '-2', '-2', '-3', '-2'],
        ['2.0', '2', '2', '2', '2', '2'],
    ];

    it.each(cases)('rounds %s symmetrically about zero', (v, hu, hd, he, up, down) => {
        expect(Decimal.of(v).withScale(0, HALF_UP).toString()).toBe(hu);
        expect(Decimal.of(v).withScale(0, HALF_DOWN).toString()).toBe(hd);
        expect(Decimal.of(v).withScale(0, HALF_EVEN).toString()).toBe(he);
        expect(Decimal.of(v).withScale(0, UP).toString()).toBe(up);
        expect(Decimal.of(v).withScale(0, DOWN).toString()).toBe(down);
    });

    it('rounds a refund as the exact mirror of the sale (§3.1, §7.3)', () => {
        expect(Decimal.of('-0.125').roundToStep('0.01', HALF_UP).toString()).toBe('-0.13');
        expect(Decimal.of('0.125').roundToStep('0.01', HALF_UP).toString()).toBe('0.13');
    });
});

describe('roundToStep (§3.3.2)', () => {
    it('snaps to a 0.05 step', () => {
        expect(Decimal.of('12.32').roundToStep('0.05', HALF_UP).toString()).toBe('12.30');
        expect(Decimal.of('12.32').roundToStep('0.05', UP).toString()).toBe('12.35');
        expect(Decimal.of('12.32').roundToStep('0.05', DOWN).toString()).toBe('12.30');
        expect(Decimal.of('12.325').roundToStep('0.05', HALF_UP).toString()).toBe('12.35');
    });

    it('snaps to a 0.001 step and keeps the step scale', () => {
        expect(Decimal.of('3.7035').roundToStep('0.001', HALF_UP).toString()).toBe('3.704');
    });

    it('is a no-op for a zero step', () => {
        expect(Decimal.of('1.2345').roundToStep('0', HALF_UP).toString()).toBe('1.2345');
    });
});
