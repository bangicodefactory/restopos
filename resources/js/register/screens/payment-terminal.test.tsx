/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PaymentStatus } from '@domain/enums';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOrderCommand } from '../data/persistence';
import { clearRuntime } from '../data/runtime';
import {
    installCatalog,
    makeConfig,
    makePaymentMethod,
    makeProduct,
    makeVariant,
    resetRegisterState,
} from '../domain/__fixtures__/catalog';
import { FakeTerminal } from '../domain/__fixtures__/fake-terminal';
import { addLine, addPayment, configureOrderActions, createOrder } from '../domain/order-actions';
import { clearTerminalDrivers, registerTerminalDriver } from '../domain/terminal';
import { useOrderStore } from '../state/order-store';
import { PaymentScreen } from './PaymentScreen';

/**
 * BAN-414 / REG-210 — the terminal buttons, once they go through the registry.
 *
 * `terminal.test.ts` proves the contract; this proves the screen is actually plugged into it. The
 * two are separate because the defect being fixed lived entirely in the wiring: the registry and
 * its rules existed, `setPaymentStatus` had taken terminal metadata as a third argument since the
 * row was declared, and the buttons called it with two — so every rule in the module was correct
 * and none of it was reachable from the till.
 *
 * The metadata assertion is the load-bearing one. A card brand, an auth code and a merchant slip
 * arriving on the payment row is the only observable difference between "the register asked the
 * terminal" and "the register wrote a status string and hoped".
 */

const CARD_METHOD = 7;
const CASH_METHOD = 8;
const PIZZA = 101;

/**
 * A register with two methods, not one.
 *
 * Deliberate: with a single configured method REG-201 re-tenders the moment a line is removed, so a
 * register carrying only the card would auto-add a replacement between the delete and the assertion
 * and hide whatever the delete did.
 */
function install(terminalProvider: string | null): void {
    installCatalog({
        config: makeConfig({ payment_method_ids: [CARD_METHOD, CASH_METHOD] }),
        products: [makeProduct({ id: 1, name: 'Pizza', list_price: '20.00' })],
        variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
        paymentMethods: [
            makePaymentMethod({
                id: CARD_METHOD,
                name: 'Carte',
                method_type: 'card_terminal',
                is_cash_count: false,
                terminal_provider: terminalProvider,
            }),
            makePaymentMethod({ id: CASH_METHOD, name: 'Espèces' }),
        ],
    });
}

async function orderWithCardLine(isRefund = false): Promise<{ orderUuid: string; paymentUuid: string }> {
    const orderUuid = await createOrder({ isRefund });
    addLine({ orderUuid, variantId: PIZZA, quantity: 1, priceUnit: '20.00' });
    const paymentUuid = addPayment(orderUuid, CARD_METHOD, isRefund ? '-20.00' : '20.00');

    return { orderUuid, paymentUuid };
}

function paymentRow(uuid: string) {
    return useOrderStore.getState().payments[uuid];
}

/**
 * Put a line into a status the screen itself can no longer produce.
 *
 * A fresh tender is `done`, and with the buttons routed through the registry nothing local writes
 * `pending` any more — which is the fix. Reaching these states through the store is therefore the
 * only way to stand a test on a line that arrived from the server or from an earlier session.
 */
function setStatus(uuid: string, status: PaymentStatus): void {
    const payments = useOrderStore.getState().payments;

    useOrderStore.setState({
        payments: { ...payments, [uuid]: { ...payments[uuid]!, payment_status: status } },
    } as never);
}

let terminal: FakeTerminal;

beforeEach(() => {
    clearRuntime();
    resetRegisterState();
    clearTerminalDrivers();
    terminal = new FakeTerminal('acme');
    configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });
});

afterEach(() => {
    clearTerminalDrivers();
});

