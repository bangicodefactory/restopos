/** @vitest-environment jsdom */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    installCatalog,
    makeConfig,
    makePaymentMethod,
    makeProduct,
    makeTax,
    makeVariant,
    resetRegisterState,
} from '../domain/__fixtures__/catalog';
import { addLine, configureOrderActions, createOrder, markPrepSent } from '../domain/order-actions';
import { paymentsOf, useOrderStore } from '../state/order-store';
import { useUiStore } from '../state/ui-store';
import { SendBeforePayDialog } from './dialogs/MiscDialogs';
import { OrderPanel } from './OrderPanel';

/**
 * RST-143 — Pay must not settle an order the kitchen has not been told about.
 *
 * These render the real panel and click the real button. The predicate is unit-tested separately;
 * what needs a DOM is the *wiring* — which is where the interesting bug was: "send, then pay" used
 * to fire the send and navigate without waiting, so a refused send still landed the cashier on the
 * payment screen with the food unsent.
 */

const TAX = makeTax({ id: 1, amount: '20', tax_group_id: 1 });
const VARIANT = 101;

function install(restaurant: boolean, config: Partial<Parameters<typeof makeConfig>[0]> = {}): void {
    installCatalog({
        config: makeConfig({ is_restaurant: restaurant, ...config }),
        taxes: [TAX],
        products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00', tax_ids: [TAX.id] })],
        variants: [makeVariant({ id: VARIANT, product_id: 1, display_name: 'Pizza' })],
        paymentMethods: [
            makePaymentMethod({ id: 1, name: 'Espèces' }),
            makePaymentMethod({ id: 2, name: 'Carte', method_type: 'card_terminal', is_cash_count: false }),
        ],
    });
}

/** Turn on one-tap cash. */
const FAST_CASH = { use_fast_payment: true, fast_payment_method_ids: [1], payment_method_ids: [1, 2] };

function panel(props: Partial<Parameters<typeof OrderPanel>[0]> = {}) {
    const orderUuid = useOrderStore.getState().selectedOrderUuid;

    return render(
        <OrderPanel
            orderUuid={orderUuid}
            onPay={props.onPay ?? vi.fn()}
            onFastPaid={props.onFastPaid ?? vi.fn()}
            onSend={props.onSend ?? vi.fn()}
            onFireCourse={vi.fn()}
            onBill={vi.fn()}
            onSplit={vi.fn()}
            onTransfer={vi.fn()}
        />,
    );
}

describe('Pay with unsent kitchen changes (RST-143)', () => {
    beforeEach(() => {
        resetRegisterState();
        configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });
        useUiStore.setState({ dialog: null });
    });

    it('opens the send-first prompt instead of going to payment', async () => {
        install(true);
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);
        addLine({ orderUuid: uuid, variantId: VARIANT });

        const onPay = vi.fn();
        panel({ onPay });

        await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

        expect(onPay).not.toHaveBeenCalled();
        expect(useUiStore.getState().dialog?.kind).toBe('sendBeforePay');
    });

    it('goes straight to payment once the kitchen has everything', async () => {
        install(true);
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);
        addLine({ orderUuid: uuid, variantId: VARIANT });
        markPrepSent(uuid); // the delta is now empty

        const onPay = vi.fn();
        panel({ onPay });

        await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

        expect(onPay).toHaveBeenCalledOnce();
        expect(useUiStore.getState().dialog).toBeNull();
    });

    it('never prompts on a counter sale — there is no kitchen step to skip', async () => {
        install(false);
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);
        addLine({ orderUuid: uuid, variantId: VARIANT });

        const onPay = vi.fn();
        panel({ onPay });

        await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

        expect(onPay).toHaveBeenCalledOnce();
    });
});

