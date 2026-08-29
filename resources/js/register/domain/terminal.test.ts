import type { PaymentStatus } from '@domain/enums';
import type { PaymentMethodRow, PaymentRow } from '@domain/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeOrder, makePayment, resetRowSequences } from './__fixtures__/rows';
import { FakeTerminal } from './__fixtures__/fake-terminal';
import {
    adjustOnTerminal,
    cancelOnTerminal,
    clearTerminalDrivers,
    hasTerminalDriver,
    isInFlight,
    registerTerminalDriver,
    requestTerminalCancel,
    reverseOnTerminal,
    sendToTerminal,
    terminalDriverFor,
    terminalStatus,
} from './terminal';

/**
 * BAN-414 / REG-210, REG-212, XCT-060 — the terminal driver registry.
 *
 * The conformance suite for the contract, run against `FakeTerminal` because there is no device, no
 * vendor SDK and no credentials anywhere in `config/` — AC1 ("a card payment on a real terminal
 * completes") and AC3 ("a reversal and a tip adjustment succeed against the driver") cannot be
 * verified here and a green run must not be read as saying they were.
 *
 * What *is* verified is the half that costs money without a device: every verb reaches the driver
 * when it should, and every refusal stops before it does. Those are separate assertions on purpose —
 * a guard that fires and a driver that says no produce the same `{ ok: false }`, so a test that only
 * looked at the result would pass whether or not the guard existed at all. `FakeTerminal.sawVerb`
 * is what tells the two apart.
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
/** A card method the back office never pointed at a vendor — `none` is the column's default. */
const UNCONFIGURED_CARD: PaymentMethodRow = { ...CARD, id: 3, terminal_provider: 'none' };

const SALE = makeOrder({ is_refund: false });
const REFUND = makeOrder({ is_refund: true });

function payment(methodId: number, status: PaymentStatus = 'pending', extra: Partial<PaymentRow> = {}): PaymentRow {
    return makePayment({ payment_method_id: methodId, payment_status: status, amount: '12.10', ...extra });
}

let terminal: FakeTerminal;

beforeEach(() => {
    resetRowSequences();
    terminal = new FakeTerminal('acme');
});

afterEach(() => {
    clearTerminalDrivers();
});

