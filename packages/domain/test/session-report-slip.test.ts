import { describe, expect, it } from 'vitest';

import { toPlainText } from '../src/escpos/serializer';
import { buildSessionReportDoc } from '../src/receipt/build';
import { DEFAULT_LABELS } from '../src/receipt/types';
import type { ReceiptConfigView, SessionReportView } from '../src/receipt/types';

/**
 * BAN-438 / REG-020, REG-022 — the session reading.
 *
 * The slip had no test at all while its sibling `buildCashMoveDoc` did, and the gap cost exactly
 * what you would expect: `refunds` arrives **negative** — a refund line's `base_amount` carries its
 * negative quantity — and the net line subtracted it. A day that sold 20 and refunded 10 printed
 * `NET SALES 30.00`, three times the truth, on the one number a manager reads off the paper. Every
 * assertion in the suite was at the API boundary, where the value was correct all along.
 *
 * The other thing this pins is that an X and a Z must never be mistaken for each other. A cashier
 * holding the wrong slip believes the till is closed and stops counting.
 */

const CONFIG: ReceiptConfigView = {
    width: 42,
    codepage: 'cp858',
    companyName: 'Trattoria Test',
    companyAddress: ['12 rue des Oliviers'],
    companyPhone: null,
    companyVat: null,
    header: null,
    footer: 'Merci',
    logoKey: null,
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

function report(overrides: Partial<SessionReportView> = {}): SessionReportView {
    return {
        sessionId: 1,
        sessionName: 'Bar/00012',
        configName: 'Bar',
        isOpen: true,
        openedAt: '2026-08-10T08:12:00Z',
        printedAt: '2026-08-10T18:30:00Z',
        cashierName: 'Amina B.',
        orderCount: 2,
        grossSales: '20.0000',
        refunds: '0.0000',
        tax: '4.2000',
        openingFloat: '100.0000',
        cashIn: '0.0000',
        cashOut: '0.0000',
        expectedCash: '124.2000',
        taxes: [],
        payments: [],
        ...overrides,
    } as SessionReportView;
}

function slip(overrides: Partial<SessionReportView> = {}): string {
    return toPlainText(buildSessionReportDoc(report(overrides), CONFIG));
}

describe('net sales', () => {
    it('takes refunds off the total rather than adding them', () => {
        // Sold 20.00 excluding tax, refunded one 10.00 line.
        const text = slip({ refunds: '-10.0000' });

        expect(text).toContain('Gross sales');
        expect(text).toMatch(/NET SALES\s+10,00/);
    });

    it('prints the refund with its own sign', () => {
        // Flipping it positive reads as though refunds added to the take, which is the misreading
        // the net line would then appear to confirm.
        expect(slip({ refunds: '-10.0000' })).toMatch(/Refunds\s+-10,00/);
    });

    it('leaves a refund-free shift with no refund line at all', () => {
        // A zero line on every reading trains people to skim past the one shift where it is not.
        expect(slip()).not.toContain('Refunds');
        expect(slip()).toMatch(/NET SALES\s+20,00/);
    });

    it('handles a shift that refunded more than it sold', () => {
        // Rare, real, and the arithmetic must not flip sign twice: a morning of returns against
        // yesterday's trade nets negative and should say so.
        expect(slip({ grossSales: '10.0000', refunds: '-25.0000' })).toMatch(/NET SALES\s+-15,00/);
    });
});

describe('an X is not a Z', () => {
    it('names itself and says the session is still open', () => {
        const text = slip();

        expect(text).toContain('X-REPORT');
        expect(text).toContain('This session is still open');
        expect(text).not.toContain('Z-REPORT');
    });

    it('prints the same layout under a Z heading once the session has closed', () => {
        const text = slip({ isOpen: false });

        expect(text).toContain('Z-REPORT');
        expect(text).not.toContain('This session is still open');
    });

    it('carries no counted cash or variance, because nobody has counted anything', () => {
        // Those belong to the close. A reading showing a difference invites someone to act on a
        // number the system invented.
        const text = slip();

        expect(text).toContain('Expected in drawer');
        expect(text).not.toContain('Difference');
    });
});

describe('what the reading covers', () => {
    it('says so when the till still has sales queued', () => {
        expect(slip({ queuedUnsent: true })).toContain('Queued sales not included');
    });

    it('stays quiet when the outbox was empty', () => {
        expect(slip()).not.toContain('Queued sales');
    });

    it('breaks tax down by rate when there is more than one', () => {
        const text = slip({
            taxes: [
                { label: 'VAT 10%', base: '10.0000', amount: '1.0000' },
                { label: 'VAT 20%', base: '10.0000', amount: '2.0000' },
            ],
        });

        expect(text).toContain('VAT 10%');
        expect(text).toContain('VAT 20%');
    });

    it('lists each payment method with how many took it', () => {
        const text = slip({
            payments: [
                { label: 'Cash', amount: '24.2000', count: 2 },
                { label: 'Carte', amount: '12.1000', count: 1 },
            ],
        });

        expect(text).toMatch(/Cash x2\s+24,20/);
        expect(text).toMatch(/Carte x1\s+12,10/);
    });

    it('shows drawer movements only when there were some', () => {
        expect(slip()).not.toContain('CASH IN');
        expect(slip({ cashIn: '20.0000' })).toContain('CASH IN');
    });

    it('is a report document, so it routes to a report printer', () => {
        // `DocKind: 'report'` had never been produced by anything. The kind is what sends this to a
        // back-office printer instead of the customer-facing one.
        expect(buildSessionReportDoc(report(), CONFIG).meta.kind).toBe('report');
    });

    it('always carries the session, the till and when it was printed', () => {
        // A slip found on a desk a week later has to say which till and when, or it is scrap paper.
        const text = slip();

        expect(text).toContain('Bar/00012');
        expect(text).toContain('Bar');
        expect(text).toContain('Amina B.');
        expect(text).toContain('Printed');
    });
});