describe('with a driver registered', () => {
    beforeEach(() => {
        install('acme');
        registerTerminalDriver(terminal);
    });

    it('sends through the driver and writes back the terminal’s own answer, metadata and all', async () => {
        const { orderUuid, paymentUuid } = await orderWithCardLine();
        // A fresh line is `done`; the send button only exists on a line the terminal has not taken.
        setStatus(paymentUuid, 'pending');

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);
        fireEvent.click(screen.getByTestId('terminal-send'));

        await waitFor(() => expect(paymentRow(paymentUuid)?.payment_status).toBe('done'));

        expect(terminal.sawVerb('send')).toBe(true);
        expect(paymentRow(paymentUuid)).toMatchObject({
            card_brand: 'visa',
            card_last4: '4242',
            auth_code: 'A12345',
            transaction_reference: 'txn_987',
            terminal_ticket: 'MERCHANT COPY\nVISA ****4242\nAPPROVED',
        });
    });

    it('puts the merchant slip on the command the server is pushed (REG-213)', async () => {
        // The client half of the dead wire. `terminal_ticket` reached the payment row, and the push
        // command left it behind — so the slip lived in one browser's IndexedDB and nowhere else.
        const { orderUuid, paymentUuid } = await orderWithCardLine();
        setStatus(paymentUuid, 'pending');

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);
        fireEvent.click(screen.getByTestId('terminal-send'));

        await waitFor(() => expect(paymentRow(paymentUuid)?.payment_status).toBe('done'));

        expect(buildOrderCommand(useOrderStore.getState(), orderUuid)?.payments?.[0]).toMatchObject({
            terminal_ticket: 'MERCHANT COPY\nVISA ****4242\nAPPROVED',
            auth_code: 'A12345',
        });
    });

    it('leaves the line alone and says why when the terminal refuses', async () => {
        terminal.willRespond('send', { ok: false, reason: 'reg.pay.terminalFailed' });
        const { orderUuid, paymentUuid } = await orderWithCardLine();
        setStatus(paymentUuid, 'pending');

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);
        fireEvent.click(screen.getByTestId('terminal-send'));

        await waitFor(() => expect(screen.getByText('Refused')).toBeTruthy());
        // Not flipped to `done`, and not flipped optimistically to `pending` either — the status on
        // screen is whatever the terminal last actually said.
        expect(paymentRow(paymentUuid)?.payment_status).toBe('pending');
    });

    it('offers a reversal on a captured line, and takes it', async () => {
        const { orderUuid, paymentUuid } = await orderWithCardLine();

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);
        fireEvent.click(screen.getByTestId('terminal-reverse'));

        await waitFor(() => expect(paymentRow(paymentUuid)?.payment_status).toBe('reversed'));
        expect(terminal.sawVerb('reverse')).toBe(true);
    });

    it('does not offer a reversal on a line the terminal has not captured', async () => {
        // The button has to be state-gated, not merely present: `reverseOnTerminal` refuses an
        // authorisation, so an always-rendered Reverse is a button whose only outcome is an error.
        const { orderUuid, paymentUuid } = await orderWithCardLine();
        setStatus(paymentUuid, 'pending');

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);

        expect(screen.queryByTestId('terminal-reverse')).toBeNull();
    });

    it('locks the line while the terminal has it, and says it is waiting', async () => {
        // The seconds a customer spends tapping a card are the whole reason the lock exists: a
        // second tap on Send presents a second sale for one tender, and a delete during a cancel
        // drops the row while the authorisation is still live on the device.
        const release = terminal.holdOpen('send');
        const { orderUuid, paymentUuid } = await orderWithCardLine();
        // `failed`, not `pending`: on a pending line "Waiting for the terminal…" is already true
        // from the status alone, so it would say nothing about the operation being in flight.
        setStatus(paymentUuid, 'failed');

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);
        expect(screen.getByTestId('payment-status').textContent).toBe('failed');
        fireEvent.click(screen.getByTestId('terminal-send'));

        await waitFor(() =>
            expect((screen.getByTestId('terminal-send') as HTMLButtonElement).disabled).toBe(true),
        );
        expect(screen.getByTestId('payment-status').textContent).toBe('Waiting for the terminal…');
        // REG-212 again, from the other direction: the row cannot be deleted out from under an
        // operation the terminal has not answered yet.
        expect(screen.queryByTestId('payment-remove')).toBeNull();

        release();

        await waitFor(() => expect(paymentRow(paymentUuid)?.payment_status).toBe('done'));
        expect(screen.queryByTestId('payment-remove')).not.toBeNull();
    });

    it('asks the terminal rather than offering the cashier a guess', async () => {
        terminal.willRespond('status', { ok: true, status: 'authorized' });
        const { orderUuid, paymentUuid } = await orderWithCardLine();
        setStatus(paymentUuid, 'pending');

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);

        // The point of the swap: with a driver there is no "Force as paid" to reach for.
        expect(screen.queryByTestId('terminal-force')).toBeNull();

        fireEvent.click(screen.getByTestId('terminal-status'));
        await waitFor(() => expect(paymentRow(paymentUuid)?.payment_status).toBe('authorized'));
    });

    it('refuses to send a refund order to the terminal and never reaches the driver', async () => {
        const { orderUuid, paymentUuid } = await orderWithCardLine(true);
        setStatus(paymentUuid, 'pending');

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);
        fireEvent.click(screen.getByTestId('terminal-send'));

        await waitFor(() =>
            expect(
                screen.getByText(
                    'A refund is never sent to the terminal as a sale. Reverse the original payment instead.',
                ),
            ).toBeTruthy(),
        );
        expect(terminal.sawVerb('send')).toBe(false);
        expect(paymentRow(paymentUuid)?.payment_status).toBe('pending');
    });
});

