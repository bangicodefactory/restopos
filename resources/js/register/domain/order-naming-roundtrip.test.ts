/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    configureOrderActions,
    createOrder,
    hydrateOrders,
    refreshOrderName,
    renameOrder,
    setTable,
} from './order-actions';
import { installCatalog, makeFloor, makeProduct, makeTable, makeVariant, resetRegisterState } from './__fixtures__/catalog';
import { useOrderStore } from '../state/order-store';

/**
 * RST-140 (BAN-467, review of #69) — the name has to survive the round trip.
 *
 * Two ways it did not:
 *
 *  - **A server table action left the old name.** `transferOrder` posts and reloads; the server does
 *    not compute names, it stores whatever was last pushed. So moving a bill from table 5 to table 7
 *    came back still called `T 5` — on the ticket screen, the receipt and every other till.
 *  - **The manual flag was dropped by a hydrate.** `order_name_manual` is local-only, so a wholesale
 *    row replace lost it. The *name* survived, because it syncs; the fact that a human chose it did
 *    not, and the next table move re-derived straight over "Birthday party".
 */

const PIZZA = 101;
const T5 = 5;
const T7 = 7;

beforeEach(() => {
    resetRegisterState();
    installCatalog({
        products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00' })],
        variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
        floors: [makeFloor({ id: 1 })],
        tables: [
            makeTable({ id: T5, floor_id: 1, table_number: '5' }),
            makeTable({ id: T7, floor_id: 1, table_number: '7' }),
        ],
    });
    configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });
});

const nameOf = (uuid: string): string | null | undefined =>
    useOrderStore.getState().orders[uuid]?.floating_order_name;

describe('re-deriving after a table action', () => {
    it('renames the order when it lands on another table', async () => {
        const uuid = await createOrder({ tableId: T5 });
        expect(nameOf(uuid)).toBe('T 5');

        setTable(uuid, T7);

        expect(nameOf(uuid)).toBe('T 7');
    });

    it('re-derives on demand, which is what a server transfer needs', async () => {
        // The API path reloads from the server and the server does not compute names, so the reload
        // brings back the *previous* table's name. `refreshOrderName` is what puts it right.
        const uuid = await createOrder({ tableId: T5 });

        // Exactly what the reload brings back: the new table, the old name.
        const fromServer = { ...useOrderStore.getState().orders[uuid]!, restaurant_table_id: T7 };
        hydrateOrders({ orders: [fromServer], lines: [], payments: [], courses: [] });

        expect(nameOf(uuid)).toBe('T 5');

        refreshOrderName(uuid);

        expect(nameOf(uuid)).toBe('T 7');
    });
});

describe('a name the cashier typed', () => {
    it('survives a table move', async () => {
        const uuid = await createOrder({ tableId: T5 });
        renameOrder(uuid, 'Birthday party');

        setTable(uuid, T7);

        expect(nameOf(uuid)).toBe('Birthday party');
    });

    it('survives a hydrate, which drops the local-only flag', async () => {
        // The defect: `order_name_manual` is not returned by the server, so replacing the row
        // wholesale lost it — and the very next table move re-derived over the typed name.
        const uuid = await createOrder({ tableId: T5 });
        renameOrder(uuid, 'Birthday party');

        const fromServer = { ...useOrderStore.getState().orders[uuid]! };
        delete (fromServer as { order_name_manual?: boolean }).order_name_manual;

        hydrateOrders({ orders: [fromServer], lines: [], payments: [], courses: [] });
        setTable(uuid, T7);

        expect(nameOf(uuid)).toBe('Birthday party');
    });

    it('gives the derived name back when it is cleared', async () => {
        const uuid = await createOrder({ tableId: T5 });
        renameOrder(uuid, 'Birthday party');

        renameOrder(uuid, '');

        expect(nameOf(uuid)).toBe('T 5');
    });
});