describe('finding a driver', () => {
    it('matches a driver to its own provider', () => {
        registerTerminalDriver(terminal);

        expect(terminalDriverFor(CARD)).toBe(terminal);
        expect(hasTerminalDriver(CARD)).toBe(true);
    });

    it('matches a driver only to its own provider', () => {
        registerTerminalDriver(new FakeTerminal('other'));

        expect(terminalDriverFor(CARD)).toBeNull();
    });

    it('finds nothing for a method with no provider configured', () => {
        registerTerminalDriver(terminal);

        expect(terminalDriverFor({ ...CARD, terminal_provider: null })).toBeNull();
    });

    it('treats the column default `none` as no terminal, not as a provider name', () => {
        // `terminal_provider` defaults to `none` in the schema, so this — not `null` — is what an
        // unconfigured card method actually ships to the register. A driver that registered itself
        // under the literal string would otherwise claim every one of them.
        registerTerminalDriver(new FakeTerminal('none'));

        expect(terminalDriverFor(UNCONFIGURED_CARD)).toBeNull();
        expect(hasTerminalDriver(UNCONFIGURED_CARD)).toBe(false);
    });

    it('finds nothing for a method that is not a card terminal at all', () => {
        registerTerminalDriver(terminal);

        expect(terminalDriverFor({ ...CASH, terminal_provider: 'acme' })).toBeNull();
    });
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

// ── send ─────────────────────────────────────────────────────────────────────

describe('send', () => {
    it('hands the payment and the method to the driver and takes its answer', async () => {
        registerTerminalDriver(terminal);
        const line = payment(CARD.id, 'pending');

        await expect(sendToTerminal(line, CARD, SALE)).resolves.toEqual({
            ok: true,
            status: 'done',
            metadata: {
                card_brand: 'visa',
                card_last4: '4242',
                auth_code: 'A12345',
                transaction_reference: 'txn_987',
                terminal_ticket: 'MERCHANT COPY\nVISA ****4242\nAPPROVED',
            },
        });
        expect(terminal.calls).toEqual([{ verb: 'send', paymentUuid: line.uuid, argument: String(CARD.id) }]);
    });

    it('passes a refusal from the terminal straight through', async () => {
        registerTerminalDriver(terminal.willRespond('send', { ok: false, reason: 'reg.pay.terminalFailed' }));

        await expect(sendToTerminal(payment(CARD.id, 'pending'), CARD, SALE)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalFailed',
        });
    });

    it('refuses when no driver is registered rather than pretending it sent', async () => {
        // The defect this ticket exists for: the button used to write `pending` and stop, so the
        // line said "Waiting for the terminal…" with nothing sent anywhere.
        await expect(sendToTerminal(payment(CARD.id, 'pending'), CARD, SALE)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalNoDriver',
        });
    });

    it('never sends a refund order to the terminal (REG-210)', async () => {
        registerTerminalDriver(terminal);

        await expect(sendToTerminal(payment(CARD.id, 'pending'), CARD, REFUND)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalRefundNoSend',
        });
        // The point of the guard: the terminal would take the money a second time.
        expect(terminal.sawVerb('send')).toBe(false);
    });

    it('never sends a refund payment line, even on an ordinary order', async () => {
        registerTerminalDriver(terminal);

        await expect(
            sendToTerminal(payment(CARD.id, 'pending', { is_refund: true }), CARD, SALE),
        ).resolves.toEqual({ ok: false, reason: 'reg.pay.terminalRefundNoSend' });
        expect(terminal.sawVerb('send')).toBe(false);
    });

    it('never sends a negative amount, whatever the flags claim', async () => {
        registerTerminalDriver(terminal);

        await expect(
            sendToTerminal(payment(CARD.id, 'pending', { amount: '-12.10', is_refund: false }), CARD, SALE),
        ).resolves.toEqual({ ok: false, reason: 'reg.pay.terminalRefundNoSend' });
        expect(terminal.sawVerb('send')).toBe(false);
    });

    it('refuses a refund before it even looks for a driver', async () => {
        // Order matters: the answer has to be the same on a register with an integration and one
        // without, because the rule is about what a refund *is*, not about what is plugged in.
        await expect(sendToTerminal(payment(CARD.id, 'pending'), CARD, REFUND)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalRefundNoSend',
        });
    });

    it('refuses to re-send a capture, which would charge the customer twice', async () => {
        registerTerminalDriver(terminal);

        await expect(sendToTerminal(payment(CARD.id, 'done'), CARD, SALE)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalAlreadyDone',
        });
        expect(terminal.sawVerb('send')).toBe(false);
    });

    it('turns a driver that throws into a refusal', async () => {
        // A socket timeout must not surface as an unhandled rejection: the screen would keep its
        // in-flight lock forever and the line could never be touched again.
        registerTerminalDriver(terminal.willRespond('send', 'throw'));

        await expect(sendToTerminal(payment(CARD.id, 'pending'), CARD, SALE)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalFailed',
        });
    });
});

// ── cancel (the button) ──────────────────────────────────────────────────────

describe('the cancel button', () => {
    it('asks the driver and reports what it says', async () => {
        registerTerminalDriver(terminal);
        const line = payment(CARD.id, 'pending');

        await expect(requestTerminalCancel(line, CARD)).resolves.toEqual({ ok: true, status: 'cancelled' });
        expect(terminal.calls).toEqual([{ verb: 'cancel', paymentUuid: line.uuid }]);
    });

    it('keeps the line pending when the terminal refuses to cancel', async () => {
        registerTerminalDriver(terminal.willRespond('cancel', { ok: false, reason: 'reg.pay.terminalFailed' }));

        await expect(requestTerminalCancel(payment(CARD.id, 'pending'), CARD)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalFailed',
        });
    });

    it('records the cashier’s own cancel when there is no driver', async () => {
        // Not a lie and not the delete guard. With no integration the cashier presses cancel on the
        // device; this button is the only place they can say so. Refusing here would leave them
        // unable to mark the line cancelled and therefore unable to delete it — a deadlock against
        // `cancelOnTerminal`, which refuses to release a line that is not marked.
        await expect(requestTerminalCancel(payment(CARD.id, 'pending'), CARD)).resolves.toEqual({
            ok: true,
            status: 'cancelled',
        });
    });

    it('does not ask twice for a line already cancelled', async () => {
        registerTerminalDriver(terminal);

        await expect(requestTerminalCancel(payment(CARD.id, 'cancelled'), CARD)).resolves.toEqual({
            ok: true,
            status: 'cancelled',
        });
        expect(terminal.sawVerb('cancel')).toBe(false);
    });

    it('turns a driver that throws into a refusal', async () => {
        registerTerminalDriver(terminal.willRespond('cancel', 'throw'));

        await expect(requestTerminalCancel(payment(CARD.id, 'pending'), CARD)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalFailed',
        });
    });
});

