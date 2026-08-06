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
    clampRefundQuantity,
    createOrder,
    createRefundOrder,
    expandComboSelection,
    refundEverything,
    refundableQuantity,
    setDiscount,
    setPriceUnit,
    setQuantity,
} from './order-actions';
import { linesOf, useOrderStore } from '../state/order-store';

/**
 * BAN-406 — the client half of the refund guard (REG-273, REG-274, REG-276).
 *
 * The server refuses an over-refund whatever the till sends; these exist so the cashier finds out
 * while the customer is still standing there, and so the *shape* of what gets sent is right in the
 * first place — a combo refunded parent-only credits the meal deal while still charging for the
 * burger inside it.
 */

const BURGER = 101;
const FRIES = 102;
const COMBO = 103;

function state() {
    return useOrderStore.getState();
}

beforeEach(() => {
    resetRegisterState();
    installCatalog({
        config: makeConfig(),
        products: [
            makeProduct({ id: 1, name: 'Burger', list_price: '8.00' }),
            makeProduct({ id: 2, name: 'Frites', list_price: '3.00' }),
            makeProduct({ id: 3, name: 'Menu', list_price: '10.00', combo_count: 2 }),
        ],
        variants: [
            makeVariant({ id: BURGER, product_id: 1, display_name: 'Burger' }),
            makeVariant({ id: FRIES, product_id: 2, display_name: 'Frites' }),
            makeVariant({ id: COMBO, product_id: 3, display_name: 'Menu' }),
        ],
    });
});

/** A paid order holding one combo of two parts, plus a standalone drink. */
async function comboOrder(): Promise<{ orderUuid: string; parent: string; burger: string; fries: string }> {
    const orderUuid = await createOrder({ tableId: 1 });

    const parent = addLine({ orderUuid, variantId: COMBO, quantity: 1, priceUnit: '10.00', skipMerge: true });
    const burger = addLine({
        orderUuid,
        variantId: BURGER,
        quantity: 1,
        priceUnit: '7.00',
        comboParentUuid: parent,
        skipMerge: true,
    });
    const fries = addLine({
        orderUuid,
        variantId: FRIES,
        quantity: 1,
        priceUnit: '3.00',
        comboParentUuid: parent,
        skipMerge: true,
    });

    return { orderUuid, parent, burger, fries };
}

describe('clampRefundQuantity', () => {
    it('caps a request at what the line can still give back', async () => {
        // The `max` attribute on a number input constrains the spinner and nothing else, so a pasted
        // value sails straight past it (REG-273).
        const orderUuid = await createOrder({ tableId: 1 });
        const lineUuid = addLine({ orderUuid, variantId: BURGER, quantity: 2 });
        const line = state().lines[lineUuid]!;

        expect(clampRefundQuantity(line, 5)).toBe(2);
        expect(clampRefundQuantity(line, 2)).toBe(2);
        expect(clampRefundQuantity(line, 1)).toBe(1);
    });

    it('counts what has already been given back', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        const lineUuid = addLine({ orderUuid, variantId: BURGER, quantity: 3 });

        useOrderStore.setState((current) => ({
            ...current,
            lines: { ...current.lines, [lineUuid]: { ...current.lines[lineUuid]!, refunded_quantity: 2 } },
        }));

        const line = state().lines[lineUuid]!;

        expect(refundableQuantity(line)).toBe(1);
        expect(clampRefundQuantity(line, 3)).toBe(1);
    });

    it('refuses nonsense rather than passing it through', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        const lineUuid = addLine({ orderUuid, variantId: BURGER, quantity: 2 });
        const line = state().lines[lineUuid]!;

        expect(clampRefundQuantity(line, Number.NaN)).toBe(0);
        expect(clampRefundQuantity(line, -3)).toBe(0);
    });
});

describe('expandComboSelection', () => {
    it('pulls a combo children in when the parent is selected', async () => {
        // Refunding the parent alone credits the meal deal and keeps charging for what was inside it.
        const { orderUuid, parent, burger, fries } = await comboOrder();
        const lines = linesOf(state(), orderUuid);

        const expanded = expandComboSelection(lines, { [parent]: 1 });

        expect(expanded[parent]).toBe(1);
        expect(expanded[burger]).toBe(1);
        expect(expanded[fries]).toBe(1);
    });

    it('promotes a child selected alone to the whole combo', async () => {
        // Refusing outright would leave the cashier with a customer, a complaint and no way to act.
        // The price the customer paid was for the combo, distributed across its parts, so a child on
        // its own is not a transaction the till can settle.
        const { orderUuid, parent, burger, fries } = await comboOrder();
        const lines = linesOf(state(), orderUuid);

        const expanded = expandComboSelection(lines, { [burger]: 1 });

        expect(expanded[parent]).toBe(1);
        expect(expanded[fries]).toBe(1);
    });

    it('leaves an ordinary line alone', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        const drink = addLine({ orderUuid, variantId: FRIES, quantity: 2 });
        const lines = linesOf(state(), orderUuid);

        expect(expandComboSelection(lines, { [drink]: 1 })).toEqual({ [drink]: 1 });
    });

    it('does not resurrect a selection of zero', async () => {
        const { orderUuid, parent, burger } = await comboOrder();
        const lines = linesOf(state(), orderUuid);

        const expanded = expandComboSelection(lines, { [parent]: 0 });

        expect(expanded[burger] ?? 0).toBe(0);
    });
});

