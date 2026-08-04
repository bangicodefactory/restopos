import { describe, expect, it } from 'vitest';

import { quickAmountsFor } from './PaymentScreen';

/**
 * REG-205 — the quick-tender keys come from the currency's configured note denominations when it
 * has them, so the cashier can tap the note the customer actually handed over.
 */
describe('quickAmountsFor', () => {
    const bills = [{ value: '20' }, { value: '50' }, { value: '100' }, { value: '200' }, { value: '10' }];

    it('offers the exact due and the notes that can cover it, cheapest first', () => {
        expect(quickAmountsFor('17.50', bills)).toEqual(['17.50', '20.00', '50.00', '100.00']);
    });

    it('drops notes smaller than the due', () => {
        // A €70 due excludes the €20 and €50 notes.
        expect(quickAmountsFor('70.00', bills)).toEqual(['70.00', '100.00', '200.00']);
    });

    it('dedupes a note that equals the due exactly', () => {
        expect(quickAmountsFor('20.00', bills)).toEqual(['20.00', '50.00', '100.00', '200.00']);
    });

    it('falls back to the arithmetic ladder when no bills are configured', () => {
        expect(quickAmountsFor('17.50', [])).toEqual(['17.50', '20.00', '30.00', '40.00']);
    });
});
