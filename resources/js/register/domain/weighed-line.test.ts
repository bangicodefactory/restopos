import { WeightSource } from '@domain/enums';
import { beforeEach, describe, expect, it } from 'vitest';

import { buildOrderCommand } from '../data/persistence';
import { linesOf, useOrderStore } from '../state/order-store';
import {
    installCatalog,
    makeConfig,
    makeProduct,
    makeTax,
    makeUom,
    makeVariant,
    resetRegisterState,
} from './__fixtures__/catalog';
import {
    addLine,
    cancelOrder,
    createOrder,
    discardOrder,
    isWeighedLine,
    markPrepSent,
    reduceQuantity,
    removeLine,
    setQuantity,
    validateOrder,
} from './order-actions';
import { forgetWeighings, isRepeatWeight, recordAcceptedWeight, resetWeighings } from './weighing';

/**
 * REG-077 / XCT-058 — the guards around a weighed line.
 *
 * The ticket asked for a scale driver. The defect underneath it was that the legal-metrology rule
 * guarded exactly one door: the scale dialog refused an unchanged weight, and the numpad happily
 * retyped the same line to any number at all. Everything in this file exists because the driver is
 * worth nothing while that is true.
 */

const TVA20 = makeTax({ id: 1, name: 'TVA 20', amount: '20', tax_group_id: 1 });

const PIZZA = 101;
/** Sold by the kilo. `to_weight` is what opens the scale dialog (`product-flow.ts`). */
const CHEESE = 105;
/**
 * Also weighed, but on the *default* groupable unit rather than a kg one.
 *
 * A misconfiguration in the back office, and nothing there prevents it — which is exactly why the
 * merge guard has to be its own condition. Weighing CHEESE cannot test it: its kg UoM is
 * `is_pos_groupable: false`, so `canMergeLines` already refuses on the line below and a merge test
 * using it would pass with the weight guard deleted. It did, when this file was first written.
 */
const OLIVES = 106;

function install(): void {
    installCatalog({
        config: makeConfig({}),
        taxes: [TVA20],
        uoms: [makeUom({ id: 1 }), makeUom({ id: 2, name: 'kg', is_pos_groupable: false })],
        products: [
            makeProduct({ id: 1, name: 'Pizza', list_price: '10.00', tax_ids: [TVA20.id] }),
            makeProduct({ id: 5, name: 'Fromage', list_price: '20.00', uom_id: 2, to_weight: true }),
            makeProduct({ id: 6, name: 'Olives', list_price: '12.00', uom_id: 1, to_weight: true }),
        ],
        variants: [
            makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' }),
            makeVariant({ id: CHEESE, product_id: 5, display_name: 'Fromage' }),
            makeVariant({ id: OLIVES, product_id: 6, display_name: 'Olives' }),
        ],
    });
}

function state() {
    return useOrderStore.getState();
}

function lineOf(uuid: string) {
    const line = state().lines[uuid];
    if (!line) throw new Error(`no line ${uuid}`);
    return line;
}

/** Add a weighed line the way `ScaleDialog` does. */
function weigh(orderUuid: string, kg: number, source: WeightSource = WeightSource.Scale): string {
    return addLine({
        orderUuid,
        variantId: CHEESE,
        quantity: kg,
        priceUnit: '20.00',
        skipMerge: true,
        weightSource: source,
    });
}

beforeEach(() => {
    resetRegisterState();
    resetWeighings();
    install();
});

describe('setQuantity refuses a weighed line (the money bug)', () => {
    it('will not retype 0.200 kg into 5 kg', async () => {
        const orderUuid = await createOrder();
        const lineUuid = weigh(orderUuid, 0.2);

        const applied = setQuantity(lineUuid, 5);

        expect(applied).toBe(false);
        expect(lineOf(lineUuid).quantity).toBe(0.2);
    });

    it('leaves the revision alone, so nothing downstream thinks the line moved', async () => {
        const orderUuid = await createOrder();
        const lineUuid = weigh(orderUuid, 0.2);
        const before = lineOf(lineUuid).rev;

        setQuantity(lineUuid, 5);

        expect(lineOf(lineUuid).rev).toBe(before);
    });

    it('refuses a hand-entered weight exactly as it refuses a measured one', async () => {
        // AC4 makes manual entry a supported fallback, not a loophole. If `manual` were exempt, the
        // way round the guard would be to open the dialog, type a weight, then retype it.
        const orderUuid = await createOrder();
        const lineUuid = weigh(orderUuid, 0.2, WeightSource.Manual);

        expect(setQuantity(lineUuid, 5)).toBe(false);
        expect(lineOf(lineUuid).quantity).toBe(0.2);
    });

    it('still moves an ordinary line', async () => {
        // The negative control. Without it, a `setQuantity` that refused *everything* would pass
        // every assertion above.
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA });

        expect(setQuantity(lineUuid, 3)).toBe(true);
        expect(lineOf(lineUuid).quantity).toBe(3);
    });

    it('reports the refusal rather than reporting success', async () => {
        const orderUuid = await createOrder();

        expect(setQuantity(addLine({ orderUuid, variantId: PIZZA }), 2)).toBe(true);
        expect(setQuantity(weigh(orderUuid, 0.2), 2)).toBe(false);
        expect(setQuantity('no-such-line', 2)).toBe(false);
    });
});