// ── reverse ──────────────────────────────────────────────────────────────────

describe('reverse', () => {
    it('undoes a capture through the driver', async () => {
        registerTerminalDriver(terminal);
        const line = payment(CARD.id, 'done');

        await expect(reverseOnTerminal(line, CARD)).resolves.toEqual({ ok: true, status: 'reversed' });
        expect(terminal.calls).toEqual([{ verb: 'reverse', paymentUuid: line.uuid }]);
    });

    it('passes a refusal from the terminal through', async () => {
        registerTerminalDriver(terminal.willRespond('reverse', { ok: false, reason: 'reg.pay.terminalFailed' }));

        await expect(reverseOnTerminal(payment(CARD.id, 'done'), CARD)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalFailed',
        });
    });

    it('refuses a line the terminal never captured', async () => {
        // An authorisation is cancelled, not reversed; reversing one would refund money that was
        // never taken.
        registerTerminalDriver(terminal);

        await expect(reverseOnTerminal(payment(CARD.id, 'pending'), CARD)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalNothingToReverse',
        });
        expect(terminal.sawVerb('reverse')).toBe(false);
    });

    it('refuses with no driver, because nothing local can undo a capture', async () => {
        await expect(reverseOnTerminal(payment(CARD.id, 'done'), CARD)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalNoDriver',
        });
    });

    it('turns a driver that throws into a refusal', async () => {
        registerTerminalDriver(terminal.willRespond('reverse', 'throw'));

        await expect(reverseOnTerminal(payment(CARD.id, 'done'), CARD)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalFailed',
        });
    });
});

// ── adjust (tip) ─────────────────────────────────────────────────────────────

describe('adjust', () => {
    it('adds a tip to a capture the terminal is holding', async () => {
        registerTerminalDriver(terminal);
        const line = payment(CARD.id, 'done');

        await expect(adjustOnTerminal(line, CARD, '2.00')).resolves.toMatchObject({ ok: true, status: 'done' });
        expect(terminal.calls).toEqual([{ verb: 'adjust', paymentUuid: line.uuid, argument: '2.00' }]);
    });

    it('adjusts an authorisation too, where the tip is added before capture', async () => {
        registerTerminalDriver(terminal);

        await expect(adjustOnTerminal(payment(CARD.id, 'authorized'), CARD, '2.00')).resolves.toMatchObject({
            ok: true,
        });
        expect(terminal.sawVerb('adjust')).toBe(true);
    });

    it('passes a refusal from the terminal through', async () => {
        registerTerminalDriver(terminal.willRespond('adjust', { ok: false, reason: 'reg.pay.terminalFailed' }));

        await expect(adjustOnTerminal(payment(CARD.id, 'done'), CARD, '2.00')).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalFailed',
        });
    });

    it('refuses a line the terminal is not holding', async () => {
        registerTerminalDriver(terminal);

        await expect(adjustOnTerminal(payment(CARD.id, 'cancelled'), CARD, '2.00')).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalNothingToAdjust',
        });
        expect(terminal.sawVerb('adjust')).toBe(false);
    });

    it('refuses a tip of nothing, and a negative one', async () => {
        registerTerminalDriver(terminal);

        await expect(adjustOnTerminal(payment(CARD.id, 'done'), CARD, '0')).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalAdjustInvalid',
        });
        await expect(adjustOnTerminal(payment(CARD.id, 'done'), CARD, '-1.00')).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalAdjustInvalid',
        });
        expect(terminal.sawVerb('adjust')).toBe(false);
    });

    it('never tips a refund line', async () => {
        registerTerminalDriver(terminal);

        await expect(
            adjustOnTerminal(payment(CARD.id, 'done', { is_refund: true }), CARD, '2.00'),
        ).resolves.toEqual({ ok: false, reason: 'reg.pay.terminalRefundNoSend' });
        expect(terminal.sawVerb('adjust')).toBe(false);
    });

    it('refuses with no driver', async () => {
        await expect(adjustOnTerminal(payment(CARD.id, 'done'), CARD, '2.00')).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalNoDriver',
        });
    });

    it('turns a driver that throws into a refusal', async () => {
        registerTerminalDriver(terminal.willRespond('adjust', 'throw'));

        await expect(adjustOnTerminal(payment(CARD.id, 'done'), CARD, '2.00')).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalFailed',
        });
    });
});

