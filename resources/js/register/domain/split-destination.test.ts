/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRuntime, setRuntime } from '../data/runtime';
import { coursesOf, linesOf, useOrderStore } from '../state/order-store';
import { installCatalog, makeFloor, makeProduct, makeTable, makeVariant, resetRegisterState } from './__fixtures__/catalog';
import { addLine, configureOrderActions, createOrder, prepKeyOf, setTable } from './order-actions';
import { destinationFor, splitOntoTable } from './split-destination';

/**
 * RST-106 (BAN-521) — splitting a bill *onto* another table.
 *
 * Four guests move to the bar while the rest of the table eats on. Until now the waiter could split
 * the lines off and then had nowhere to put the result: `splitOrder` always leaves the new bill
 * floating, because a split would otherwise share its parent's table and break one-draft-per-table.
 *
 * The rule that matters is which of the two mechanisms a destination needs. A free table is a local
 * seat and works with no connection; a table that already has a bill is a **merge**, and merges are
 * the server's — only it can record the merge so it can be undone and carry the kitchen's
 * already-sent snapshot across (BAN-437).
 */

const PIZZA = 101;
const T1 = 1;
const T2 = 2;
const T3 = 3;

function draft(uuid: string, tableId: number | null) {
    return { uuid, restaurant_table_id: tableId };
}

beforeEach(() => {
    clearRuntime();
    resetRegisterState();
    installCatalog({
        products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00' })],
        variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
        floors: [makeFloor({ id: 1 })],
        tables: [
            makeTable({ id: T1, floor_id: 1, table_number: '1' }),
            makeTable({ id: T2, floor_id: 1, table_number: '2' }),
            makeTable({ id: T3, floor_id: 1, table_number: '3' }),
        ],
    });
    configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });
});

describe('reading the destination', () => {
    it('is floating when no table was chosen', () => {
        expect(destinationFor(null, [draft('a', T1)], 'split')).toEqual({ kind: 'floating' });
    });

    it('is a plain seat when the table is free', () => {
        expect(destinationFor(T2, [draft('a', T1)], 'split')).toEqual({ kind: 'seat', tableId: T2 });
    });

    it('is a merge when the table already has a bill', () => {
        // Not "seat it anyway and let the unique index decide" — the waiter is told, and the server
        // is the one that does it.
        expect(destinationFor(T1, [draft('a', T1)], 'split')).toEqual({
            kind: 'merge',
            tableId: T1,
            intoUuid: 'a',
        });
    });

    it('does not count the split itself as the occupant', () => {
        // The split is created on its parent's table before it is moved, so it is briefly sitting on
        // the very table being considered. Counting it would turn every destination into a merge
        // with itself.
        expect(destinationFor(T1, [draft('split', T1)], 'split')).toEqual({ kind: 'seat', tableId: T1 });
    });
});

describe('splitting with no destination', () => {
    it('leaves the new bill floating, exactly as before', async () => {
        const parent = await createOrder({ tableId: T1, guestCount: 2 });
        const line = addLine({ orderUuid: parent, variantId: PIZZA, quantity: 2 });

        const outcome = await splitOntoTable(parent, { [line]: 1 }, null, []);

        expect(outcome).not.toBeNull();
        expect(outcome?.tableId).toBeNull();
        expect(useOrderStore.getState().orders[outcome!.orderUuid]?.restaurant_table_id).toBeNull();
        // And the parent keeps its own table.
        expect(useOrderStore.getState().orders[parent]?.restaurant_table_id).toBe(T1);
    });

    it('returns null when nothing was selected, so the caller behaves as it always has', async () => {
        const parent = await createOrder({ tableId: T1, guestCount: 2 });
        addLine({ orderUuid: parent, variantId: PIZZA, quantity: 2 });

        expect(await splitOntoTable(parent, {}, T2, [])).toBeNull();
    });
});

