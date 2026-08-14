import type { PaymentStatus } from '@domain/enums';
import type { PaymentMethodRow, PaymentRow } from '@domain/types';
import { asUuid } from '@domain/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    cancelOnTerminal,
    clearTerminalDrivers,
    isInFlight,
    registerTerminalDriver,
    terminalDriverFor,
} from './terminal';

/**
 * BAN-434 / REG-212 — cancelling a payment that may still be live on a terminal.
 *
 * Deleting the line used to flip `payment_status` locally and stop there, which reads as "the
 * terminal was told" while a real capture stays live: the customer is charged for a payment the
 * register believes it cancelled, and nothing on either side says so.
 *
 * No driver ships yet (REG-210 is Phase 5), so the case that matters most here is the one where
 * there is nothing to ask. The register cannot reach the terminal, so it must not claim to have.
 */

const CASH: PaymentMethodRow = {
    id: 1,
    company_id: 1,
    name: 'Espèces',
    method_type: 'cash',
    is_cash_count: true,
    identify_customer: false,
    split_transactions: false,
    payment_provider_id: null,
    terminal_provider: null,
    image_media_id: null,
    sequence: 1,
    active: true,
};
const CARD: PaymentMethodRow = {
    ...CASH,
    id: 2,
    name: 'Carte',
    method_type: 'card_terminal',
    is_cash_count: false,
    terminal_provider: 'acme',
};

let counter = 0;
function payment(methodId: number, status: PaymentStatus = 'pending'): PaymentRow {
    counter += 1;
    return {
        uuid: asUuid(`payment-${counter}`),
        id: null,
        order_uuid: asUuid('order-1'),
        pos_session_id: 1,
        payment_method_id: methodId,
        currency_id: 1,
        amount: '12.10',
        is_change: false,
        is_refund: false,
        label: null,
        paid_at: '2026-01-01T00:00:00.000Z',
        customer_id: null,
        employee_id: null,
        payment_status: status,
        card_brand: null,
        card_last4: null,
        auth_code: null,
        transaction_reference: null,
        terminal_ticket: null,
        rev: 0,
    };
}

afterEach(() => {
    clearTerminalDrivers();
});

describe('what counts as still in flight', () => {
    it('counts a pending terminal line', () => {
        expect(isInFlight(payment(CARD.id, 'pending'), CARD)).toBe(true);
    });

    it('counts an authorized one, where the hold is real even though it has not captured', () => {
        // Dropping the line leaves the hold on the customer's card with nothing pointing at it.
        expect(isInFlight(payment(CARD.id, 'authorized'), CARD)).toBe(true);
    });

    it('does not count one that already failed or was cancelled', () => {
        expect(isInFlight(payment(CARD.id, 'failed'), CARD)).toBe(false);
        expect(isInFlight(payment(CARD.id, 'cancelled'), CARD)).toBe(false);
    });

    it('does not count a completed capture', () => {
        expect(isInFlight(payment(CARD.id, 'done'), CARD)).toBe(false);
    });

    it('never counts a cash line, whatever its status says', () => {
        expect(isInFlight(payment(CASH.id, 'pending'), CASH)).toBe(false);
    });
});

describe('with no driver registered — which is every venue today', () => {
    it('refuses to drop a live authorisation', () => {
        // The honest answer: the register does not know whether the terminal captured, so it says
        // so instead of silently agreeing.
        return expect(cancelOnTerminal(payment(CARD.id, 'pending'), CARD)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalCancelManually',
        });
    });

    it('lets a line the cashier has already cancelled on the terminal go', () => {
        // This is the manual route out: cancel on the device, mark the line, then delete.
        return expect(cancelOnTerminal(payment(CARD.id, 'cancelled'), CARD)).resolves.toEqual({ ok: true });
    });

    it('never stands in the way of a cash line', () => {
        return expect(cancelOnTerminal(payment(CASH.id, 'done'), CASH)).resolves.toEqual({ ok: true });
    });
});

describe('with a driver registered', () => {
    it('asks the driver and lets the line go when it reverses', async () => {
        const cancel = vi.fn().mockResolvedValue({ ok: true });
        registerTerminalDriver({ provider: 'acme', cancel });

        const live = payment(CARD.id, 'pending');

        await expect(cancelOnTerminal(live, CARD)).resolves.toEqual({ ok: true });
        expect(cancel).toHaveBeenCalledWith(live);
    });

    it('keeps the line when the terminal refuses', async () => {
        // The whole point of awaiting the driver: a refusal has to stop the delete, or the register
        // and the terminal disagree about what was taken.
        registerTerminalDriver({
            provider: 'acme',
            cancel: vi.fn().mockResolvedValue({ ok: false, reason: 'reg.pay.terminalFailed' }),
        });

        await expect(cancelOnTerminal(payment(CARD.id, 'pending'), CARD)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalFailed',
        });
    });

    it('does not call the driver for a line that is not in flight', async () => {
        const cancel = vi.fn().mockResolvedValue({ ok: true });
        registerTerminalDriver({ provider: 'acme', cancel });

        await cancelOnTerminal(payment(CARD.id, 'done'), CARD);

        expect(cancel).not.toHaveBeenCalled();
    });

    it('matches a driver only to its own provider', () => {
        registerTerminalDriver({ provider: 'other', cancel: vi.fn() });

        expect(terminalDriverFor(CARD)).toBeNull();
    });

    it('finds nothing for a method with no provider configured', () => {
        registerTerminalDriver({ provider: 'acme', cancel: vi.fn() });

        expect(terminalDriverFor({ ...CARD, terminal_provider: null })).toBeNull();
    });
});