describe('createRefundOrder', () => {
    it('refunds a combo whole, children and all', async () => {
        const { orderUuid, parent } = await comboOrder();

        const refundUuid = await createRefundOrder(orderUuid, { [parent]: 1 });

        expect(refundUuid).not.toBeNull();

        const refundLines = linesOf(state(), refundUuid!);

        expect(refundLines).toHaveLength(3);
        for (const line of refundLines) {
            expect(line.quantity).toBeLessThan(0);
        }
    });

    it('keeps the combo structure on the refund rather than flattening it', async () => {
        // The children point at the *refund* parent, not at the original order's line — otherwise
        // the refund carries a parent link into an order that does not contain it.
        const { orderUuid, parent } = await comboOrder();

        const refundUuid = await createRefundOrder(orderUuid, { [parent]: 1 });
        const refundLines = linesOf(state(), refundUuid!);

        const refundParent = refundLines.find((line) => line.combo_parent_uuid === null);
        const children = refundLines.filter((line) => line.combo_parent_uuid !== null);

        expect(refundParent).toBeDefined();
        expect(children).toHaveLength(2);
        for (const child of children) {
            expect(child.combo_parent_uuid).toBe(refundParent!.uuid);
        }
    });

    it('links every refund line back to the line it credits', async () => {
        // Required by the server since BAN-406: a negative line that names nothing is refused.
        const { orderUuid, parent } = await comboOrder();

        const refundUuid = await createRefundOrder(orderUuid, { [parent]: 1 });

        for (const line of linesOf(state(), refundUuid!)) {
            expect(line.refunded_line_uuid).not.toBeNull();
        }
    });

    it('will not refund more than remains', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        const lineUuid = addLine({ orderUuid, variantId: BURGER, quantity: 2 });

        const refundUuid = await createRefundOrder(orderUuid, { [lineUuid]: 99 });

        expect(linesOf(state(), refundUuid!)[0]?.quantity).toBe(-2);
    });

    it('returns null when nothing is refundable', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        const lineUuid = addLine({ orderUuid, variantId: BURGER, quantity: 1 });

        useOrderStore.setState((current) => ({
            ...current,
            lines: { ...current.lines, [lineUuid]: { ...current.lines[lineUuid]!, refunded_quantity: 1 } },
        }));

        expect(await createRefundOrder(orderUuid, { [lineUuid]: 1 })).toBeNull();
    });
});

describe('refundEverything', () => {
    it('selects every line at what it can still give back', async () => {
        const { orderUuid, parent, burger, fries } = await comboOrder();

        const selection = refundEverything(orderUuid);

        expect(selection[parent]).toBe(1);
        expect(selection[burger]).toBe(1);
        expect(selection[fries]).toBe(1);
    });

    it('skips a line already refunded in full', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        const kept = addLine({ orderUuid, variantId: BURGER, quantity: 2, skipMerge: true });
        const spent = addLine({ orderUuid, variantId: FRIES, quantity: 1, skipMerge: true });

        useOrderStore.setState((current) => ({
            ...current,
            lines: { ...current.lines, [spent]: { ...current.lines[spent]!, refunded_quantity: 1 } },
        }));

        const selection = refundEverything(orderUuid);

        expect(selection[kept]).toBe(2);
        expect(selection[spent]).toBeUndefined();
    });

    it('produces a refund matching the original line for line', async () => {
        // The ticket's acceptance criterion for the action.
        const { orderUuid } = await comboOrder();

        const refundUuid = await createRefundOrder(orderUuid, refundEverything(orderUuid));
        const original = linesOf(state(), orderUuid);
        const refund = linesOf(state(), refundUuid!);

        expect(refund).toHaveLength(original.length);

        for (const line of original) {
            const credit = refund.find((candidate) => candidate.refunded_line_uuid === line.uuid);
            expect(credit?.quantity).toBe(-line.quantity);
        }
    });
});

describe('a refund line is not editable', () => {
    it('refuses to change its quantity, price or discount (REG-274)', async () => {
        // The quantity was capped against what remains and the price was copied from the line being
        // credited. Editing either afterwards refunds more than was sold, or refunds it at a price
        // that was never charged — and the second leaves the cap looking satisfied.
        const orderUuid = await createOrder({ tableId: 1 });
        const lineUuid = addLine({ orderUuid, variantId: BURGER, quantity: 2, priceUnit: '8.00' });

        const refundUuid = await createRefundOrder(orderUuid, { [lineUuid]: 2 });
        const refundLine = linesOf(state(), refundUuid!)[0]!;

        setQuantity(refundLine.uuid, -99);
        setPriceUnit(refundLine.uuid, '999.00');
        setDiscount(refundLine.uuid, '100');

        const after = state().lines[refundLine.uuid]!;

        expect(after.quantity).toBe(-2);
        expect(after.price_unit).toBe('8.00');
        expect(after.discount_percent).toBe('0');
    });
});
