import { describe, expect, it } from 'vitest';

import { toPlainText } from '../src/escpos/serializer';
import { buildTipSlipDoc } from '../src/receipt/build';
import { DEFAULT_LABELS } from '../src/receipt/types';
import type { ReceiptConfigView, ReceiptOrderView } from '../src/receipt/types';

/**
 * RST-124 (BAN-522) — the slip the customer writes the tip on.
 *
 * Not a receipt, and the differences are the point. A tip line with a value printed in it cannot be
 * written on; a slip that looks like the customer's copy leaves the building with the only record of
 * the tip on it; and a slip that does not state what was already charged leaves the figure being
 * tipped on open to argument later.
 */

const CONFIG: ReceiptConfigView = {
    width: 42,
    codepage: 'cp858',
    companyName: 'Trattoria Test',
    companyAddress: [],
    companyPhone: null,
    companyVat: null,
    header: null,
    footer: null,
    logoKey: null,
    taxIncluded: true,
    portalUrl: 'https://example.test/o/abc',
    openDrawer: false,
    portalDisplay: 'qr_code',
    currency: {
        symbol: '€',
        position: 'after',
        decimalPlaces: 2,
        decimalSeparator: ',',
        thousandsSeparator: ' ',
    },
    labels: DEFAULT_LABELS,
} as ReceiptConfigView;

function order(overrides: Partial<ReceiptOrderView> = {}): ReceiptOrderView {
    return {
        uuid: 'order-1',
        name: 'Bar/00012',
        reference: 'Bar/00012',
        trackingNumber: '012',
        orderedAt: '2026-08-17T18:30:00.000Z',
        cashierName: 'Amina B.',
        customerName: null,
        customerVat: null,
        tableName: 'T4',
        guestCount: 4,
        presetName: null,
        presetTime: null,
        lines: [{ name: 'Pasta', quantity: 2, unitPrice: '10.00', lineTotal: '20.00' }],
        taxes: [],
        payments: [],
        amountUntaxed: '20.00',
        amountTax: '0.00',
        amountTotal: '20.00',
        amountRounding: '0.00',
        amountPaid: '20.00',
        amountChange: '0.00',
        amountDiscount: '0.00',
        ...overrides,
    } as unknown as ReceiptOrderView;
}

function slip(overrides: Partial<ReceiptOrderView> = {}): string {
    return toPlainText(buildTipSlipDoc(order(overrides), CONFIG));
}

/** The printed line carrying `label` — the whole line, so what sits opposite it can be checked. */
function lineWith(label: string, text = slip()): string {
    return text.split('\n').find((line) => line.includes(label)) ?? '';
}

describe('what the slip carries', () => {
    it('states what was already charged', () => {
        // The one figure that must not be a blank: the tip is written on top of it, and afterwards
        // this is what says which number was being tipped on.
        expect(slip()).toContain('20,00');
    });

    it('names the venue, the order and when', () => {
        const text = slip();

        expect(text).toContain('Trattoria Test');
        expect(text).toContain('Bar/00012');
    });

    it('carries the table and the cashier, which is how it is matched back to a slip', () => {
        const text = slip();

        expect(text).toContain('T4');
        expect(text).toContain('Amina B.');
    });

    it('marks itself the merchant copy', () => {
        // A slip that could be mistaken for the customer's copy walks out of the door with the only
        // written record of the tip on it.
        expect(slip()).toContain(DEFAULT_LABELS.merchantCopy);
    });
});

describe('what the slip leaves blank', () => {
    it('rules a line for the tip rather than printing a figure in it', () => {
        // Asserted on the tip line itself, not on the slip as a whole. `toContain('____')` passes
        // while the tip row carries a printed amount, because the *total* row below it is blank —
        // a sabotage that filled this row in cleared the test (review of #75).
        const line = lineWith(DEFAULT_LABELS.tipLine);

        expect(line).toContain('____');
        expect(line).not.toContain('20,00');
    });

    it('rules a line for the new total', () => {
        const line = lineWith(DEFAULT_LABELS.tipTotalLine);

        expect(line).toContain('____');
        expect(line).not.toContain('20,00');
    });

    it('leaves somewhere to sign', () => {
        expect(slip()).toContain(DEFAULT_LABELS.signature);
    });
});

describe('what the slip is not', () => {
    it('prints no line table — this is not a second receipt', () => {
        expect(slip()).not.toContain('Pasta');
    });

    it('prints no portal QR, even where the receipt would', () => {
        // `portalDisplay: 'qr_code'` is set on the config above, so this is the builder's own decision
        // rather than an absent setting.
        expect(slip()).not.toContain('example.test');
    });

    it('is labelled as a tip slip, so a printer binding can tell it apart', () => {
        expect(buildTipSlipDoc(order(), CONFIG).meta.kind).toBe('tip_slip');
    });
});
