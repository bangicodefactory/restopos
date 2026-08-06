import { beforeEach, describe, expect, it } from 'vitest';

import {
    installCatalog,
    makeConfig,
    makeProduct,
    makeVariant,
    resetRegisterState,
} from './__fixtures__/catalog';
import {
    addLine,
    addPayment,
    createOrder,
    markPrinted,
    paymentsFrozen,
    removePayment,
    setPaymentAmount,
    validateOrder,
} from './order-actions';
import { useOrderStore } from '../state/order-store';

/**
 * BAN-410 / REG-218 — the till's half of settled-order immutability.
 *
 * The server refuses these regardless; this exists so a cashier is told *before* tapping, rather
 * than watching a completed sale come back rejected. The trigger that matters is the print: once a
 * receipt is in the customer's hand, the paper and the database have to agree, and restating a €40
 * cash tender as €30 afterwards is precisely the skim the server-side guard exists for.
 */

const PIZZA = 101;
const CASH = 1;

function state() {
    return useOrderStore.getState();
}

beforeEach(() => {
    resetRegisterState();
    installCatalog({
        config: makeConfig(),
        products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00' })],
        variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
    });
});

async function tendered(): Promise<{ orderUuid: string; paymentUuid: string }> {
    const orderUuid = await createOrder({ tableId: 1 });
    addLine({ orderUuid, variantId: PIZZA, quantity: 1 });
    const paymentUuid = addPayment(orderUuid, CASH, '10.00');

    return { orderUuid, paymentUuid };
}

describe('paymentsFrozen', () => {
    it('leaves an untouched draft open', async () => {
        const { orderUuid } = await tendered();

        expect(paymentsFrozen(state().orders[orderUuid])).toBe(false);
    });

    it('freezes once the receipt has printed', async () => {
        const { orderUuid } = await tendered();

        markPrinted(orderUuid);

        expect(paymentsFrozen(state().orders[orderUuid])).toBe(true);
    });

    it('freezes once the order is paid, printed or not', async () => {
        // Through `validateOrder`, which is the path the payment screen actually takes — a test that
        // set `state` by hand would pass even if validation stopped setting it.
        const { orderUuid } = await tendered();

        validateOrder(orderUuid);

        expect(paymentsFrozen(state().orders[orderUuid])).toBe(true);
    });

    it('says nothing about an order it cannot see', () => {
        // A missing order is not a frozen one: reporting `true` here would disable the pad on a
        // screen that simply has not loaded yet.
        expect(paymentsFrozen(null)).toBe(false);
        expect(paymentsFrozen(undefined)).toBe(false);
    });
});

describe('the mutators themselves', () => {
    it('refuses to restate an amount after the receipt printed', async () => {
        // The guard has to sit in the action, not only in the button. A screen that forgets to
        // disable its own control is exactly how this comes back.
        const { orderUuid, paymentUuid } = await tendered();

        markPrinted(orderUuid);
        setPaymentAmount(paymentUuid, '3.00');

        expect(state().payments[paymentUuid]?.amount).toBe('10.00');
    });

    it('refuses to remove a payment after the receipt printed', async () => {
        const { orderUuid, paymentUuid } = await tendered();

        markPrinted(orderUuid);
        removePayment(paymentUuid);

        expect(state().payments[paymentUuid]).toBeDefined();
    });

    it('still lets an amount be corrected before the sale is validated', async () => {
        // The window that legitimately remains, and the one a cashier uses constantly: fixing a
        // mistyped tender before validating.
        const { paymentUuid } = await tendered();

        setPaymentAmount(paymentUuid, '20.00');

        expect(state().payments[paymentUuid]?.amount).toBe('20.00');
    });

    it('still lets a payment be removed before the sale is validated', async () => {
        const { paymentUuid } = await tendered();

        removePayment(paymentUuid);

        expect(state().payments[paymentUuid]).toBeUndefined();
    });
});
