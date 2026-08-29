import { beforeEach, expect, it, vi } from 'vitest';

import { installCatalog, makeProduct, makeVariant, resetRegisterState } from './__fixtures__/catalog';
import { addLine, commitPaidOrder, createOrder } from './order-actions';
import { useSyncStore } from '../state/boot-store';
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

/*
| BAN-402 — the same window, seen by the delta scheduler.
|
| The periodic pull defers while a payment is in flight, because a delta landing between "paid" and
| "flushed" rewrites the very rows this function is persisting. That only works if the flag is
| actually raised for the whole window and actually lowered afterwards, including when the flush
| throws — a flag left raised stops the till pulling deltas for the rest of the shift.
*/

it('raises the payment-in-flight flag for the whole durability window', async () => {
    const seen: boolean[] = [];
    const durability = {
        flushNow: vi.fn(async () => {
            seen.push(useSyncStore.getState().paymentInFlight);
            return true;
        }),
        drain: vi.fn(async () => {
            seen.push(useSyncStore.getState().paymentInFlight);
        }),
    };

    const orderUuid = await createOrder({ tableId: 1 });
    addLine({ orderUuid, variantId: PIZZA, quantity: 1 });

    expect(useSyncStore.getState().paymentInFlight).toBe(false);
    await commitPaidOrder(orderUuid, durability);

    expect(seen).toEqual([true, true]);
    expect(useSyncStore.getState().paymentInFlight).toBe(false);
});

it('lowers the flag even when the flush throws', async () => {
    const durability = {
        flushNow: vi.fn(async () => {
            throw new Error('quota exceeded');
        }),
        drain: vi.fn(async () => {}),
    };

    const orderUuid = await createOrder({ tableId: 1 });
    addLine({ orderUuid, variantId: PIZZA, quantity: 1 });

    await expect(commitPaidOrder(orderUuid, durability)).rejects.toThrow('quota exceeded');
    expect(useSyncStore.getState().paymentInFlight).toBe(false);
});