describe('reduceQuantity refuses a weighed line', () => {
    it('does not create a compensating credit for a reduction that never happened', async () => {
        // The specific way this goes wrong without the guard: `reduceQuantity` writes the original
        // back to `sent` (refused, so a no-op), then adds a negative line for the difference. The
        // order ends up with a credit and a full-weight line.
        const orderUuid = await createOrder();
        const lineUuid = weigh(orderUuid, 1);
        markPrepSent(orderUuid);

        const landed = reduceQuantity(lineUuid, 0.4);

        expect(landed).toBe(lineUuid);
        expect(lineOf(lineUuid).quantity).toBe(1);
        expect(linesOf(state(), orderUuid)).toHaveLength(1);
    });

    it('still splits an ordinary line the kitchen has seen (REG-107 is untouched)', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 3 });
        markPrepSent(orderUuid);

        const landed = reduceQuantity(lineUuid, 1);

        expect(landed).not.toBe(lineUuid);
        expect(lineOf(lineUuid).quantity).toBe(3);
        expect(lineOf(landed).quantity).toBe(-2);
    });
});

describe('removing the line is still the way out', () => {
    it('a mis-weighed line can be voided and weighed again', async () => {
        // The guard must not trap a cashier. Refusing an edit is only defensible because voiding
        // and re-weighing both still work.
        const orderUuid = await createOrder();
        const first = weigh(orderUuid, 5);

        removeLine(first);
        expect(linesOf(state(), orderUuid)).toHaveLength(0);

        const second = weigh(orderUuid, 0.2);
        expect(lineOf(second).quantity).toBe(0.2);
    });
});

describe('a weighed line never merges', () => {
    it('merges an ordinary line on this UoM, so the guard below is the only thing in the way', async () => {
        // The control for the two tests after it. OLIVES sits on the groupable default unit, so
        // every other merge condition passes and a merge really does happen here.
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: OLIVES, quantity: 0.2, priceUnit: '12.00' });
        addLine({ orderUuid, variantId: OLIVES, quantity: 0.3, priceUnit: '12.00' });

        const lines = linesOf(state(), orderUuid);
        expect(lines).toHaveLength(1);
        expect(lines[0]?.quantity).toBe(0.5);
    });

    it('two weighings of the same product stay two lines even without skipMerge', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: OLIVES, quantity: 0.2, priceUnit: '12.00', weightSource: WeightSource.Scale });
        addLine({ orderUuid, variantId: OLIVES, quantity: 0.3, priceUnit: '12.00', weightSource: WeightSource.Scale });

        const lines = linesOf(state(), orderUuid);
        expect(lines).toHaveLength(2);
        expect(lines.map((line) => line.quantity)).toEqual([0.2, 0.3]);
    });

    it('a weighed line does not absorb an unweighed add of the same product', async () => {
        // The dangerous shape: a merge would call `setQuantity`, which now refuses, and `addLine`
        // would return the existing uuid as though the quantity had gone on. Silent loss — the
        // cashier sees 0.2 kg on a line they just added 0.3 kg to, and no error anywhere.
        const orderUuid = await createOrder();
        const weighed = addLine({
            orderUuid,
            variantId: OLIVES,
            quantity: 0.2,
            priceUnit: '12.00',
            weightSource: WeightSource.Scale,
        });
        const plain = addLine({ orderUuid, variantId: OLIVES, quantity: 0.3, priceUnit: '12.00' });

        expect(plain).not.toBe(weighed);
        expect(lineOf(weighed).quantity).toBe(0.2);
        expect(lineOf(plain).quantity).toBe(0.3);
        expect(linesOf(state(), orderUuid)).toHaveLength(2);
    });
});

