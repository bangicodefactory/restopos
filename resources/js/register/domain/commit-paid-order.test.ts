import { beforeEach, expect, it, vi } from 'vitest';

import { installCatalog, makeProduct, makeVariant, resetRegisterState } from './__fixtures__/catalog';
import { addLine, commitPaidOrder, createOrder } from './order-actions';
import { useOrderStore } from '../state/order-store';

/**
 * REG-217 / BAN-423 — the payment-validate durability sequence. This guards the *wiring* the
 * PaymentScreen relies on (which has no render-test harness): validate, then force the sale to disk
 * before draining to the network, and report a failed local write instead of swallowing it.
 */

const PIZZA = 101;

beforeEach(() => {
    resetRegisterState();
    installCatalog({
        products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00' })],
        variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
    });
});

it('validates, flushes to disk, then drains — in that order (REG-217)', async () => {
    const calls: string[] = [];
    const durability = {
        flushNow: vi.fn(async () => {
            calls.push('flush');
            return true;
        }),
        drain: vi.fn(async () => {
            calls.push('drain');
        }),
    };

    const orderUuid = await createOrder({ tableId: 1 });
    addLine({ orderUuid, variantId: PIZZA, quantity: 1 });

    const flushed = await commitPaidOrder(orderUuid, durability);

    expect(useOrderStore.getState().orders[orderUuid]?.state).toBe('paid');
    // Local durability strictly before the network push — never the reverse.
    expect(calls).toEqual(['flush', 'drain']);
    expect(flushed).toBe(true);
});

it('reports the failed local write but still drains to the server as a fallback', async () => {
    const calls: string[] = [];
    const durability = {
        flushNow: vi.fn(async () => {
            calls.push('flush');
            return false;
        }),
        drain: vi.fn(async () => {
            calls.push('drain');
        }),
    };

    const orderUuid = await createOrder({ tableId: 1 });
    addLine({ orderUuid, variantId: PIZZA, quantity: 1 });

    const flushed = await commitPaidOrder(orderUuid, durability);

    expect(flushed).toBe(false);
    // The drain runs even when the local write failed, so the sale still reaches the server.
    expect(calls).toEqual(['flush', 'drain']);
});

it('still validates when no runtime is available', async () => {
    const orderUuid = await createOrder({ tableId: 1 });
    addLine({ orderUuid, variantId: PIZZA, quantity: 1 });

    const flushed = await commitPaidOrder(orderUuid, null);

    expect(flushed).toBe(true);
    expect(useOrderStore.getState().orders[orderUuid]?.state).toBe('paid');
});