describe('the send-first prompt', () => {
    beforeEach(async () => {
        resetRegisterState();
        configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });
        install(true);
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);
        useUiStore.setState({ dialog: { kind: 'sendBeforePay' } });
    });

    it('sends, then pays — only once the kitchen actually has it', async () => {
        const order: string[] = [];
        const onSend = vi.fn(async () => {
            order.push('send');
            return true;
        });
        const onPay = vi.fn(() => void order.push('pay'));

        render(<SendBeforePayDialog onSend={onSend} onPay={onPay} />);
        await userEvent.click(screen.getByRole('button', { name: /Send, then pay/i }));

        expect(order).toEqual(['send', 'pay']);
    });

    it('does NOT navigate when the send was refused', async () => {
        // `outdated` — another device fired this order first. Navigating anyway would drop the
        // cashier on the payment screen with the food still unsent, which is the state the prompt
        // exists to prevent, and worse than never asking because they now believe it was handled.
        const onSend = vi.fn(async () => false);
        const onPay = vi.fn();

        render(<SendBeforePayDialog onSend={onSend} onPay={onPay} />);
        await userEvent.click(screen.getByRole('button', { name: /Send, then pay/i }));

        expect(onSend).toHaveBeenCalledOnce();
        expect(onPay).not.toHaveBeenCalled();
    });

    it('lets the cashier pay anyway without sending', async () => {
        const onSend = vi.fn(async () => true);
        const onPay = vi.fn();

        render(<SendBeforePayDialog onSend={onSend} onPay={onPay} />);
        await userEvent.click(screen.getByRole('button', { name: /Pay anyway/i }));

        expect(onSend).not.toHaveBeenCalled();
        expect(onPay).toHaveBeenCalledOnce();
    });

    it('backs out without sending or paying', async () => {
        const onSend = vi.fn(async () => true);
        const onPay = vi.fn();

        render(<SendBeforePayDialog onSend={onSend} onPay={onPay} />);
        await userEvent.click(screen.getByRole('button', { name: /Back/i }));

        expect(onSend).not.toHaveBeenCalled();
        expect(onPay).not.toHaveBeenCalled();
        expect(useUiStore.getState().dialog).toBeNull();
    });
});

/**
 * BAN-434 / REG-209 — the fast-payment wiring.
 *
 * The verdict is unit-tested in `domain/fast-payment.test.ts`; what needs a DOM is that the button
 * is wired to it. The precedent is right above: the interesting RST-143 bug was never in the
 * predicate, it was in a handler that navigated without waiting.
 */
describe('fast payment (REG-209)', () => {
    beforeEach(() => {
        resetRegisterState();
        configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });
        useUiStore.setState({ dialog: null });
    });

    it('shows no fast buttons when the flag is off', async () => {
        install(false);
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);
        addLine({ orderUuid: uuid, variantId: VARIANT });

        panel();

        expect(screen.queryByTestId('fast-payment')).toBeNull();
    });

    it('settles a counter sale in one tap without going to the payment screen', async () => {
        install(false, FAST_CASH);
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);
        addLine({ orderUuid: uuid, variantId: VARIANT });

        const onFastPaid = vi.fn();
        const onPay = vi.fn();
        panel({ onFastPaid, onPay });

        await userEvent.click(within(screen.getByTestId('fast-payment')).getByRole('button', { name: /Espèces/i }));

        expect(onFastPaid).toHaveBeenCalledOnce();
        expect(onPay).not.toHaveBeenCalled();
    });

    it('leaves the order paid in full, not part-tendered', async () => {
        // A one-tap button that adds the wrong amount settles the order short and the session
        // counts over — the failure would be silent on the screen and loud at the close.
        install(false, FAST_CASH);
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);
        addLine({ orderUuid: uuid, variantId: VARIANT });

        panel();
        await userEvent.click(within(screen.getByTestId('fast-payment')).getByRole('button', { name: /Espèces/i }));

        const payments = paymentsOf(useOrderStore.getState(), uuid);

        // 10.00 plus 20 % tax — the tax-inclusive total, which is what the customer hands over.
        expect(payments).toHaveLength(1);
        expect(payments[0]?.amount).toBe('12.00');
    });

    it('asks about unsent kitchen changes before settling a table (RST-143)', async () => {
        // Fast payment is the easiest possible way to settle for food the kitchen never heard
        // about, so it must run the same gate Pay does rather than skipping past it.
        install(true, FAST_CASH);
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);
        addLine({ orderUuid: uuid, variantId: VARIANT });

        const onFastPaid = vi.fn();
        panel({ onFastPaid });

        await userEvent.click(within(screen.getByTestId('fast-payment')).getByRole('button', { name: /Espèces/i }));

        expect(onFastPaid).not.toHaveBeenCalled();
        expect(useUiStore.getState().dialog?.kind).toBe('sendBeforePay');
    });

    it('settles a table once the kitchen has everything', async () => {
        install(true, FAST_CASH);
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);
        addLine({ orderUuid: uuid, variantId: VARIANT });
        markPrepSent(uuid);

        const onFastPaid = vi.fn();
        panel({ onFastPaid });

        await userEvent.click(within(screen.getByTestId('fast-payment')).getByRole('button', { name: /Espèces/i }));

        expect(onFastPaid).toHaveBeenCalledOnce();
    });

    it('never offers a terminal method as a one-tap button', async () => {
        install(false, { ...FAST_CASH, fast_payment_method_ids: [1, 2] });
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);
        addLine({ orderUuid: uuid, variantId: VARIANT });

        panel();

        const fast = within(screen.getByTestId('fast-payment'));

        expect(fast.getByRole('button', { name: /Espèces/i })).toBeTruthy();
        expect(fast.queryByRole('button', { name: /Carte/i })).toBeNull();
    });
});
