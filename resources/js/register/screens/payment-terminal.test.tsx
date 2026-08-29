/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const PIZZA = 101;

function install(terminalProvider: string | null): void {
    installCatalog({
        config: makeConfig({ payment_method_ids: [CARD_METHOD] }),
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
        useOrderStore.setState({
            payments: {
                ...useOrderStore.getState().payments,
                [paymentUuid]: { ...paymentRow(paymentUuid)!, payment_status: 'pending' },
            },
        } as never);

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
        useOrderStore.setState({
            payments: {
                ...useOrderStore.getState().payments,
                [paymentUuid]: { ...paymentRow(paymentUuid)!, payment_status: 'pending' },
            },
        } as never);

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
        useOrderStore.setState({
            payments: {
                ...useOrderStore.getState().payments,
                [paymentUuid]: { ...paymentRow(paymentUuid)!, payment_status: 'pending' },
            },
        } as never);

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

    it('asks the terminal rather than offering the cashier a guess', async () => {
        terminal.willRespond('status', { ok: true, status: 'authorized' });
        const { orderUuid, paymentUuid } = await orderWithCardLine();
        useOrderStore.setState({
            payments: {
                ...useOrderStore.getState().payments,
                [paymentUuid]: { ...paymentRow(paymentUuid)!, payment_status: 'pending' },
            },
        } as never);

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);

        // The point of the swap: with a driver there is no "Force as paid" to reach for.
        expect(screen.queryByTestId('terminal-force')).toBeNull();

        fireEvent.click(screen.getByTestId('terminal-status'));
        await waitFor(() => expect(paymentRow(paymentUuid)?.payment_status).toBe('authorized'));
    });

    it('refuses to send a refund order to the terminal and never reaches the driver', async () => {
        const { orderUuid, paymentUuid } = await orderWithCardLine(true);
        useOrderStore.setState({
            payments: {
                ...useOrderStore.getState().payments,
                [paymentUuid]: { ...paymentRow(paymentUuid)!, payment_status: 'pending' },
            },
        } as never);

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

    it('refuses to delete a line that may still be live on the device (REG-212)', async () => {
        const { orderUuid, paymentUuid } = await orderWithCardLine();
        useOrderStore.setState({
            payments: {
                ...useOrderStore.getState().payments,
                [paymentUuid]: { ...paymentRow(paymentUuid)!, payment_status: 'pending' },
            },
        } as never);

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
