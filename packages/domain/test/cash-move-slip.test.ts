import { describe, expect, it } from 'vitest';

import { buildCashMoveDoc } from '../src/receipt/build';
import { toPlainText } from '../src/escpos/serializer';
import { DEFAULT_LABELS } from '../src/receipt/types';
import type { CashMoveView, ReceiptConfigView } from '../src/receipt/types';

/**
 * BAN-420 / REG-013 — the drawer-movement slip.
 *
 * Money left the till with nothing to show for it. This is the paper that says who took it, how
 * much, why and when — the four facts an owner reconciling a short drawer needs, and the reason a
 * cash-out with no trail is the easiest money in the building to take.
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

function slip(overrides: Partial<CashMoveView> = {}): string {
    const move: CashMoveView = {
        uuid: 'move-1',
        kind: 'cash_out',
        amount: '40.00',
        reason: 'Bank run',
        cashierName: 'Karim M.',
        movedAt: '2026-08-07T15:20:00.000Z',
        sessionName: 'Bar/00007',
        ...overrides,
    };

    return toPlainText(buildCashMoveDoc(move, CONFIG));
}

describe('buildCashMoveDoc', () => {
    it('carries who, how much, why and when', () => {
        const text = slip();

        expect(text).toContain('Karim M.');
        expect(text).toContain('40,00');
        expect(text).toContain('Bank run');
        expect(text).toContain('Bar/00007');
    });

    it('says which direction the money went, in words', () => {
        expect(slip({ kind: 'cash_out' })).toContain(DEFAULT_LABELS.cashOut);
        expect(slip({ kind: 'cash_in' })).toContain(DEFAULT_LABELS.cashIn);
    });

    it('prints the amount as a magnitude, never with a minus', () => {
        // The heading already says which way it went. A `-40.00` under a "CASH OUT" banner reads as
        // a correction *of* a cash-out to whoever is holding the slip — and a minus sign on a
        // thermal print is one faded pixel from invisible.
        const text = slip({ amount: '-40.00' });

        expect(text).toContain('40,00');
        expect(text).not.toContain('-40,00');
    });

    it('is a cash_move document, not a receipt', () => {
        // The kind drives the printer role and the reprint rules; a slip filed as a receipt would
        // turn up under "reprint the last receipt".
        const doc = buildCashMoveDoc(
            {
                uuid: 'move-1',
                kind: 'cash_in',
                amount: '5.00',
                reason: null,
                cashierName: null,
                movedAt: '2026-08-07T10:00:00.000Z',
                sessionName: null,
            },
            CONFIG,
        );

        expect(doc.meta.kind).toBe('cash_move');
    });

    it('survives a movement with nothing optional filled in', () => {
        // Cash in is often the venue's own float: no reason typed, nobody logged in yet.
        const text = slip({ reason: null, cashierName: null, sessionName: null, kind: 'cash_in' });

        expect(text).toContain(DEFAULT_LABELS.cashIn);
        expect(text).toContain('40,00');
        expect(text).not.toContain('null');
        expect(text).not.toContain('undefined');
    });

    it('leaves room to sign', () => {
        // The slip is signed by hand and filed; a rule with nothing under it is the signature line.
        expect(slip()).toContain('_____');
    });
});
