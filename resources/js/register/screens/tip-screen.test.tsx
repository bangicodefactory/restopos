/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRuntime } from '../data/runtime';
import { installCatalog, makeConfig, makeProduct, makeVariant, resetRegisterState } from '../domain/__fixtures__/catalog';
import { addLine, configureOrderActions, createOrder } from '../domain/order-actions';
import { useOrderStore } from '../state/order-store';
import { getCatalog } from '../data/catalog';
import { PaymentScreen } from './PaymentScreen';
import { TipScreen } from './TipScreen';

/**
 * RST-123, RST-127 (BAN-522) — the tip screen and the shift pass.
 *
 * The confirmation is the reason this screen exists rather than a cell on the ticket list. A tip is
 * entered on a settled sale from a signed slip, so the realistic mistake is a decimal point — and a
 * mistyped tip balances: the tender is topped up, the order reconciles, and nothing downstream can
 * tell. This is the last place it can be caught, so these check it is caught *and* that it does not
 * fire on the ordinary amounts, which would train everyone to tap through it.
 */

const PIZZA = 101;
const TIP = 900;

function install(tips = true): void {
    installCatalog({
        config: makeConfig({ is_restaurant: true, enable_tips: tips }),
        products: [
            makeProduct({ id: 1, name: 'Pizza', list_price: '20.00' }),
            makeProduct({ id: 9, name: 'Tip', list_price: '0.00', special_kind: 'tip' }),
        ],
        variants: [
            makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' }),
            makeVariant({ id: TIP, product_id: 9, display_name: 'Tip' }),
        ],
    });
}

/** A settled 20.00 sale, which is what a tip is entered against. */
async function settledOrder(): Promise<string> {
    const orderUuid = await createOrder({});
    addLine({ orderUuid, variantId: PIZZA, quantity: 1, priceUnit: '20.00' });

    const before = useOrderStore.getState().orders[orderUuid]!;
    useOrderStore.setState({
        orders: { ...useOrderStore.getState().orders, [orderUuid]: { ...before, state: 'paid' } },
    } as never);

    return orderUuid;
}

beforeEach(() => {
    clearRuntime();
    resetRegisterState();
    install();
    configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });
});

describe('one order', () => {
    it('applies an ordinary tip without asking', async () => {
        const orderUuid = await settledOrder();
        const onDone = vi.fn();

        render(<TipScreen orderUuid={orderUuid} onDone={onDone} />);

        fireEvent.change(screen.getByTestId('tip-amount'), { target: { value: '4.00' } });
        fireEvent.click(screen.getByTestId('tip-apply'));

        await waitFor(() => expect(onDone).toHaveBeenCalled());

        expect(useOrderStore.getState().orders[orderUuid]?.tip_amount).toBe('4.00');
    });

    it('works out a preset from the bill', async () => {
        const orderUuid = await settledOrder();
        render(<TipScreen orderUuid={orderUuid} onDone={vi.fn()} />);

        fireEvent.click(screen.getByTestId('tip-preset-20'));

        expect((screen.getByTestId('tip-amount') as HTMLInputElement).value).toBe('4.00');
    });

    it('never asks about its own presets, which would train everyone to tap through', async () => {
        const orderUuid = await settledOrder();
        render(<TipScreen orderUuid={orderUuid} onDone={vi.fn()} />);

        fireEvent.click(screen.getByTestId('tip-preset-25'));
        fireEvent.click(screen.getByTestId('tip-apply'));

        expect(screen.queryByTestId('tip-confirm')).toBeNull();
    });

    it('asks before applying a tip larger than a quarter of the bill', async () => {
        const orderUuid = await settledOrder();
        const onDone = vi.fn();

        render(<TipScreen orderUuid={orderUuid} onDone={onDone} />);

        // The decimal point: 18.00 on a 20.00 bill.
        fireEvent.change(screen.getByTestId('tip-amount'), { target: { value: '18.00' } });
        fireEvent.click(screen.getByTestId('tip-apply'));

        expect(screen.getByTestId('tip-confirm')).toBeTruthy();

        // Nothing has been written yet, and the screen has not moved on.
        expect(useOrderStore.getState().orders[orderUuid]?.tip_amount).not.toBe('18.00');
        expect(onDone).not.toHaveBeenCalled();
    });

    it('applies it once confirmed — unusual is not impossible', async () => {
        // A till that simply refused would leave the waiter holding a signed slip they cannot honour.
        const orderUuid = await settledOrder();

        render(<TipScreen orderUuid={orderUuid} onDone={vi.fn()} />);

        fireEvent.change(screen.getByTestId('tip-amount'), { target: { value: '18.00' } });
        fireEvent.click(screen.getByTestId('tip-apply'));
        fireEvent.click(screen.getByTestId('tip-confirm-yes'));

        await waitFor(() => expect(useOrderStore.getState().orders[orderUuid]?.tip_amount).toBe('18.00'));
    });

    it('drops the confirmation when the amount is edited, so it cannot approve a different number', async () => {
        // The dangerous version of this: ask about 18.00, the waiter fixes it to 1.80, and the
        // pending "yes" applies to whatever is in the box now.
        const orderUuid = await settledOrder();

        render(<TipScreen orderUuid={orderUuid} onDone={vi.fn()} />);

        fireEvent.change(screen.getByTestId('tip-amount'), { target: { value: '18.00' } });
        fireEvent.click(screen.getByTestId('tip-apply'));
        expect(screen.getByTestId('tip-confirm')).toBeTruthy();

        fireEvent.change(screen.getByTestId('tip-amount'), { target: { value: '1.80' } });

        expect(screen.queryByTestId('tip-confirm')).toBeNull();
    });

    it('refuses to act on something that is not an amount', async () => {
        const orderUuid = await settledOrder();
        render(<TipScreen orderUuid={orderUuid} onDone={vi.fn()} />);

        fireEvent.change(screen.getByTestId('tip-amount'), { target: { value: 'abc' } });

        expect(screen.getByTestId('tip-apply').closest('button')?.hasAttribute('disabled')).toBe(true);
    });
});

