import { asUuid } from '@domain/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { linesOf, useOrderStore } from '../state/order-store';
import { installCatalog, makeProduct, makeVariant, resetRegisterState } from './__fixtures__/catalog';
import { makeLine, resetRowSequences } from './__fixtures__/rows';
import { addLine, createOrder, splitOrder } from './order-actions';
import {
    clampSelection,
    cycleSplitQuantity,
    nextSplitLetter,
    splitPrepSnapshot,
    splitPreview,
} from './split';

/** Unit coverage for RST-100 … RST-106 — bill splitting. */

describe('cycleSplitQuantity', () => {
    it.each([
        { current: 0, max: 3, next: 1 },
        { current: 1, max: 3, next: 2 },
        { current: 3, max: 3, next: 0 },
        { current: 0, max: 1, next: 1 },
        { current: 1, max: 1, next: 0 },
    ])('$current of $max → $next', ({ current, max, next }) => {
        expect(cycleSplitQuantity(current, max)).toBe(next);
    });
});

describe('clampSelection', () => {
    beforeEach(resetRowSequences);

    it('caps a selection at the line quantity — a double tap cannot duplicate revenue', () => {
        const line = makeLine({ uuid: asUuid('a'), quantity: 2 });
        expect(clampSelection([line], { a: 5 })).toEqual({ a: 2 });
    });

    it('drops zero and negative selections', () => {
        const line = makeLine({ uuid: asUuid('a'), quantity: 2 });
        expect(clampSelection([line], { a: 0 })).toEqual({});
        expect(clampSelection([line], { a: -1 })).toEqual({});
    });

    it('preserves the sign of a refund line', () => {
        const line = makeLine({ uuid: asUuid('a'), quantity: -2 });
        expect(clampSelection([line], { a: 2 })).toEqual({ a: -2 });
    });

    it('drags a combo child along in proportion to its parent', () => {
        const parent = makeLine({ uuid: asUuid('p'), quantity: 2 });
        const child = makeLine({ uuid: asUuid('c'), quantity: 4, combo_parent_uuid: asUuid('p') });
        expect(clampSelection([parent, child], { p: 1 })).toEqual({ p: 1, c: 2 });
    });

    it('never lets a combo child be selected on its own', () => {
        const parent = makeLine({ uuid: asUuid('p'), quantity: 1 });
        const child = makeLine({ uuid: asUuid('c'), quantity: 1, combo_parent_uuid: asUuid('p') });
        expect(clampSelection([parent, child], { c: 1 })).toEqual({});
    });

    it('still moves an orphaned child whose parent is not in this order', () => {
        const child = makeLine({ uuid: asUuid('c'), quantity: 2, combo_parent_uuid: asUuid('missing') });
        expect(clampSelection([child], { c: 5 })).toEqual({ c: 2 });
    });
});

describe('splitPreview', () => {
    beforeEach(resetRowSequences);

    it('reports what each side keeps', () => {
        const a = makeLine({ uuid: asUuid('a'), quantity: 3 });
        const b = makeLine({ uuid: asUuid('b'), quantity: 1 });

        const preview = splitPreview([a, b], { a: 1, b: 1 });
        expect(preview.movedCount).toBe(2);
        expect(preview.moved.map((p) => [p.line.uuid, p.quantity])).toEqual([
            ['a', 1],
            ['b', 1],
        ]);
        // b moved entirely, so nothing of it remains.
        expect(preview.remaining.map((p) => [p.line.uuid, p.quantity])).toEqual([['a', 2]]);
    });

    it('moved + remaining always add back to the original quantity', () => {
        const lines = [
            makeLine({ uuid: asUuid('a'), quantity: 3 }),
            makeLine({ uuid: asUuid('b'), quantity: 2 }),
            makeLine({ uuid: asUuid('c'), quantity: 1 }),
        ];
        const preview = splitPreview(lines, { a: 2, b: 2, c: 0 });

        for (const line of lines) {
            const moved = preview.moved.find((p) => p.line.uuid === line.uuid)?.quantity ?? 0;
            const left = preview.remaining.find((p) => p.line.uuid === line.uuid)?.quantity ?? 0;
            expect(moved + left).toBe(line.quantity);
        }
    });
});