// ── status ───────────────────────────────────────────────────────────────────

describe('status', () => {
    it('asks the device what it thinks rather than guessing', async () => {
        registerTerminalDriver(terminal.willRespond('status', { ok: true, status: 'authorized' }));
        const line = payment(CARD.id, 'pending');

        await expect(terminalStatus(line, CARD)).resolves.toEqual({ ok: true, status: 'authorized' });
        expect(terminal.calls).toEqual([{ verb: 'status', paymentUuid: line.uuid }]);
    });

    it('passes a refusal through', async () => {
        registerTerminalDriver(terminal.willRespond('status', { ok: false, reason: 'reg.pay.terminalFailed' }));

        await expect(terminalStatus(payment(CARD.id, 'pending'), CARD)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalFailed',
        });
    });

    it('refuses with no driver — there is nobody to ask', async () => {
        await expect(terminalStatus(payment(CARD.id, 'pending'), CARD)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalNoDriver',
        });
    });

    it('turns a driver that throws into a refusal', async () => {
        registerTerminalDriver(terminal.willRespond('status', 'throw'));

        await expect(terminalStatus(payment(CARD.id, 'pending'), CARD)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalFailed',
        });
    });
});

// ── the delete guard, which is a different question (REG-212) ────────────────

describe('the delete guard, with no driver registered', () => {
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
        return expect(cancelOnTerminal(payment(CARD.id, 'cancelled'), CARD)).resolves.toEqual({
            ok: true,
            status: 'cancelled',
        });
    });

    it('never stands in the way of a cash line', () => {
        return expect(cancelOnTerminal(payment(CASH.id, 'done'), CASH)).resolves.toEqual({
            ok: true,
            status: 'done',
        });
    });
});

describe('the delete guard, with a driver registered', () => {
    it('asks the driver and lets the line go when it reverses', async () => {
        registerTerminalDriver(terminal);
        const live = payment(CARD.id, 'pending');

        await expect(cancelOnTerminal(live, CARD)).resolves.toEqual({ ok: true, status: 'cancelled' });
        expect(terminal.calls).toEqual([{ verb: 'cancel', paymentUuid: live.uuid }]);
    });

    it('keeps the line when the terminal refuses', async () => {
        // The whole point of awaiting the driver: a refusal has to stop the delete, or the register
        // and the terminal disagree about what was taken.
        registerTerminalDriver(terminal.willRespond('cancel', { ok: false, reason: 'reg.pay.terminalFailed' }));

        await expect(cancelOnTerminal(payment(CARD.id, 'pending'), CARD)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalFailed',
        });
    });

    it('does not call the driver for a line that is not in flight', async () => {
        registerTerminalDriver(terminal);

        await cancelOnTerminal(payment(CARD.id, 'done'), CARD);

        expect(terminal.sawVerb('cancel')).toBe(false);
    });

    it('turns a driver that throws into a refusal, so the delete stops', async () => {
        registerTerminalDriver(terminal.willRespond('cancel', 'throw'));

        await expect(cancelOnTerminal(payment(CARD.id, 'pending'), CARD)).resolves.toEqual({
            ok: false,
            reason: 'reg.pay.terminalFailed',
        });
    });
});
