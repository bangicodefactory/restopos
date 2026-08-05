/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    installCatalog,
    makeConfig,
    makeProduct,
    makeTax,
    makeVariant,
    resetRegisterState,
} from '../domain/__fixtures__/catalog';
import { addLine, configureOrderActions, createOrder, markPrepSent } from '../domain/order-actions';
import { useOrderStore } from '../state/order-store';
import { useUiStore } from '../state/ui-store';
import { OrderTabs } from './OrderTabs';

/**
 * REG-125 restores the screen an order was left on — but not back into payment while the kitchen
 * is still owed items, which would step straight past the send-first prompt (RST-143).
 */
const TAX = makeTax({ id: 1, amount: '20', tax_group_id: 1 });
const VARIANT = 101;

describe('OrderTabs screen restoration', () => {
    beforeEach(() => {
        resetRegisterState();
        configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });
        installCatalog({
            config: makeConfig({ is_restaurant: false }),
            taxes: [TAX],
            products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00', tax_ids: [TAX.id] })],
            variants: [makeVariant({ id: VARIANT, product_id: 1, display_name: 'Pizza' })],
        });
        useUiStore.setState({ screen: 'products' });
    });

    /** A tab left on the payment screen, with `unsent` items or without. */
    async function tabLeftOnPayment({ unsent }: { unsent: boolean }): Promise<string> {
        const uuid = await createOrder();
        useOrderStore.getState().selectOrder(uuid);
        addLine({ orderUuid: uuid, variantId: VARIANT });
        if (!unsent) markPrepSent(uuid);

        useUiStore.getState().setScreen('payment');
        useOrderStore.getState().selectOrder(null);
        useUiStore.setState({ screen: 'products' });

        return uuid;
    }

    it('returns to payment when the kitchen has everything', async () => {
        await tabLeftOnPayment({ unsent: false });

        render(<OrderTabs />);
        await userEvent.click(screen.getAllByRole('button')[0]!);

        expect(useUiStore.getState().screen).toBe('payment');
    });

    it('lands on the order screen instead when items are still unsent', async () => {
        await tabLeftOnPayment({ unsent: true });

        render(<OrderTabs />);
        await userEvent.click(screen.getAllByRole('button')[0]!);

        // Restoring into payment would bypass the send-first prompt entirely — the cashier would
        // never see the unsent count, which is the whole point of asking.
        expect(useUiStore.getState().screen).toBe('products');
    });
});