describe('splitting onto a free table', () => {
    it('seats the new bill there', async () => {
        const parent = await createOrder({ tableId: T1, guestCount: 4 });
        const line = addLine({ orderUuid: parent, variantId: PIZZA, quantity: 3 });

        const outcome = await splitOntoTable(parent, { [line]: 2 }, T2, [draft(parent, T1)]);

        expect(outcome?.tableId).toBe(T2);
        expect(outcome?.merged).toBe(false);
        expect(useOrderStore.getState().orders[outcome!.orderUuid]?.restaurant_table_id).toBe(T2);
    });

    it('needs no connection, because seating a free table is a local fact', async () => {
        // No runtime is installed at all in this suite; a call that reached the server would throw.
        const parent = await createOrder({ tableId: T1, guestCount: 4 });
        const line = addLine({ orderUuid: parent, variantId: PIZZA, quantity: 3 });

        await expect(splitOntoTable(parent, { [line]: 1 }, T3, [draft(parent, T1)])).resolves.toMatchObject({
            tableId: T3,
            seatingError: null,
        });
    });

    it('moves the selected lines and leaves the rest on the parent', async () => {
        const parent = await createOrder({ tableId: T1, guestCount: 4 });
        const line = addLine({ orderUuid: parent, variantId: PIZZA, quantity: 3 });

        const outcome = await splitOntoTable(parent, { [line]: 2 }, T2, [draft(parent, T1)]);

        const state = useOrderStore.getState();
        expect(linesOf(state, outcome!.orderUuid).map((l) => l.quantity)).toEqual([2]);
        expect(linesOf(state, parent).map((l) => l.quantity)).toEqual([1]);
    });

    it('carries the kitchen snapshot across, so nothing is re-fired', async () => {
        // The rule BAN-437 established for transfer, and the one a split has to honour too: the new
        // bill's lines were already sent, so the pass must not see them again.
        const parent = await createOrder({ tableId: T1, guestCount: 4 });
        const line = addLine({ orderUuid: parent, variantId: PIZZA, quantity: 2 });

        // Built from the real line rather than a hand-written key: the snapshot is keyed by
        // `prepKey`, and a guessed format would make this pass by moving nothing.
        const key = prepKeyOf(linesOf(useOrderStore.getState(), parent)[0]!);

        const before = useOrderStore.getState().orders[parent]!;
        useOrderStore.setState({
            orders: {
                ...useOrderStore.getState().orders,
                [parent]: {
                    ...before,
                    last_prep_snapshot: { at: '2026-01-01T00:00:00.000Z', lines: { [key]: 2 }, noteHash: '' },
                },
            },
        } as never);

        const outcome = await splitOntoTable(parent, { [line]: 1 }, T2, [draft(parent, T1)]);

        const created = useOrderStore.getState().orders[outcome!.orderUuid];
        expect(created?.prep_state).toBe('sent');
        expect(Object.keys(created?.last_prep_snapshot?.lines ?? {})).not.toHaveLength(0);
    });
});

describe('splitting onto an occupied table', () => {
    function api(behaviour: 'ok' | 'boom' = 'ok') {
        const post = vi.fn(async (path: string, _body?: unknown) => {
            if (behaviour !== 'ok') throw new Error('server refused');

            return { data: { order: { uuid: 'survivor', restaurant_table_id: T2 }, merged: true, merge_id: 9 }, path };
        });

        setRuntime({
            api: { post },
            syncer: { drain: vi.fn(async () => ({ sent: 0, failed: 0 })) },
        } as never);

        return post;
    }

    it('routes the merge through the server rather than seating a second draft', async () => {
        const post = api();
        const parent = await createOrder({ tableId: T1, guestCount: 4 });
        const line = addLine({ orderUuid: parent, variantId: PIZZA, quantity: 3 });

        const other = await createOrder({ tableId: T2, guestCount: 2 });
        setTable(other, T2);

        const outcome = await splitOntoTable(parent, { [line]: 1 }, T2, [draft(parent, T1), draft(other, T2)]);

        expect(post).toHaveBeenCalled();
        expect(String(post.mock.calls[0]?.[0])).toContain('/transfer');
        expect(outcome?.merged).toBe(true);
        // The survivor is what the waiter is sent to, not the bill that was merged away.
        expect(outcome?.orderUuid).toBe('survivor');
    });

    it('keeps the split when the merge fails, and says so', async () => {
        // By this point the money has already moved — the lines are on a new bill and the parent has
        // been decremented. Reporting the whole action as failed would describe a split that
        // definitely happened as one that did not, and the waiter would split again.
        api('boom');
        const parent = await createOrder({ tableId: T1, guestCount: 4 });
        const line = addLine({ orderUuid: parent, variantId: PIZZA, quantity: 3 });

        const other = await createOrder({ tableId: T2, guestCount: 2 });
        setTable(other, T2);

        const outcome = await splitOntoTable(parent, { [line]: 1 }, T2, [draft(parent, T1), draft(other, T2)]);

        expect(outcome).not.toBeNull();
        expect(outcome?.seatingError).not.toBeNull();
        expect(outcome?.tableId).toBeNull();

        // The split itself stands: the lines moved.
        expect(linesOf(useOrderStore.getState(), outcome!.orderUuid).map((l) => l.quantity)).toEqual([1]);
    });

    it('reports offline distinctly, because that one is worth waiting out', async () => {
        clearRuntime();
        const parent = await createOrder({ tableId: T1, guestCount: 4 });
        const line = addLine({ orderUuid: parent, variantId: PIZZA, quantity: 3 });

        const other = await createOrder({ tableId: T2, guestCount: 2 });
        setTable(other, T2);

        const outcome = await splitOntoTable(parent, { [line]: 1 }, T2, [draft(parent, T1), draft(other, T2)]);

        expect(outcome?.seatingError).toBe('offline');
    });
});

describe('what the split keeps', () => {
    it('recreates the courses by index on the seated bill', async () => {
        const parent = await createOrder({ tableId: T1, guestCount: 4 });
        const line = addLine({ orderUuid: parent, variantId: PIZZA, quantity: 2 });

        const outcome = await splitOntoTable(parent, { [line]: 1 }, T2, [draft(parent, T1)]);

        expect(coursesOf(useOrderStore.getState(), outcome!.orderUuid).length).toBe(
            coursesOf(useOrderStore.getState(), parent).length,
        );
    });
});
