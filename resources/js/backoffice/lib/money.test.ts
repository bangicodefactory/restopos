import type { CurrencyFormat } from '@domain/receipt/index';
import { describe, expect, it } from 'vitest';

import {
    EUR,
    currencyFor,
    money,
    percent,
    quantity,
    ratio,
    registerCurrency,
    signOf,
    subtractMoney,
    sumMoney,
    toDecimal,
} from './money';

/**
 * Unit coverage for the back-office money formatter.
 *
 * The rule being defended is the one from docs/CONVENTIONS.md: a monetary value from the server is
 * a decimal string and must never become a JS number. Every expectation below is therefore an
 * explicit string.
 */

const USD: CurrencyFormat = {
    symbol: '$',
    position: 'before',
    decimalPlaces: 2,
    decimalSeparator: '.',
    thousandsSeparator: ',',
};

describe('toDecimal', () => {
    it.each([
        { input: '24.2000', expected: '24.2000' },
        { input: '  10.50  ', expected: '10.50' },
        { input: 1234.5, expected: '1234.5' },
        { input: 0, expected: '0' },
    ])('parses $input', ({ input, expected }) => {
        expect(toDecimal(input).toString()).toBe(expected);
    });

    it.each([null, undefined, '', '   ', '-', 'abc', Number.NaN, Number.POSITIVE_INFINITY])(
        'never throws on %o — a deferred prop must not break a render',
        (input) => {
            expect(toDecimal(input as string).toString()).toBe('0');
        },
    );

    it('expands exponent notation rather than refusing it', () => {
        expect(toDecimal(1e-7).isZero()).toBe(false);
        expect(money(1e-7)).toBe('0,00 €');
    });
});

describe('money', () => {
    it.each([
        { input: '1234.5', expected: '1 234,50 €' },
        { input: '0', expected: '0,00 €' },
        { input: '-12.3456', expected: '-12,35 €' },
        { input: '24.2000', expected: '24,20 €' },
        { input: '1234567.89', expected: '1 234 567,89 €' },
        { input: null, expected: '0,00 €' },
    ])('formats $input in the venue default', ({ input, expected }) => {
        expect(money(input)).toBe(expected);
    });

    it('preserves the exact cents of a long decimal(16,4) string', () => {
        // The float route (`Number('0.145').toFixed(2)`) is what this exists to avoid.
        expect(money('0.145')).toBe('0,15 €');
        expect(money('0.144')).toBe('0,14 €');
    });

    it('honours another currency format', () => {
        expect(money('1234.5', USD)).toBe('$1,234.50');
    });

    it('can drop the symbol for table cells that carry it in the header', () => {
        expect(money('1234.5', EUR, false)).toBe('1 234,50');
    });
});

describe('currency registry', () => {
    it('falls back to the venue default for an unknown or missing id', () => {
        expect(currencyFor(null)).toBe(EUR);
        expect(currencyFor(undefined)).toBe(EUR);
        expect(currencyFor(9999)).toBe(EUR);
    });

    it('returns a registered currency once it is known', () => {
        registerCurrency(840, USD);
        expect(currencyFor(840)).toBe(USD);
        expect(money('1234.5', currencyFor(840))).toBe('$1,234.50');
    });
});

describe('arithmetic on strings', () => {
    it('sums without ever touching a float', () => {
        expect(sumMoney(['0.1', '0.2'])).toBe('0.3');
        expect(sumMoney(['1.10', '2.20', null, 3])).toBe('6.30');
        expect(sumMoney([])).toBe('0');
    });

    it('subtracts', () => {
        expect(subtractMoney('10.00', '2.50')).toBe('7.50');
        expect(subtractMoney('2.50', '10.00')).toBe('-7.50');
        expect(subtractMoney(null, '1.00')).toBe('-1.00');
    });

    it.each([
        { input: '-1.00', expected: -1 },
        { input: '0.0000', expected: 0 },
        { input: '0.0001', expected: 1 },
        { input: null, expected: 0 },
    ])('signOf($input) → $expected', ({ input, expected }) => {
        expect(signOf(input)).toBe(expected);
    });
});

describe('quantity', () => {
    it.each([
        { input: '2.000', expected: '2' },
        { input: '1.500', expected: '1.5' },
        { input: '10', expected: '10' },
        { input: '100', expected: '100' },
        { input: '0', expected: '0' },
        { input: '0.3255', expected: '0.326' },
        { input: '-1.250', expected: '-1.25' },
        { input: null, expected: '0' },
    ])('$input → $expected', ({ input, expected }) => {
        expect(quantity(input)).toBe(expected);
    });

    it('honours a tighter maximum', () => {
        expect(quantity('1.256', 1)).toBe('1.3');
    });
});

describe('percent', () => {
    it.each([
        { input: '12.5000', expected: '12,5 %' },
        { input: '20', expected: '20 %' },
        { input: '0', expected: '0 %' },
        { input: '7.755', expected: '7,76 %' },
        { input: null, expected: '0 %' },
    ])('$input → $expected', ({ input, expected }) => {
        expect(percent(input)).toBe(expected);
    });
});

describe('ratio', () => {
    it('is zero when the denominator is zero, rather than Infinity or NaN', () => {
        expect(ratio('50', '0')).toBe(0);
        expect(ratio('50', null)).toBe(0);
    });

    it('returns a 0–100 percentage as documented', () => {
        expect(ratio('50', '200')).toBe(25);
        expect(ratio('200', '200')).toBe(100);
    });
});
