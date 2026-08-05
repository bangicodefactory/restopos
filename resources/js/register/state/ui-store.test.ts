import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installCatalog, makeConfig, resetRegisterState } from '../domain/__fixtures__/catalog';
import { configureOrderActions, createOrder } from '../domain/order-actions';
import { useOrderStore } from './order-store';
import { useUiStore } from './ui-store';

/**
 * REG-125 — the per-order screen.
 *
 * `orderScreen` was declared on the store, read by the order tabs and cleared by `forgetOrder`, but
 * nothing ever wrote it — so the documented "a mid-payment reload does not lose context" never
 * happened. It now lives on the order row, which is what makes it survive the reload: it goes to
 * IndexedDB with the order instead of sitting in a memory-only map beside it.
 */
describe('orderScreen', () => {
    let persist: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        resetRegisterState();
        installCatalog({ config: makeConfig() });
        persist = vi.fn();
        configureOrderActions({ enqueue: vi.fn(), persist, onChange: vi.fn() });
        useUiStore.getState().setScreen('products');
    });

    const orderOf = (uuid: string) => useOrderStore.getState().orders[uuid];

    it('records the screen against the selected order', async () => {
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);

        useUiStore.getState().setScreen('payment');

        expect(orderOf(uuid)?.orderScreen).toBe('payment');
    });

    it('persists the change, so it reaches IndexedDB rather than only memory', async () => {
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);
        persist.mockClear();

        useUiStore.getState().setScreen('payment');

        expect(persist).toHaveBeenCalledWith(uuid);
    });

    it('restores the screen a reloaded order was left on', async () => {
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);
        useUiStore.getState().setScreen('payment');

        // What a reload looks like: the order row comes back from IndexedDB, the UI store does not.
        const restored = orderOf(uuid);
        useUiStore.setState({ screen: 'products' });

        expect(restored?.orderScreen).toBe('payment');
    });

    it('does not record the register-wide screens against an order', async () => {
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);
        useUiStore.getState().setScreen('payment');

        // The floor plan and the ticket list are views of the register, not places an order sits;
        // recording them would send the cashier back to the floor when they reopened a tab.
        useUiStore.getState().setScreen('floor');
        expect(orderOf(uuid)?.orderScreen).toBe('payment');

        useUiStore.getState().setScreen('tickets');
        expect(orderOf(uuid)?.orderScreen).toBe('payment');
    });

    it('does nothing when no order is selected', () => {
        useOrderStore.getState().selectOrder(null);
        persist.mockClear();

        useUiStore.getState().setScreen('payment');

        expect(persist).not.toHaveBeenCalled();
    });

    it('does not re-persist when the screen has not changed', async () => {
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);
        useUiStore.getState().setScreen('payment');
        persist.mockClear();

        useUiStore.getState().setScreen('payment');

        expect(persist).not.toHaveBeenCalled();
    });
});