describe('the shift pass', () => {
    it('lists every settled order still owing a tip', async () => {
        await settledOrder();
        await settledOrder();

        render(<TipScreen onDone={vi.fn()} />);

        expect(screen.getAllByTestId('tip-grid-row')).toHaveLength(2);
    });

    it('says so when there is nothing left to settle', () => {
        render(<TipScreen onDone={vi.fn()} />);

        expect(screen.getByTestId('tip-grid-empty')).toBeTruthy();
    });

    it('takes a row out of the list once it is settled', async () => {
        const orderUuid = await settledOrder();

        render(<TipScreen onDone={vi.fn()} />);

        const row = screen.getByTestId('tip-grid-row');
        fireEvent.change(row.querySelector('input')!, { target: { value: '3.00' } });
        fireEvent.click(row.querySelector('button')!);

        await waitFor(() => expect(useOrderStore.getState().orders[orderUuid]?.tip_amount).toBe('3.00'));
        expect(screen.queryByTestId('tip-grid-row')).toBeNull();
    });

    it('asks about a large tip here too, not only on the single-order screen', async () => {
        // The grid is where a stack of slips is worked through quickly, which is exactly where a
        // decimal point slips.
        const orderUuid = await settledOrder();

        render(<TipScreen onDone={vi.fn()} />);

        const row = screen.getByTestId('tip-grid-row');
        fireEvent.change(row.querySelector('input')!, { target: { value: '18.00' } });
        fireEvent.click(row.querySelector('button')!);

        expect(screen.getByTestId('tip-grid-confirm')).toBeTruthy();
        expect(useOrderStore.getState().orders[orderUuid]?.tip_amount).not.toBe('18.00');
    });

    it('applies it on the second press', async () => {
        const orderUuid = await settledOrder();

        render(<TipScreen onDone={vi.fn()} />);

        const row = screen.getByTestId('tip-grid-row');
        fireEvent.change(row.querySelector('input')!, { target: { value: '18.00' } });
        fireEvent.click(row.querySelector('button')!);
        fireEvent.click(row.querySelector('button')!);

        await waitFor(() => expect(useOrderStore.getState().orders[orderUuid]?.tip_amount).toBe('18.00'));
    });
});

describe('when the venue does not take tips', () => {
    it('shows nothing to enter one with', async () => {
        resetRegisterState();
        install(false);
        configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });

        render(<TipScreen onDone={vi.fn()} />);

        expect(screen.queryByTestId('tip-screen')).toBeNull();
    });
});

describe('getting to the screen at all', () => {
    /**
     * RST-122 — the mode's whole point is that settling is not the end of the tab, and the button
     * has to say so. Probed while reviewing #75: the screen was routed and **nothing navigated to
     * it**, so none of the above was reachable by anybody.
     */
    it('calls the settle button "Close tab" in tip-after-payment mode', async () => {
        resetRegisterState();
        installCatalog({
            config: makeConfig({ is_restaurant: true, enable_tips: true, tip_after_payment: true }),
            products: [makeProduct({ id: 1, name: 'Pizza', list_price: '20.00' })],
            variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
        });
        configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });

        const orderUuid = await createOrder({});
        addLine({ orderUuid, variantId: PIZZA, quantity: 1, priceUnit: '20.00' });

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);

        expect(screen.getByTestId('payment-validate').textContent).toContain('Close tab');
    });

    it('still says "Validate" where the tab really does end at payment', async () => {
        // The control: the relabelling must not leak into an ordinary counter register, where
        // "Close tab" would describe something that is not happening.
        const orderUuid = await createOrder({});
        addLine({ orderUuid, variantId: PIZZA, quantity: 1, priceUnit: '20.00' });

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);

        expect(screen.getByTestId('payment-validate').textContent).toContain('Validate');
    });

    it('does not relabel when tips are off, whatever the mode flag says', async () => {
        // The combination that separates the two flags. A venue that does not tip at all can still
        // carry `tip_after_payment` from a config copied off another register, and "Close tab" there
        // describes a tab that ends right now — a sabotage dropping `enable_tips` from the check
        // passed until this case existed (review of #75).
        resetRegisterState();
        installCatalog({
            config: makeConfig({ is_restaurant: true, enable_tips: false, tip_after_payment: true }),
            products: [makeProduct({ id: 1, name: 'Pizza', list_price: '20.00' })],
            variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
        });
        configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });

        const orderUuid = await createOrder({});
        addLine({ orderUuid, variantId: PIZZA, quantity: 1, priceUnit: '20.00' });

        render(<PaymentScreen orderUuid={orderUuid} onValidated={vi.fn()} onBack={vi.fn()} />);

        expect(screen.getByTestId('payment-validate').textContent).toContain('Validate');
    });

    it('reads both flags, so tipping-off means tipping-off', () => {
        resetRegisterState();
        installCatalog({
            config: makeConfig({ is_restaurant: true, enable_tips: false, tip_after_payment: true }),
            products: [makeProduct({ id: 1, name: 'Pizza', list_price: '20.00' })],
            variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
        });

        expect(getCatalog().config?.enable_tips).toBe(false);

        render(<TipScreen onDone={vi.fn()} />);

        expect(screen.queryByTestId('tip-screen')).toBeNull();
    });
});