describe('provenance (AC4)', () => {
    it('records where the weight came from, and null on anything not weighed', async () => {
        const orderUuid = await createOrder();

        expect(lineOf(weigh(orderUuid, 0.2, WeightSource.Scale)).weight_source).toBe('scale');
        expect(lineOf(weigh(orderUuid, 0.3, WeightSource.Manual)).weight_source).toBe('manual');
        expect(lineOf(addLine({ orderUuid, variantId: PIZZA })).weight_source).toBeNull();
    });

    it('puts the provenance on the push command, not only in local state', async () => {
        // Without this the column exists, the client fills it in, and the server never hears about
        // it — a wire nobody connected, which is the defect this whole ticket kept finding.
        const orderUuid = await createOrder();
        weigh(orderUuid, 0.2, WeightSource.Scale);
        addLine({ orderUuid, variantId: PIZZA });

        const command = buildOrderCommand(state(), orderUuid);
        const sources = command?.lines?.map((line) => line['weight_source']);

        expect(sources).toEqual(['scale', null]);
    });

    it('isWeighedLine answers on the line, not on the product flag', async () => {
        const orderUuid = await createOrder();
        // Same `to_weight` product, added without a source — a barcode scan, a self-order import.
        // It is not a measurement, so it is not locked.
        const scanned = addLine({ orderUuid, variantId: CHEESE, quantity: 0.5, priceUnit: '20.00' });

        expect(isWeighedLine(scanned)).toBe(false);
        expect(setQuantity(scanned, 0.6)).toBe(true);
        expect(isWeighedLine(weigh(orderUuid, 0.2))).toBe(true);
    });
});

describe('the weight-change rule, scoped (REG-077)', () => {
    it('refuses the same weight twice for the same item on the same order', () => {
        expect(isRepeatWeight('order-a', CHEESE, 0.2)).toBe(false);
        recordAcceptedWeight('order-a', CHEESE, 0.2);
        expect(isRepeatWeight('order-a', CHEESE, 0.2)).toBe(true);
    });

    it('allows a weight that actually differs', () => {
        recordAcceptedWeight('order-a', CHEESE, 0.2);
        expect(isRepeatWeight('order-a', CHEESE, 0.201)).toBe(false);
    });

    it('treats a sub-gram difference as the same weight', () => {
        // The loophole the epsilon closes: 0.2001 kg is 0.2 kg to any scale a bistro owns, so
        // accepting it would be accepting the same weighing twice.
        recordAcceptedWeight('order-a', CHEESE, 0.2);
        expect(isRepeatWeight('order-a', CHEESE, 0.2001)).toBe(true);
    });

    it('does not leak across products', () => {
        // 200 g of gruyère then 200 g of olives. The module-level `let` this replaces refused the
        // second one, on the strength of a number about a different product entirely.
        recordAcceptedWeight('order-a', CHEESE, 0.2);
        expect(isRepeatWeight('order-a', PIZZA, 0.2)).toBe(false);
    });

    it('does not leak across orders', () => {
        // Two customers buying the same 200 g back to back is not a repeat weighing; it is two
        // sales. The old global refused the second.
        recordAcceptedWeight('order-a', CHEESE, 0.2);
        expect(isRepeatWeight('order-b', CHEESE, 0.2)).toBe(false);
    });

    it('is released when the order is forgotten, and only that order', () => {
        recordAcceptedWeight('order-a', CHEESE, 0.2);
        recordAcceptedWeight('order-b', CHEESE, 0.2);

        forgetWeighings('order-a');

        expect(isRepeatWeight('order-a', CHEESE, 0.2)).toBe(false);
        expect(isRepeatWeight('order-b', CHEESE, 0.2)).toBe(true);
    });

    it('does not release an order whose uuid merely starts the same', () => {
        // `startsWith(orderUuid)` without the separator would take 'order-a1' out with 'order-a'.
        recordAcceptedWeight('order-a1', CHEESE, 0.2);
        forgetWeighings('order-a');
        expect(isRepeatWeight('order-a1', CHEESE, 0.2)).toBe(true);
    });

    it('is released when the order is validated', async () => {
        const orderUuid = await createOrder();
        recordAcceptedWeight(orderUuid, CHEESE, 0.2);

        validateOrder(orderUuid);

        expect(isRepeatWeight(orderUuid, CHEESE, 0.2)).toBe(false);
    });

    it('is released when the order is cancelled', async () => {
        const orderUuid = await createOrder();
        recordAcceptedWeight(orderUuid, CHEESE, 0.2);

        cancelOrder(orderUuid);

        expect(isRepeatWeight(orderUuid, CHEESE, 0.2)).toBe(false);
    });

    it('is released when an unsynced draft is discarded', async () => {
        const orderUuid = await createOrder();
        recordAcceptedWeight(orderUuid, CHEESE, 0.2);

        discardOrder(orderUuid);

        expect(isRepeatWeight(orderUuid, CHEESE, 0.2)).toBe(false);
    });
});
