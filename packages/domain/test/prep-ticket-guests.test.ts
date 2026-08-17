import { describe, expect, it } from 'vitest';

import { buildBillDoc, buildPrepTicketDoc } from '../src/receipt/build';
import { toPlainText } from '../src/escpos/serializer';
import { DEFAULT_LABELS } from '../src/receipt/types';
import type { PrepTicketView, ReceiptConfigView } from '../src/receipt/types';

/**
 * RST-073 (BAN-481) — the cover count on the ticket the kitchen reads.
 *
 * The *receipt* has carried guests since it was written, and the payment screen shows a per-guest
 * hint. The prep ticket — the only one of the three a chef ever holds — carried nothing, so a table
 * of eight and a table of two printed identically and the pass had to ask the floor.
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
    portalUrl: null,
    openDrawer: false,
    portalDisplay: 'none',
    currency: {
        symbol: '€',
        position: 'after',
        decimalPlaces: 2,
        decimalSeparator: ',',
        thousandsSeparator: ' ',
    },
    labels: DEFAULT_LABELS,
} as ReceiptConfigView;

function ticket(overrides: Partial<PrepTicketView> = {}): string {
    const view: PrepTicketView = {
        orderUuid: 'order-1',
        orderName: 'Bar/00012',
        trackingNumber: '012',
        tableName: 'T4',
        presetName: 'Dine in',
        guests: 4,
        cashierName: 'Amina B.',
        firedAt: '2026-08-17T18:30:00.000Z',
        courseName: null,
        generalNote: null,
        lines: [{ name: 'Pasta', quantity: 2, change: 'new' }],
        ...overrides,
    };

    return toPlainText(buildPrepTicketDoc(view, CONFIG));
}

describe('the guest count on a prep ticket', () => {
    it('prints the covers so the pass can plate the table', () => {
        const text = ticket({ guests: 8 });

        expect(text).toContain(DEFAULT_LABELS.guests);
        expect(text).toContain('8');
    });

    it('prints nothing when the count is unknown', () => {
        // A takeaway has no covers. A `Guests` row with nothing useful next to it is noise on a
        // ticket that is read at a glance in a hot kitchen.
        expect(ticket({ guests: null })).not.toContain(DEFAULT_LABELS.guests);
    });

    it('treats zero the same as unknown', () => {
        // `guest_count` defaults to 0 on every order, so a falsy check is not enough — printing
        // "Guests 0" would be the *common* case rather than the edge one.
        expect(ticket({ guests: 0 })).not.toContain(DEFAULT_LABELS.guests);
    });

    it('keeps the covers above the cashier', () => {
        // Ordering is deliberate: the number changes how the plate is made up, and the cashier's
        // name does not.
        const text = ticket({ guests: 6, cashierName: 'Amina B.' });

        expect(text.indexOf(DEFAULT_LABELS.guests)).toBeLessThan(text.indexOf(DEFAULT_LABELS.cashier));
    });

    it('still prints the rest of the ticket when there are no covers', () => {
        const text = ticket({ guests: null });

        expect(text).toContain('Pasta');
        expect(text).toContain('T4');
    });
});

/**
 * RST-111 (BAN-487) — suggested gratuity on the proforma.
 *
 * The bill is the paper the customer is holding when they decide, so the suggestion has to be on
 * *that*, not on the receipt they get afterwards. Computed on the printed total so the arithmetic a
 * guest can check by hand agrees with the paper.
 */
describe('gratuity on the proforma', () => {
    function bill(gratuity: readonly number[]): string {
        const order = {
            uuid: 'o-1',
            name: 'Bar/00012',
            reference: 'Bar/00012',
            trackingNumber: null,
            orderedAt: '2026-08-17T18:30:00.000Z',
            cashierName: null,
            customerName: null,
            customerVat: null,
            tableName: 'T4',
            guestCount: 4,
            presetName: null,
            presetTime: null,
            lines: [],
            taxes: [],
            payments: [],
            amountTotal: '40.00',
            amountUntaxed: '40.00',
            amountTax: '0.00',
            amountRounding: '0.00',
            amountDiscount: '0.00',
            amountPaid: '0.00',
            amountChange: '0.00',
            generalNote: null,
            isRefund: false,
            refundedOrderName: null,
            copy: 1,
        } as unknown as Parameters<typeof buildBillDoc>[0];

        return toPlainText(buildBillDoc(order, CONFIG, gratuity));
    }

    it('prints nothing at all unless a venue asks for it', () => {
        // A tip line is a cultural default, not a universal one. Printed where tipping is not
        // customary it reads as a demand, so the empty list is the default.
        expect(bill([])).not.toContain(DEFAULT_LABELS.gratuity);
    });

    it('prints the total including each suggested percentage', () => {
        const text = bill([10, 15]);

        expect(text).toContain(DEFAULT_LABELS.gratuity);
        // 40.00 + 10 % = 44.00, + 15 % = 46.00 — the figure the guest would actually pay, not the
        // tip in isolation, which is the number they have to do arithmetic on.
        expect(text).toContain('44');
        expect(text).toContain('46');
    });
});