describe('with no driver — which is every venue today', () => {
    beforeEach(() => {
        install('none');
    });

    it('offers no send button at all, because there is nothing to send to', async () => {
        const { orderUuid } = await orderWithCardLine();

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);

        // The defect in one assertion: the old button wrote `pending`, the line then read "Waiting
        // for the terminal…", and nothing had been sent anywhere.
        expect(screen.queryByTestId('terminal-send')).toBeNull();
        expect(screen.getByTestId('payment-status').textContent).not.toBe('Waiting for the terminal…');
    });

    it('still lets the cashier record what they did on the device themselves', async () => {
        const { orderUuid, paymentUuid } = await orderWithCardLine();

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);
        fireEvent.click(screen.getByTestId('terminal-cancel'));

        await waitFor(() => expect(paymentRow(paymentUuid)?.payment_status).toBe('cancelled'));

        // And back again: refusing the cancel here would deadlock the delete guard, which will not
        // release a line that is not marked.
        fireEvent.click(screen.getByTestId('terminal-force'));
        await waitFor(() => expect(paymentRow(paymentUuid)?.payment_status).toBe('done'));
    });

    it('drops the selection with the line, so the keypad stops editing a row that is gone', async () => {
        // Not new behaviour — but it had no test, and a mutation sweep walked straight through it.
        // Left selected, the numpad and the quick-tender keys stay live over a deleted uuid:
        // `setPaymentAmount` finds nothing and returns, so every keystroke silently does nothing
        // while the screen shows an armed keypad.
        const { orderUuid, paymentUuid } = await orderWithCardLine();

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);

        fireEvent.click(screen.getByTestId('payment-select'));
        expect((screen.getAllByTestId('quick-amount')[0] as HTMLButtonElement).disabled).toBe(false);

        fireEvent.click(screen.getByTestId('payment-remove'));

        await waitFor(() =>
            expect((screen.getAllByTestId('quick-amount')[0] as HTMLButtonElement).disabled).toBe(true),
        );
        expect(paymentRow(paymentUuid)).toBeUndefined();
    });

    it('refuses to delete a line that may still be live on the device (REG-212)', async () => {
        const { orderUuid, paymentUuid } = await orderWithCardLine();
        setStatus(paymentUuid, 'pending');

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);
        fireEvent.click(screen.getByTestId('payment-remove'));

        await waitFor(() =>
            expect(
                screen.getByText(
                    'Cancel this payment on the terminal first, then mark the line cancelled.',
                ),
            ).toBeTruthy(),
        );
        expect(paymentRow(paymentUuid)).toBeTruthy();
    });
});
