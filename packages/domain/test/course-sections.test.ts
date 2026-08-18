import { describe, expect, it } from 'vitest';

import { toPlainText } from '../src/escpos/serializer';
import { buildBillDoc, buildPrepTicketDoc } from '../src/receipt/build';
import { DEFAULT_LABELS } from '../src/receipt/types';
import type { PrepTicketView, ReceiptConfigView, ReceiptLineView, ReceiptOrderView } from '../src/receipt/types';

/**
 * RST-088 (BAN-477) — course headings on the two documents that leave the till.
 *
 * The kitchen ticket is the whole point: it is what tells the pass which lines to start and which to
 * hold back, and it printed a flat list. The bill matters for the same reason from the other side —
 * a guest querying a course they never received cannot find it on a receipt that does not mention
 * courses at all.
 *
 * The rule worth pinning is the *negative* one. A heading is printed only where the course changes,
 * and never on an order with a single course: "Service 1" above every line a one-course ticket
 * already lists makes the ticket longer without making it clearer, and these are read at a glance in
 * a hot kitchen.
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

function line(name: string, courseName: string | null): ReceiptLineView {
    return { name, quantity: 1, unitPrice: '10.00', lineTotal: '10.00', courseName };
}

function bill(lines: ReceiptLineView[]): string {
    const view = {
        uuid: 'order-1',
        name: 'T4',
        reference: 'Bar/00012',
        trackingNumber: null,
        orderedAt: '2026-08-17T18:30:00.000Z',
        cashierName: null,
        customerName: null,
        customerVat: null,
        tableName: 'T4',
        guestCount: null,
        presetName: null,
        presetTime: null,
        lines,
        taxes: [],
        payments: [],
        amountUntaxed: '10.00',
        amountTax: '0.00',
        amountTotal: '10.00',
        amountRounding: '0.00',
        amountPaid: '10.00',
        amountChange: '0.00',
        amountDiscount: '0.00',
    } as unknown as ReceiptOrderView;

    return toPlainText(buildBillDoc(view, CONFIG));
}

function ticket(lines: PrepTicketView['lines']): string {
    const view: PrepTicketView = {
        orderUuid: 'order-1',
        orderName: 'Bar/00012',
        trackingNumber: '012',
        tableName: 'T4',
        presetName: 'Dine in',
        guests: 4,
        cashierName: null,
        firedAt: '2026-08-17T18:30:00.000Z',
        courseName: null,
        generalNote: null,
        lines,
    };

    return toPlainText(buildPrepTicketDoc(view, CONFIG));
}

describe('the bill', () => {
    it('heads each course with its lines beneath', () => {
        const text = bill([line('Bruschetta', 'Starters'), line('Sea bass', 'Mains')]);

        expect(text).toContain('Starters');
        expect(text).toContain('Mains');
        expect(text.indexOf('Starters')).toBeLessThan(text.indexOf('Bruschetta'));
        expect(text.indexOf('Bruschetta')).toBeLessThan(text.indexOf('Mains'));
    });

    it('prints one heading per course, not one per line', () => {
        const text = bill([
            line('Bruschetta', 'Starters'),
            line('Olives', 'Starters'),
            line('Sea bass', 'Mains'),
        ]);

        expect(text.split('Starters')).toHaveLength(2);
    });

    it('prints no heading at all when the bill has one course', () => {
        expect(bill([line('Bruschetta', 'Starters'), line('Olives', 'Starters')])).not.toContain('Starters');
    });

    it('prints no heading on an order with no courses', () => {
        const text = bill([line('Bruschetta', null), line('Olives', null)]);

        expect(text).toContain('Bruschetta');
        expect(text).not.toContain(DEFAULT_LABELS.course);
    });
});

describe('the kitchen ticket', () => {
    it('heads each course, which is what tells the pass what to hold back', () => {
        const text = ticket([
            { name: 'Bruschetta', quantity: 2, change: 'new', courseName: 'Starters' },
            { name: 'Sea bass', quantity: 1, change: 'new', courseName: 'Mains' },
        ]);

        expect(text).toContain('Starters');
        expect(text).toContain('Mains');
        expect(text.indexOf('Starters')).toBeLessThan(text.indexOf('Bruschetta'));
    });

    it('prints no heading on a single-course ticket', () => {
        const text = ticket([{ name: 'Bruschetta', quantity: 2, change: 'new', courseName: 'Starters' }]);

        expect(text).toContain('Bruschetta');
        expect(text).not.toContain('-- Starters --');
    });

    it('ignores unchanged lines when deciding whether the ticket spans courses', () => {
        // A re-fire prints only the delta. If an unchanged line from another course counted, a
        // ticket showing one course's worth of changes would grow a heading for a course it is not
        // printing.
        const text = ticket([
            { name: 'Bruschetta', quantity: 2, change: 'new', courseName: 'Starters' },
            { name: 'Sea bass', quantity: 1, change: 'unchanged', courseName: 'Mains' },
        ]);

        expect(text).not.toContain('-- Starters --');
        expect(text).not.toContain('Sea bass');
    });
});
