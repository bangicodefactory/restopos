/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getCatalog } from '../data/catalog';
import { clearRuntime } from '../data/runtime';
import { installCatalog, makeConfig, makeProduct, makeVariant, resetRegisterState } from '../domain/__fixtures__/catalog';
import { canOpenOrder } from '../domain/foreign-order';
import { addLine, configureOrderActions, createOrder } from '../domain/order-actions';
import { draftOrders, useOrderStore } from '../state/order-store';
import { OrderTabs } from './OrderTabs';

/**
 * REG-373 (BAN-523) — the ways into a bill this till cannot open.
 *
 * The guard first lived on the ticket screen's open button alone. There are **three** ways to reach
 * an order — that list, the floor plan and the tab bar — and probing found a foreign-currency bill
 * sitting in the tab bar and opening from a table tap. A guard on one caller is a guard one caller
 * has, which is the lesson this codebase keeps paying for.
 *
 * The tab bar filters instead of refusing: it is this till's work in progress, and a tab that exists
 * to be tapped and apologised for is worse than one that is not there. The ticket screen still lists
 * it, because that is where the message can say which register to use.
 */

const PIZZA = 101;
const HOME = 1;
const OTHER_CURRENCY = 2;

function install(): void {
    installCatalog({
        config: makeConfig({
            id: HOME,
            currency_id: 10,
            trusted_configs: [
                { id: OTHER_CURRENCY, name: 'Duty Free', currency_id: 20 },
                { id: 3, name: 'Terrace', currency_id: 10 },
            ],
        }),
        products: [makeProduct({ id: 1, name: 'Pizza', list_price: '20.00' })],
        variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
    });
}

/** An open bill, optionally re-stamped as a peer's the way the delta delivers one. */
async function bill(configId: number): Promise<string> {
    const uuid = await createOrder({});
    addLine({ orderUuid: uuid, variantId: PIZZA, quantity: 1 });

    const before = useOrderStore.getState().orders[uuid]!;
    useOrderStore.setState({
        orders: { ...useOrderStore.getState().orders, [uuid]: { ...before, pos_config_id: configId } },
    } as never);

    return uuid;
}

beforeEach(() => {
    clearRuntime();
    resetRegisterState();
    install();
    configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });
});

describe('the tab bar', () => {
    it('leaves out a bill in another currency', async () => {
        // Probed before the fix: it was there, and tapping it opened the bill.
        const foreign = await bill(OTHER_CURRENCY);

        render(<OrderTabs />);

        // Asserted on the tabs themselves. Matching on the uuid finds nothing either way — a tab
        // renders the order's *name* — so the first version of this passed with the filter removed.
        expect(screen.queryAllByTestId('order-tab')).toHaveLength(0);
        expect(canOpenOrder(useOrderStore.getState().orders[foreign]!, getCatalog().config)).toBe(false);
    });

    it('keeps this register own bills', async () => {
        await bill(HOME);

        render(<OrderTabs />);

        expect(screen.getAllByTestId('order-tab')).toHaveLength(1);
    });

    it('keeps a peer on the same currency, which is what trusting one is for', async () => {
        await bill(HOME);
        await bill(3);
        await bill(OTHER_CURRENCY);

        render(<OrderTabs />);

        // Two of the three: the local bill and the same-currency peer.
        expect(screen.getAllByTestId('order-tab')).toHaveLength(2);
    });
});

describe('what the store still holds', () => {
    it('keeps the foreign bill, so the ticket screen can explain it', async () => {
        // Filtered from the tab bar, not dropped: the ticket screen lists it with a message naming
        // the register to use instead.
        const foreign = await bill(OTHER_CURRENCY);

        expect(draftOrders(useOrderStore.getState()).some((order) => order.uuid === foreign)).toBe(true);
    });
});
