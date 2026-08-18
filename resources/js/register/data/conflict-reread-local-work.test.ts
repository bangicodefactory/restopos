/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installCatalog, makeProduct, makeVariant, resetRegisterState } from '../domain/__fixtures__/catalog';
import { addLine, configureOrderActions, createOrder, hydrateOrders, markSyncState } from '../domain/order-actions';
import { linesOf, useOrderStore } from '../state/order-store';

/**
 * REG-372 (BAN-474, review of #68) — a re-read must not swallow work the server has not seen.
 *
 * `toClientRows` stamps a fetched order `synced`, reasoning that a fetched order is by definition
 * synced. True of the server's *content*, and false the moment local work is still attached: a line
 * the waiter typed while the order was in conflict survives the hydrate, because nothing deletes
 * rows the server did not mention.
 *
 * Left marked `synced`, that line is never pushed. It sits on screen looking rung up while the
 * kitchen, the bill and every other till know nothing about it — silent divergence, which this
 * codebase treats as worse than an error.
 *
 * These pin the *rule*: an order carrying an unacknowledged line is not clean.
 */

const PIZZA = 101;

/** What `rereadOrder` does after hydrating, extracted so it can be asserted without a network. */
function settleAfterReread(orderUuid: string): void {
    const unacked = linesOf(useOrderStore.getState(), orderUuid).some((line) => line.id === null);

    if (unacked) markSyncState(orderUuid, 'local');
}

beforeEach(() => {
    resetRegisterState();
    installCatalog({
        products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00' })],
        variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
    });
    configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });
});

describe('a re-read over an order with unsynced work', () => {
    it('keeps the line and keeps the order pushable', async () => {
        const uuid = await createOrder();
        addLine({ orderUuid: uuid, variantId: PIZZA, quantity: 2 });

        const server = useOrderStore.getState().orders[uuid]!;

        // The server's copy: same order, none of the local lines.
        hydrateOrders({
            orders: [{ ...server, syncState: 'synced' } as never],
            lines: [],
            payments: [],
            courses: [],
        });
        settleAfterReread(uuid);

        expect(linesOf(useOrderStore.getState(), uuid)).toHaveLength(1);
        // The assertion that matters: not `synced`, so the outbox still has a reason to send it.
        expect(useOrderStore.getState().orders[uuid]?.syncState).not.toBe('synced');
    });

    it('leaves an order clean when the server already has everything', async () => {
        // The ordinary case must not be dirtied, or every re-read would queue a pointless push.
        const uuid = await createOrder();
        addLine({ orderUuid: uuid, variantId: PIZZA, quantity: 2 });

        const state = useOrderStore.getState();
        const server = state.orders[uuid]!;
        const acked = linesOf(state, uuid).map((line) => ({ ...line, id: 41 }));

        hydrateOrders({
            orders: [{ ...server, syncState: 'synced' } as never],
            lines: acked as never,
            payments: [],
            courses: [],
        });
        settleAfterReread(uuid);

        expect(useOrderStore.getState().orders[uuid]?.syncState).toBe('synced');
    });
});