describe('nextSplitLetter', () => {
    it('starts at B — the original bill is the unlettered one', () => {
        expect(nextSplitLetter([])).toBe('B');
    });

    it('skips letters already handed out, ignoring nulls', () => {
        expect(nextSplitLetter(['B', null, 'C'])).toBe('D');
    });

    it('returns null once 25 splits exist', () => {
        const used = Array.from({ length: 25 }, (_, i) => String.fromCharCode(66 + i));
        expect(nextSplitLetter(used)).toBeNull();
    });
});

describe('splitPrepSnapshot', () => {
    beforeEach(resetRowSequences);

    it('moves the already-cooked quantity with the lines it belongs to', () => {
        const line = makeLine({ uuid: asUuid('a'), quantity: 3 });
        const { original, split } = splitPrepSnapshot({ 'a::|[]': 3 }, () => 'a::|[]', [{ line, quantity: 1 }]);

        expect(split).toEqual({ 'a::|[]': 1 });
        expect(original).toEqual({ 'a::|[]': 2 });
    });

    it('removes the key entirely when the whole sent quantity moves', () => {
        const line = makeLine({ uuid: asUuid('a'), quantity: 2 });
        const { original, split } = splitPrepSnapshot({ 'a::|[]': 2 }, () => 'a::|[]', [{ line, quantity: 2 }]);
        expect(split).toEqual({ 'a::|[]': 2 });
        expect(original).toEqual({});
    });

    it('takes nothing for a line the kitchen never saw', () => {
        const line = makeLine({ uuid: asUuid('a'), quantity: 2 });
        const { original, split } = splitPrepSnapshot({ 'other::|[]': 1 }, () => 'a::|[]', [
            { line, quantity: 2 },
        ]);
        expect(split).toEqual({});
        expect(original).toEqual({ 'other::|[]': 1 });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// splitOrder — the store-level operation
// ─────────────────────────────────────────────────────────────────────────────

const PIZZA = 101;
const COLA = 102;

function installTestCatalog(): void {
    installCatalog({
        products: [
            makeProduct({ id: 1, name: 'Pizza', list_price: '12.00' }),
            makeProduct({ id: 2, name: 'Cola', list_price: '3.00' }),
        ],
        variants: [
            makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' }),
            makeVariant({ id: COLA, product_id: 2, display_name: 'Cola' }),
        ],
    });
}

function quantitiesOf(orderUuid: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const line of linesOf(useOrderStore.getState(), orderUuid)) {
        out[line.full_product_name] = (out[line.full_product_name] ?? 0) + line.quantity;
    }
    return out;
}

describe('splitOrder', () => {
    beforeEach(() => {
        resetRegisterState();
        installTestCatalog();
    });

    it('moves a whole line onto the new bill and removes it from the original', async () => {
        const orderUuid = await createOrder({ tableId: 4, guestCount: 4 });
        const pizza = addLine({ orderUuid, variantId: PIZZA, quantity: 1 });
        const cola = addLine({ orderUuid, variantId: COLA, quantity: 1 });

        const splitUuid = await splitOrder(orderUuid, { [cola]: 1 });
        expect(splitUuid).not.toBeNull();

        expect(quantitiesOf(orderUuid)).toEqual({ Pizza: 1 });
        expect(quantitiesOf(splitUuid as string)).toEqual({ Cola: 1 });
        expect(useOrderStore.getState().lines[pizza]).toBeDefined();
        expect(useOrderStore.getState().lines[cola]).toBeUndefined();
    });

    it('splits a partial quantity, leaving the residual on the original', async () => {
        const orderUuid = await createOrder({ tableId: 4, guestCount: 4 });
        const pizza = addLine({ orderUuid, variantId: PIZZA, quantity: 3 });

        const splitUuid = await splitOrder(orderUuid, { [pizza]: 1 });

        expect(useOrderStore.getState().lines[pizza]?.quantity).toBe(2);
        expect(quantitiesOf(splitUuid as string)).toEqual({ Pizza: 1 });
    });

    it('keeps the table on the original and settles the split as a floating order', async () => {
        const orderUuid = await createOrder({ tableId: 4, guestCount: 4 });
        const pizza = addLine({ orderUuid, variantId: PIZZA, quantity: 2 });

        const splitUuid = (await splitOrder(orderUuid, { [pizza]: 1 })) as string;
        const state = useOrderStore.getState();

        expect(state.orders[orderUuid]?.restaurant_table_id).toBe(4);
        expect(state.orders[splitUuid]?.restaurant_table_id).toBeNull();
        expect(state.orders[splitUuid]?.split_from_order_uuid).toBe(orderUuid);
        expect(state.orders[splitUuid]?.split_letter).toBe('B');
        // RST-103 — the original loses a guest to the new bill.
        expect(state.orders[orderUuid]?.guest_count).toBe(3);
        expect(state.orders[splitUuid]?.guest_count).toBe(1);
    });

    it('letters repeated splits B, C, D …', async () => {
        const orderUuid = await createOrder({ tableId: 4, guestCount: 4 });
        const pizza = addLine({ orderUuid, variantId: PIZZA, quantity: 4 });

        const first = (await splitOrder(orderUuid, { [pizza]: 1 })) as string;
        const second = (await splitOrder(orderUuid, { [pizza]: 1 })) as string;
        const third = (await splitOrder(orderUuid, { [pizza]: 1 })) as string;

        const state = useOrderStore.getState();
        expect([
            state.orders[first]?.split_letter,
            state.orders[second]?.split_letter,
            state.orders[third]?.split_letter,
        ]).toEqual(['B', 'C', 'D']);
    });

    it('conserves quantity across repeated splits', async () => {
        const orderUuid = await createOrder({ tableId: 4, guestCount: 6 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 4 });
        addLine({ orderUuid, variantId: COLA, quantity: 2 });

        const total = (): number =>
            Object.values(useOrderStore.getState().lines).reduce((sum, line) => sum + line.quantity, 0);
        expect(total()).toBe(6);

        for (let round = 0; round < 3; round++) {
            const lines = linesOf(useOrderStore.getState(), orderUuid);
            const selection: Record<string, number> = {};
            for (const line of lines) selection[line.uuid] = 1;
            await splitOrder(orderUuid, selection);
            expect(total()).toBe(6);
        }
    });

    it('refuses an empty selection', async () => {
        const orderUuid = await createOrder({ tableId: 4 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 1 });
        expect(await splitOrder(orderUuid, {})).toBeNull();
    });

    it('migrates the kitchen-sent quantities so neither bill re-fires (RST-102)', async () => {
        const orderUuid = await createOrder({ tableId: 4, guestCount: 2 });
        const pizza = addLine({ orderUuid, variantId: PIZZA, quantity: 2 });

        useOrderStore.getState().mutate((draft) => {
            const order = draft.orders[orderUuid];
            if (order) {
                order.last_prep_snapshot = {
                    at: '2026-07-28T12:00:00.000Z',
                    lines: { [`${pizza}::|[]`]: 2 },
                    noteHash: '0',
                };
            }
        });

        const splitUuid = (await splitOrder(orderUuid, { [pizza]: 1 })) as string;
        const state = useOrderStore.getState();

        expect(state.orders[orderUuid]?.last_prep_snapshot?.lines).toEqual({ [`${pizza}::|[]`]: 1 });
        expect(Object.values(state.orders[splitUuid]?.last_prep_snapshot?.lines ?? {})).toEqual([1]);
        expect(state.orders[splitUuid]?.prep_state).toBe('sent');
    });
});
