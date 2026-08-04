import type { ProductAttributeLineValueRow, ProductAttributeValueRow } from '@domain/types';
import { asUuid } from '@domain/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOrderCommand } from '../data/persistence';
import { coursesOf, linesOf, paymentsOf, useOrderStore } from '../state/order-store';
import {
    installCatalog,
    makeConfig,
    makePreset,
    makeProduct,
    makeTax,
    makeUom,
    makeVariant,
    resetRegisterState,
} from './__fixtures__/catalog';
import { computePrepDelta } from './kitchen-delta';
import {
    addCourse,
    addLine,
    addPayment,
    adoptPrepSnapshot,
    applyCustomerDefaults,
    applyServerAck,
    attributeExtraOf,
    canMergeLines,
    cancelOrder,
    cleanCourses,
    configureOrderActions,
    createOrder,
    createRefundOrder,
    discardOrder,
    fireCourse,
    markPrepSent,
    reduceQuantity,
    removeLine,
    removePayment,
    resolveUnitPrice,
    setCustomer,
    setDiscount,
    setEmployee,
    setFiscalPosition,
    setGuestCount,
    setLineCourse,
    setPaymentAmount,
    setPaymentStatus,
    setPreset,
    setPriceUnit,
    setPricelist,
    setQuantity,
    setTip,
    validateOrder,
} from './order-actions';
import { orderTotals } from './totals';

/** Unit coverage for REG-100 … REG-272 and RST-081 … RST-106 — the order mutation module. */

const TVA20 = makeTax({ id: 1, name: 'TVA 20', amount: '20', tax_group_id: 1 });

// Products / variants
const PIZZA = 101;
const COLA = 102;
const FRIES = 103;
const TIP = 104;
const BULK = 105;

const KETCHUP: ProductAttributeValueRow = {
    id: 901,
    product_attribute_id: 1,
    name: 'Ketchup',
    html_color: null,
    image_media_id: null,
    is_custom: false,
    sequence: 1,
};
const MAYO: ProductAttributeValueRow = { ...KETCHUP, id: 902, name: 'Mayo', sequence: 2 };
const TRUFFLE: ProductAttributeValueRow = { ...KETCHUP, id: 903, name: 'Truffe', sequence: 3 };

function lineValue(
    id: number,
    valueId: number,
    priceExtra: string,
): ProductAttributeLineValueRow {
    return {
        id,
        product_attribute_line_id: 1,
        product_attribute_value_id: valueId,
        product_id: 3,
        price_extra: priceExtra,
        sequence: id,
        active: true,
    };
}

const LV_KETCHUP = lineValue(501, KETCHUP.id, '0');
const LV_MAYO = lineValue(502, MAYO.id, '0');
const LV_TRUFFLE = lineValue(503, TRUFFLE.id, '1.50');

function install(overrides: Parameters<typeof installCatalog>[0] = {}): void {
    installCatalog({
        config: makeConfig({ available_pricelist_ids: [7], available_fiscal_position_ids: [9] }),
        taxes: [TVA20],
        uoms: [makeUom({ id: 1 }), makeUom({ id: 2, name: 'kg', is_pos_groupable: false })],
        products: [
            makeProduct({ id: 1, name: 'Pizza', list_price: '10.00', tax_ids: [TVA20.id], pos_category_ids: [50] }),
            makeProduct({ id: 2, name: 'Cola', list_price: '3.00', tax_ids: [TVA20.id], pos_category_ids: [51] }),
            makeProduct({ id: 3, name: 'Frites', list_price: '4.00', tax_ids: [TVA20.id], attribute_count: 1 }),
            makeProduct({ id: 4, name: 'Pourboire', list_price: '0', special_kind: 'tip', is_special: true }),
            makeProduct({ id: 5, name: 'Fromage', list_price: '20.00', uom_id: 2 }),
        ],
        variants: [
            makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' }),
            makeVariant({ id: COLA, product_id: 2, display_name: 'Cola' }),
            makeVariant({ id: FRIES, product_id: 3, display_name: 'Frites' }),
            makeVariant({ id: TIP, product_id: 4, display_name: 'Pourboire' }),
            makeVariant({ id: BULK, product_id: 5, display_name: 'Fromage' }),
        ],
        attributeValues: [KETCHUP, MAYO, TRUFFLE],
        attributeLineValues: [LV_KETCHUP, LV_MAYO, LV_TRUFFLE],
        ...overrides,
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

function orderOf(uuid: string) {
    const order = state().orders[uuid];
    if (!order) throw new Error(`no order ${uuid}`);
    return order;
}

beforeEach(() => {
    resetRegisterState();
    install();
});

// ─────────────────────────────────────────────────────────────────────────────
// Creation
// ─────────────────────────────────────────────────────────────────────────────

describe('createOrder', () => {
    it('mints a draft with a reference, a tracking number and empty relation buckets', async () => {
        const orderUuid = await createOrder();
        const order = orderOf(orderUuid);

        expect(order).toMatchObject({
            state: 'draft',
            receipt_number: 'LOCAL-000001',
            tracking_number: '001',
            syncState: 'local',
            rev: 0,
            guest_count: 0,
            amount_total: '0',
            is_refund: false,
        });
        expect(state().linesByOrder[orderUuid]).toEqual([]);
        expect(state().paymentsByOrder[orderUuid]).toEqual([]);
        expect(state().coursesByOrder[orderUuid]).toEqual([]);
        expect(state().selectedOrderUuid).toBe(orderUuid);
        expect(state().selectedLineUuid).toBeNull();
    });

    it('inherits the config defaults and honours explicit input', async () => {
        install({
            config: makeConfig({
                pricelist_id: 7,
                default_fiscal_position_id: 9,
                default_preset_id: 3,
                available_pricelist_ids: [7],
                available_fiscal_position_ids: [9],
            }),
        });

        const fromConfig = orderOf(await createOrder());
        expect(fromConfig).toMatchObject({ pricelist_id: 7, fiscal_position_id: 9, pos_preset_id: 3 });

        const explicit = orderOf(
            await createOrder({ pricelistId: 11, tableId: 12, guestCount: 4, customerId: 5 }),
        );
        expect(explicit).toMatchObject({
            pricelist_id: 11,
            restaurant_table_id: 12,
            guest_count: 4,
            customer_id: 5,
        });
    });

    /**
     * `createOrder` distinguishes "key absent" from "explicit null", so a cleared pricelist is not
     * quietly refilled from the config. `createRefundOrder` and `splitOrder` forward the *original
     * order's* value, and a refund of an order with no pricelist must have no pricelist either.
     */
    it('carries a deliberately cleared pricelist through to a refund', async () => {
        install({
            config: makeConfig({ pricelist_id: 7, available_pricelist_ids: [7] }),
            pricelists: [{ id: 7, items: [] }],
        });

        const orderUuid = await createOrder();
        setPricelist(orderUuid, null);
        const lineUuid = addLine({ orderUuid, variantId: PIZZA });

        const refundUuid = (await createRefundOrder(orderUuid, { [lineUuid]: 1 })) as string;
        expect(orderOf(refundUuid).pricelist_id).toBeNull();
    });

    it('queues a table order immediately but not a bare floating draft (RST-142)', async () => {
        const enqueue = vi.fn();
        const persist = vi.fn();
        const onChange = vi.fn();
        configureOrderActions({ enqueue, persist, onChange });

        const floating = await createOrder();
        expect(enqueue).not.toHaveBeenCalled();
        expect(persist).toHaveBeenCalledWith(floating);
        expect(onChange).toHaveBeenCalledWith(floating);

        const seated = await createOrder({ tableId: 3 });
        expect(enqueue).toHaveBeenCalledExactlyOnceWith(seated);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lines
// ─────────────────────────────────────────────────────────────────────────────

describe('addLine', () => {
    it('adds a line priced from the catalogue and selects it', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 2 });

        expect(lineOf(lineUuid)).toMatchObject({
            order_uuid: orderUuid,
            line_number: 1,
            product_variant_id: PIZZA,
            product_id: 1,
            pos_category_id: 50,
            full_product_name: 'Pizza',
            quantity: 2,
            price_unit: '10.00',
            price_extra: '0',
            price_type: 'original',
            discount_percent: '0',
            tax_ids: [TVA20.id],
            uom_id: 1,
        });
        expect(state().selectedLineUuid).toBe(lineUuid);
        expect(orderOf(orderUuid).rev).toBeGreaterThan(0);
    });

    it('throws for an unknown order rather than silently dropping the sale', async () => {
        await createOrder();
        expect(() => addLine({ orderUuid: 'nope', variantId: PIZZA })).toThrow(/unknown order/);
    });

    it('names the line with its attribute values and adds their price extras', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({
            orderUuid,
            variantId: FRIES,
            attributeLineValueIds: [LV_KETCHUP.id, LV_TRUFFLE.id],
        });

        expect(lineOf(lineUuid)).toMatchObject({
            full_product_name: 'Frites (Ketchup, Truffe)',
            price_unit: '4.00',
            price_extra: '1.50',
        });
    });

    it('numbers lines in insertion order', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });
        addLine({ orderUuid, variantId: COLA });
        expect(linesOf(state(), orderUuid).map((l) => l.line_number)).toEqual([1, 2]);
    });
});

describe('attributeExtraOf', () => {
    it('sums the chosen values price extras as a decimal string', () => {
        expect(attributeExtraOf([LV_KETCHUP.id, LV_TRUFFLE.id])).toBe('1.50');
        expect(attributeExtraOf([])).toBe('0');
        expect(attributeExtraOf([999999])).toBe('0');
    });
});

describe('line merging (REG-101)', () => {
    it('merges a second tap of the same product into the first line', async () => {
        const orderUuid = await createOrder();
        const first = addLine({ orderUuid, variantId: PIZZA });
        const second = addLine({ orderUuid, variantId: PIZZA });

        expect(second).toBe(first);
        expect(linesOf(state(), orderUuid)).toHaveLength(1);
        expect(lineOf(first).quantity).toBe(2);
    });

    it('does not merge when skipMerge is set', async () => {
        const orderUuid = await createOrder();
        const first = addLine({ orderUuid, variantId: PIZZA });
        const second = addLine({ orderUuid, variantId: PIZZA, skipMerge: true });

        expect(second).not.toBe(first);
        expect(linesOf(state(), orderUuid)).toHaveLength(2);
    });

    it.each([
        { label: 'a different customer note', input: { customerNote: 'no basil' } },
        { label: 'a different internal note', input: { internalNote: [{ text: 'rush', color_index: 1 }] } },
        { label: 'a different price', input: { priceUnit: '9.00' } },
        { label: 'a different price type', input: { priceType: 'manual' as const } },
        { label: 'a different discount', input: { discountPercent: '10' } },
        { label: 'a refund link', input: { refundedLineUuid: 'other-line' } },
        { label: 'a combo parent', input: { comboParentUuid: 'parent-line' } },
        { label: 'a combo item', input: { comboItemId: 5 } },
    ])('keeps lines apart when they differ by $label', async ({ input }) => {
        const orderUuid = await createOrder();
        const first = addLine({ orderUuid, variantId: PIZZA });
        const second = addLine({ orderUuid, variantId: PIZZA, ...input });

        expect(second).not.toBe(first);
        expect(linesOf(state(), orderUuid)).toHaveLength(2);
    });

    it('keeps lines on different courses apart', async () => {
        const orderUuid = await createOrder();
        const first = addLine({ orderUuid, variantId: PIZZA });
        const secondCourse = addCourse(orderUuid);
        const second = addLine({ orderUuid, variantId: PIZZA, courseUuid: secondCourse });

        expect(second).not.toBe(first);
        expect(linesOf(state(), orderUuid)).toHaveLength(2);
    });

    it('never merges a non-groupable unit of measure', async () => {
        const orderUuid = await createOrder();
        const first = addLine({ orderUuid, variantId: BULK, quantity: 0.5 });
        const second = addLine({ orderUuid, variantId: BULK, quantity: 0.75 });

        expect(second).not.toBe(first);
        expect(canMergeLines(lineOf(first), lineOf(second))).toBe(false);
    });

    it('merges identical notes', async () => {
        const orderUuid = await createOrder();
        const first = addLine({ orderUuid, variantId: PIZZA, customerNote: 'no basil' });
        const second = addLine({ orderUuid, variantId: PIZZA, customerNote: 'no basil' });
        expect(second).toBe(first);
        expect(lineOf(first).quantity).toBe(2);
    });

    it('keeps lines apart when the attribute price extra differs', async () => {
        const orderUuid = await createOrder();
        const plain = addLine({ orderUuid, variantId: FRIES, attributeLineValueIds: [LV_KETCHUP.id] });
        const truffled = addLine({ orderUuid, variantId: FRIES, attributeLineValueIds: [LV_TRUFFLE.id] });

        expect(truffled).not.toBe(plain);
    });

    /**
     * Two lines of the same variant with *different but equally priced* attribute values must not
     * merge: ringing "Frites (Ketchup)" then "Frites (Mayo)" and getting one "2 × Frites (Ketchup)"
     * line means the kitchen never hears about the mayo. Odoo's `Orderline.can_be_merged_with`
     * compares `full_product_name` precisely to stop this.
     */
    it('keeps lines apart when free attribute values differ', async () => {
        const orderUuid = await createOrder();
        const ketchup = addLine({ orderUuid, variantId: FRIES, attributeLineValueIds: [LV_KETCHUP.id] });
        const mayo = addLine({ orderUuid, variantId: FRIES, attributeLineValueIds: [LV_MAYO.id] });

        expect(mayo).not.toBe(ketchup);
        expect(linesOf(state(), orderUuid).map((l) => l.full_product_name)).toEqual([
            'Frites (Ketchup)',
            'Frites (Mayo)',
        ]);
    });
});

describe('setQuantity', () => {
    it('sets the quantity and rounds to three decimals', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA });

        setQuantity(lineUuid, 2.00049);
        expect(lineOf(lineUuid).quantity).toBe(2);

        setQuantity(lineUuid, 1.23449);
        expect(lineOf(lineUuid).quantity).toBe(1.234);

        setQuantity(lineUuid, 1.2345);
        expect(lineOf(lineUuid).quantity).toBe(1.235);
    });

    it('accepts zero and negative quantities', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA });

        setQuantity(lineUuid, 0);
        expect(lineOf(lineUuid).quantity).toBe(0);
        setQuantity(lineUuid, -2);
        expect(lineOf(lineUuid).quantity).toBe(-2);
    });

    it('scales combo children with their parent (REG-112)', async () => {
        const orderUuid = await createOrder();
        const parent = addLine({ orderUuid, variantId: PIZZA, quantity: 1, skipMerge: true });
        const child = addLine({
            orderUuid,
            variantId: COLA,
            quantity: 2,
            comboParentUuid: parent,
            skipMerge: true,
        });

        setQuantity(parent, 3);
        expect(lineOf(child).quantity).toBe(6);
    });

    it('ignores an unknown line', async () => {
        const orderUuid = await createOrder();
        const before = orderOf(orderUuid).rev;
        setQuantity('nope', 5);
        expect(orderOf(orderUuid).rev).toBe(before);
    });
});

describe('reduceQuantity (REG-107)', () => {
    it('edits the line directly when the kitchen has seen nothing', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 3 });

        expect(reduceQuantity(lineUuid, 1)).toBe(lineUuid);
        expect(lineOf(lineUuid).quantity).toBe(1);
        expect(linesOf(state(), orderUuid)).toHaveLength(1);
    });

    it('adds a compensating negative line when reducing below what was sent', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 3 });
        markPrepSent(orderUuid);

        const compensating = reduceQuantity(lineUuid, 1);
        expect(compensating).not.toBe(lineUuid);
        expect(lineOf(lineUuid).quantity).toBe(3);
        expect(lineOf(compensating).quantity).toBe(-2);
        expect(lineOf(compensating).full_product_name).toBe('Pizza');
    });

    it('edits directly when the new quantity is still at or above the sent quantity', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 3 });
        markPrepSent(orderUuid);

        expect(reduceQuantity(lineUuid, 3)).toBe(lineUuid);
        expect(linesOf(state(), orderUuid)).toHaveLength(1);
    });

    /**
     * The compensating quantity is measured against what the kitchen was *sent*, not against the
     * line's current quantity. When the cashier added more of an item after firing and then reduces
     * below the fired quantity, a `nextQuantity - line.quantity` delta would be too negative and the
     * order would net −1 instead of 1 — a refund the customer never asked for.
     */
    it('nets out correctly when the line grew after the kitchen send', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 3 });
        markPrepSent(orderUuid);
        setQuantity(lineUuid, 5);

        reduceQuantity(lineUuid, 1);

        const net = linesOf(state(), orderUuid).reduce((sum, line) => sum + line.quantity, 0);
        expect(net).toBe(1);
    });
});

describe('setPriceUnit / setDiscount', () => {
    it('a price override flips the line to a manual price', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA });

        setPriceUnit(lineUuid, '7.50');
        expect(lineOf(lineUuid)).toMatchObject({ price_unit: '7.50', price_type: 'manual', is_edited: true });
        expect(orderTotals(orderUuid)).toMatchObject({ subtotal: '7.50', tax: '1.50', total: '9.00' });
    });

    it.each([
        { input: '15', expected: '15' },
        { input: '0', expected: '0' },
        { input: '100', expected: '100' },
        { input: '-5', expected: '0' },
        { input: '150', expected: '100' },
        { input: '12.5', expected: '12.5' },
    ])('clamps a $input % discount to $expected', async ({ input, expected }) => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA });
        setDiscount(lineUuid, input);
        expect(lineOf(lineUuid).discount_percent).toBe(expected);
    });

    it('a discount lowers the taxable base', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 2 });
        setDiscount(lineUuid, '10');

        expect(orderTotals(orderUuid)).toMatchObject({
            subtotal: '18.00',
            tax: '3.60',
            total: '21.60',
            discountTotal: '2.00',
        });
    });
});

describe('removeLine', () => {
    it('drops the line, clears the selection and bumps the order', async () => {
        const orderUuid = await createOrder();
        const first = addLine({ orderUuid, variantId: PIZZA });
        const second = addLine({ orderUuid, variantId: COLA });

        removeLine(second);
        expect(state().lines[second]).toBeUndefined();
        expect(state().linesByOrder[orderUuid]).toEqual([first]);
        expect(state().selectedLineUuid).toBeNull();
        expect(orderOf(orderUuid).is_edited).toBe(true);
    });

    it('takes the combo children with it', async () => {
        const orderUuid = await createOrder();
        const parent = addLine({ orderUuid, variantId: PIZZA, skipMerge: true });
        const child = addLine({ orderUuid, variantId: COLA, comboParentUuid: parent, skipMerge: true });

        removeLine(parent);
        expect(state().lines[child]).toBeUndefined();
        expect(state().childLines[parent]).toBeUndefined();
    });

    it('records a tombstone only for a line the server has already seen', async () => {
        const orderUuid = await createOrder();
        const unsynced = addLine({ orderUuid, variantId: PIZZA });
        removeLine(unsynced);
        expect(orderOf(orderUuid).baseline).toBeNull();

        const known = addLine({ orderUuid, variantId: COLA });
        applyServerAck(orderUuid, { id: 42, lineIds: { [known]: 900 }, serverRev: 'r1' });
        removeLine(known);

        expect(orderOf(orderUuid).baseline?.deletedLineUuids).toEqual([known]);
        expect(buildOrderCommand(state(), orderUuid)?.lines).toEqual([{ op: 'delete', uuid: known }]);
    });

    it('ignores an unknown line', () => {
        expect(() => removeLine('nope')).not.toThrow();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Refunds
// ─────────────────────────────────────────────────────────────────────────────

describe('createRefundOrder (REG-270 … REG-272)', () => {
    it('creates a linked order with negative quantities and negative totals', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 2 });
        validateOrder(orderUuid);

        const refundUuid = (await createRefundOrder(orderUuid, { [lineUuid]: 1 })) as string;
        const refund = orderOf(refundUuid);

        expect(refund).toMatchObject({ is_refund: true, refunded_order_uuid: orderUuid, state: 'draft' });

        const refundLines = linesOf(state(), refundUuid);
        expect(refundLines).toHaveLength(1);
        expect(refundLines[0]).toMatchObject({
            quantity: -1,
            price_unit: '10.00',
            refunded_line_uuid: lineUuid,
        });
        expect(orderTotals(refundUuid)).toMatchObject({ subtotal: '-10.00', tax: '-2.00', total: '-12.00' });
    });

    it('books the refunded quantity on the original order (REG-272)', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 3 });

        await createRefundOrder(orderUuid, { [lineUuid]: 2 });
        expect(lineOf(lineUuid).refunded_quantity).toBe(2);

        await createRefundOrder(orderUuid, { [lineUuid]: 5 });
        expect(lineOf(lineUuid).refunded_quantity).toBe(3);
    });

    it('never merges refund lines with each other', async () => {
        const orderUuid = await createOrder();
        const a = addLine({ orderUuid, variantId: PIZZA, quantity: 1, skipMerge: true });
        const b = addLine({ orderUuid, variantId: PIZZA, quantity: 1, skipMerge: true });

        const refundUuid = (await createRefundOrder(orderUuid, { [a]: 1, [b]: 1 })) as string;
        expect(linesOf(state(), refundUuid)).toHaveLength(2);
    });

    it('returns null for an unknown order or an empty selection', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });
        expect(await createRefundOrder('nope', {})).toBeNull();
        expect(await createRefundOrder(orderUuid, {})).toBeNull();
    });

    it('copies the customer, pricelist and fiscal position of the original', async () => {
        const orderUuid = await createOrder({ customerId: 5, pricelistId: 7, fiscalPositionId: 9 });
        const lineUuid = addLine({ orderUuid, variantId: PIZZA });

        const refundUuid = (await createRefundOrder(orderUuid, { [lineUuid]: 1 })) as string;
        expect(orderOf(refundUuid)).toMatchObject({ customer_id: 5, pricelist_id: 7, fiscal_position_id: 9 });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Courses
// ─────────────────────────────────────────────────────────────────────────────

describe('courses (RST-081 … RST-087)', () => {
    it('the first course absorbs the existing lines and opens an empty second one', async () => {
        const orderUuid = await createOrder();
        const pizza = addLine({ orderUuid, variantId: PIZZA });

        const nextCourse = addCourse(orderUuid, 'Entrée');
        const courses = coursesOf(state(), orderUuid);

        expect(courses.map((c) => [c.index, c.name])).toEqual([
            [1, 'Entrée'],
            [2, null],
        ]);
        expect(lineOf(pizza).course_uuid).toBe(courses[0]?.uuid);
        expect(nextCourse).toBe(courses[1]?.uuid);
    });

    it('a later course is appended, not paired', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });
        addCourse(orderUuid);
        addCourse(orderUuid, 'Dessert');

        expect(coursesOf(state(), orderUuid).map((c) => [c.index, c.name])).toEqual([
            [1, null],
            [2, null],
            [3, 'Dessert'],
        ]);
    });

    it('new lines attach to the last course (RST-082)', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });
        const second = addCourse(orderUuid);

        const cola = addLine({ orderUuid, variantId: COLA });
        expect(lineOf(cola).course_uuid).toBe(second);
    });

    it('setLineCourse moves a line and its combo children together', async () => {
        const orderUuid = await createOrder();
        const parent = addLine({ orderUuid, variantId: PIZZA, skipMerge: true });
        const child = addLine({ orderUuid, variantId: COLA, comboParentUuid: parent, skipMerge: true });
        const second = addCourse(orderUuid);

        setLineCourse(parent, second);
        expect(lineOf(parent).course_uuid).toBe(second);
        expect(lineOf(child).course_uuid).toBe(second);

        setLineCourse(parent, null);
        expect(lineOf(parent).course_uuid).toBeNull();
    });

    it('fireCourse stamps the course once', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });
        addCourse(orderUuid);
        const first = coursesOf(state(), orderUuid)[0];

        fireCourse(orderUuid, first?.uuid as string);
        const fired = state().courses[first?.uuid as string];
        expect(fired?.fired).toBe(true);
        expect(fired?.fired_at).not.toBeNull();

        const at = fired?.fired_at;
        fireCourse(orderUuid, first?.uuid as string);
        expect(state().courses[first?.uuid as string]?.fired_at).toBe(at);
    });

    it('cleanCourses drops the trailing empty unfired course and renumbers', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });
        addCourse(orderUuid);
        expect(coursesOf(state(), orderUuid)).toHaveLength(2);

        cleanCourses(orderUuid);
        const courses = coursesOf(state(), orderUuid);
        expect(courses).toHaveLength(1);
        expect(courses[0]?.index).toBe(1);
    });

    it('cleanCourses keeps a trailing course that has lines or has been fired', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });
        const second = addCourse(orderUuid);
        addLine({ orderUuid, variantId: COLA, courseUuid: second });

        cleanCourses(orderUuid);
        expect(coursesOf(state(), orderUuid)).toHaveLength(2);

        const third = addCourse(orderUuid);
        fireCourse(orderUuid, third);
        cleanCourses(orderUuid);
        expect(coursesOf(state(), orderUuid)).toHaveLength(3);
    });

    it('cleanCourses is a no-op when there is nothing to drop', async () => {
        const orderUuid = await createOrder();
        const before = orderOf(orderUuid).rev;
        cleanCourses(orderUuid);
        expect(orderOf(orderUuid).rev).toBe(before);
    });

    /**
     * RST-087 says "drop trailing empty unfired courses" — plural. Inspecting only the last course
     * would need one call per course and leave a phantom "Service 2" on the bill after the first.
     */
    it('cleanCourses drops a whole run of trailing empty courses', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });
        addCourse(orderUuid); // courses 1 (with the pizza) + 2 (empty)
        addCourse(orderUuid); // course 3 (empty)

        cleanCourses(orderUuid);
        expect(coursesOf(state(), orderUuid)).toHaveLength(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Payments
// ─────────────────────────────────────────────────────────────────────────────

describe('payments', () => {
    it('adds a payment and recomputes what is still due', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA }); // 12.00 TTC

        const paymentUuid = addPayment(orderUuid, 1, '5.00');
        expect(state().payments[paymentUuid]).toMatchObject({
            order_uuid: orderUuid,
            payment_method_id: 1,
            amount: '5.00',
            is_change: false,
            is_refund: false,
            payment_status: 'done',
        });
        expect(orderTotals(orderUuid)).toMatchObject({ paid: '5.00', due: '7.00', change: '0.00' });
    });

    it('flags a negative payment as a refund', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA, quantity: -1 });
        const paymentUuid = addPayment(orderUuid, 1, '-12.00');
        expect(state().payments[paymentUuid]?.is_refund).toBe(true);
    });

    it('changing the amount changes the change due', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });
        const paymentUuid = addPayment(orderUuid, 1, '12.00');
        expect(orderTotals(orderUuid)).toMatchObject({ due: '0.00', change: '0.00' });

        setPaymentAmount(paymentUuid, '20.00');
        expect(state().payments[paymentUuid]?.rev).toBe(1);
        expect(orderTotals(orderUuid)).toMatchObject({ paid: '20.00', due: '0.00', change: '8.00' });
    });

    it('removing a payment puts the amount back on the tab', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });
        const paymentUuid = addPayment(orderUuid, 1, '12.00');

        removePayment(paymentUuid);
        expect(state().payments[paymentUuid]).toBeUndefined();
        expect(state().paymentsByOrder[orderUuid]).toEqual([]);
        expect(orderTotals(orderUuid)).toMatchObject({ paid: '0.00', due: '12.00' });
    });

    it('a failed terminal payment stops counting towards amount_paid', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });
        const paymentUuid = addPayment(orderUuid, 1, '12.00');

        setPaymentStatus(paymentUuid, 'failed', { card_brand: 'VISA', card_last4: '4242' });
        expect(state().payments[paymentUuid]).toMatchObject({ payment_status: 'failed', card_last4: '4242' });
        expect(orderTotals(orderUuid)).toMatchObject({ paid: '0.00', due: '12.00' });
    });

    it('splits a bill across two methods', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA, quantity: 2 }); // 24.00 TTC
        addPayment(orderUuid, 1, '10.00');
        addPayment(orderUuid, 2, '14.00');

        expect(paymentsOf(state(), orderUuid)).toHaveLength(2);
        expect(orderTotals(orderUuid)).toMatchObject({ paid: '24.00', due: '0.00', change: '0.00' });
    });

    it('ignores edits to an unknown payment', () => {
        expect(() => setPaymentAmount('nope', '1.00')).not.toThrow();
        expect(() => setPaymentStatus('nope', 'done')).not.toThrow();
        expect(() => removePayment('nope')).not.toThrow();
    });
});

describe('setTip (REG-220 / RST-121)', () => {
    it('rides on the configured tip product', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });

        setTip(orderUuid, '2.50');
        const tipLine = linesOf(state(), orderUuid).find((line) => line.product_id === 4);

        expect(tipLine).toMatchObject({ price_unit: '2.50', quantity: 1, price_type: 'manual' });
        expect(orderOf(orderUuid)).toMatchObject({ is_tipped: true, tip_amount: '2.50' });
    });

    it('updates the existing tip line instead of adding a second one', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });
        setTip(orderUuid, '2.50');
        setTip(orderUuid, '4.00');

        const tipLines = linesOf(state(), orderUuid).filter((line) => line.product_id === 4);
        expect(tipLines).toHaveLength(1);
        expect(tipLines[0]?.price_unit).toBe('4.00');
        expect(orderOf(orderUuid).tip_amount).toBe('4.00');
    });

    it('still records the tip on the order when no tip product is configured', async () => {
        install({
            products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00', tax_ids: [TVA20.id] })],
            variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
        });
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });

        setTip(orderUuid, '2.00');
        expect(linesOf(state(), orderUuid)).toHaveLength(1);
        expect(orderOf(orderUuid)).toMatchObject({ is_tipped: true, tip_amount: '2.00' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Order-level attributes
// ─────────────────────────────────────────────────────────────────────────────

describe('customer, pricelist and fiscal position', () => {
    const PRICELIST = [
        {
            id: 7,
            items: [
                {
                    id: 1,
                    appliedOn: 'product' as const,
                    productId: 1,
                    computePrice: 'fixed' as const,
                    fixedPrice: '8.00',
                    sequence: 1,
                },
            ],
        },
    ];

    function installWithPricelist(): void {
        install({ pricelists: PRICELIST });
    }

    it('resolveUnitPrice honours the order pricelist', async () => {
        installWithPricelist();
        const plain = await createOrder();
        expect(resolveUnitPrice(orderOf(plain), PIZZA, 1)).toBe('10.00');

        const discounted = await createOrder({ pricelistId: 7 });
        // The pricelist resolver works at PRICE_SCALE (4 decimals); the tax engine rounds later.
        expect(resolveUnitPrice(orderOf(discounted), PIZZA, 1)).toBe('8.0000');
    });

    it('switching the pricelist reprices catalogue-priced lines (REG-173)', async () => {
        installWithPricelist();
        const orderUuid = await createOrder();
        const pizza = addLine({ orderUuid, variantId: PIZZA });
        const cola = addLine({ orderUuid, variantId: COLA });

        setPricelist(orderUuid, 7);

        expect(orderOf(orderUuid).pricelist_id).toBe(7);
        expect(lineOf(pizza).price_unit).toBe('8.0000');
        // No rule matches the cola, so the resolver hands back its list price unchanged.
        expect(lineOf(cola).price_unit).toBe('3.0000');
        expect(orderTotals(orderUuid)).toMatchObject({ subtotal: '11.00', tax: '2.20', total: '13.20' });
    });

    it('never reprices a manually overridden line', async () => {
        installWithPricelist();
        const orderUuid = await createOrder();
        const pizza = addLine({ orderUuid, variantId: PIZZA });
        setPriceUnit(pizza, '5.00');

        setPricelist(orderUuid, 7);
        expect(lineOf(pizza).price_unit).toBe('5.00');
    });

    it('never reprices a combo child', async () => {
        installWithPricelist();
        const orderUuid = await createOrder();
        const parent = addLine({ orderUuid, variantId: COLA, skipMerge: true });
        const child = addLine({ orderUuid, variantId: PIZZA, comboParentUuid: parent, skipMerge: true });

        setPricelist(orderUuid, 7);
        expect(lineOf(child).price_unit).toBe('10.00');
    });

    it('assigning a customer applies only the pricelist and position the config allows (REG-155)', async () => {
        installWithPricelist();
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });

        setCustomer(orderUuid, 42);
        expect(orderOf(orderUuid).customer_id).toBe(42);

        applyCustomerDefaults(orderUuid, { pricelist_id: 7, fiscal_position_id: 9 });
        expect(orderOf(orderUuid)).toMatchObject({ pricelist_id: 7, fiscal_position_id: 9 });
    });

    it('ignores a customer pricelist that is not available on this register', async () => {
        installWithPricelist();
        const orderUuid = await createOrder();
        applyCustomerDefaults(orderUuid, { pricelist_id: 999, fiscal_position_id: 999 });
        expect(orderOf(orderUuid)).toMatchObject({ pricelist_id: null, fiscal_position_id: null });
    });

    it('a fiscal position that maps the tax away changes the totals, not the prices', async () => {
        install({
            fiscalPositions: new Map([
                [9, { id: 9, name: 'Export', mappings: [{ taxSrcId: TVA20.id, taxDestId: null }] }],
            ]),
        });
        const orderUuid = await createOrder();
        const pizza = addLine({ orderUuid, variantId: PIZZA });
        expect(orderTotals(orderUuid)).toMatchObject({ tax: '2.00', total: '12.00' });

        setFiscalPosition(orderUuid, 9);

        expect(lineOf(pizza).price_unit).toBe('10.00');
        expect(orderTotals(orderUuid)).toMatchObject({ subtotal: '10.00', tax: '0.00', total: '10.00' });
    });

    it('a preset overrides the pricelist and the fiscal position (REG-336)', async () => {
        install({
            pricelists: PRICELIST,
            presets: [makePreset({ id: 3, name: 'À emporter', pricelist_id: 7, fiscal_position_id: 9 })],
        });
        const orderUuid = await createOrder();

        setPreset(orderUuid, 3);
        expect(orderOf(orderUuid)).toMatchObject({
            pos_preset_id: 3,
            pricelist_id: 7,
            fiscal_position_id: 9,
        });
    });
});

describe('guest count and cashier', () => {
    it.each([
        { input: 4, expected: 4 },
        { input: 0, expected: 0 },
        { input: -3, expected: 0 },
        { input: 2.6, expected: 3 },
    ])('setGuestCount($input) → $expected', async ({ input, expected }) => {
        const orderUuid = await createOrder();
        setGuestCount(orderUuid, input);
        expect(orderOf(orderUuid).guest_count).toBe(expected);
    });

    it('an order with lines keeps its original cashier (REG-046)', async () => {
        const orderUuid = await createOrder();
        setEmployee(orderUuid, 7);
        expect(orderOf(orderUuid).employee_id).toBe(7);

        addLine({ orderUuid, variantId: PIZZA });
        setEmployee(orderUuid, 8);
        expect(orderOf(orderUuid).employee_id).toBe(7);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('validateOrder (REG-217)', () => {
    it('moves the order to paid and freezes the client amounts', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA, quantity: 2 });
        addPayment(orderUuid, 1, '30.00');

        validateOrder(orderUuid);
        const order = orderOf(orderUuid);

        expect(order.state).toBe('paid');
        expect(order.paid_at).not.toBeNull();
        expect(order).toMatchObject({
            amount_untaxed: '20.00',
            amount_tax: '4.00',
            amount_total: '24.00',
            amount_rounding: '0.00',
            amount_paid: '30.00',
            amount_change: '6.00',
            amount_due: '0.00',
            amount_discount: '0.00',
        });
    });

    it('records the discount total on a validated order', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 2 });
        setDiscount(lineUuid, '50');

        validateOrder(orderUuid);
        expect(orderOf(orderUuid)).toMatchObject({
            amount_untaxed: '10.00',
            amount_total: '12.00',
            amount_discount: '10.00',
        });
    });

    it('ignores an unknown order', () => {
        expect(() => validateOrder('nope')).not.toThrow();
    });
});

describe('cancelOrder / discardOrder', () => {
    it('cancelOrder stamps the reason and the time', async () => {
        const orderUuid = await createOrder();
        cancelOrder(orderUuid, 'client parti');
        expect(orderOf(orderUuid)).toMatchObject({ state: 'cancelled', cancel_reason: 'client parti' });
        expect(orderOf(orderUuid).cancelled_at).not.toBeNull();
    });

    it('discardOrder forgets a never-synced draft entirely', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });

        discardOrder(orderUuid);
        expect(state().orders[orderUuid]).toBeUndefined();
        expect(state().linesByOrder[orderUuid]).toBeUndefined();
        expect(state().selectedOrderUuid).toBeNull();
    });

    it('discardOrder cancels a synced order so the server hears about it', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });
        applyServerAck(orderUuid, { id: 77, serverRev: 'r1' });

        discardOrder(orderUuid);
        expect(orderOf(orderUuid).state).toBe('cancelled');
    });
});

describe('applyServerAck', () => {
    it('merges ids, adopts the authoritative amounts and resets the baseline', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA });
        const paymentUuid = addPayment(orderUuid, 1, '12.00');
        addCourse(orderUuid);
        const courseUuid = coursesOf(state(), orderUuid)[0]?.uuid as string;

        applyServerAck(orderUuid, {
            id: 501,
            name: 'SALLE/0042',
            sequence_number: 42,
            serverRev: 'rev-7',
            amounts: { amount_total: '12.00', amount_tax: '2.00' },
            lineIds: { [lineUuid]: 9001 },
            paymentIds: { [paymentUuid]: 9002 },
            courseIds: { [courseUuid]: 9003 },
        });

        expect(orderOf(orderUuid)).toMatchObject({
            id: 501,
            name: 'SALLE/0042',
            sequence_number: 42,
            syncState: 'synced',
            syncError: null,
            amount_total: '12.00',
        });
        expect(orderOf(orderUuid).baseline?.serverRev).toBe('rev-7');
        expect(lineOf(lineUuid).id).toBe(9001);
        expect(state().payments[paymentUuid]?.id).toBe(9002);
        expect(state().courses[courseUuid]?.id).toBe(9003);
    });

    it('rewrites create into update once the server has assigned ids (spec 03 §3.6.3)', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA });
        const paymentUuid = addPayment(orderUuid, 1, '12.00');

        const first = buildOrderCommand(state(), orderUuid);
        expect(first?.base_rev).toBeNull();
        expect(first?.lines.map((l) => l.op)).toEqual(['create']);
        expect(first?.payments.map((p) => p.op)).toEqual(['create']);

        applyServerAck(orderUuid, {
            id: 501,
            serverRev: 'rev-1',
            lineIds: { [lineUuid]: 9001 },
            paymentIds: { [paymentUuid]: 9002 },
        });
        setQuantity(lineUuid, 3);

        const second = buildOrderCommand(state(), orderUuid);
        expect(second?.base_rev).toBe('rev-1');
        expect(second?.lines.map((l) => l.op)).toEqual(['update']);
        expect(second?.payments.map((p) => p.op)).toEqual(['update']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Restaurant transfer / merge
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// Kitchen bookkeeping
// ─────────────────────────────────────────────────────────────────────────────

describe('markPrepSent / adoptPrepSnapshot', () => {
    it('records what the kitchen was told and clears the unsent counter', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 2 });

        const snapshot = markPrepSent(orderUuid, '2026-07-28T12:00:00.000Z');

        expect(snapshot.lines).toEqual({ [`${lineUuid}::|[]`]: 2 });
        expect(orderOf(orderUuid)).toMatchObject({
            prep_state: 'sent',
            unsent_change_count: 0,
            last_prep_sent_at: '2026-07-28T12:00:00.000Z',
        });
    });

    it('adopting a detail-less conflict snapshot does not re-report every line as new (KDS-057)', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 2 });

        // The conflict payload from the server carries only a version and a timestamp.
        adoptPrepSnapshot(orderUuid, { at: '2026-07-28T12:00:00.000Z', lines: {}, noteHash: '' });

        const adopted = orderOf(orderUuid).last_prep_snapshot;
        expect(adopted?.at).toBe('2026-07-28T12:00:00.000Z');
        expect(adopted?.lines).toEqual({ [`${lineUuid}::|[]`]: 2 });

        // Nothing changed locally since the other till fired, so there is nothing left to send.
        expect(
            computePrepDelta(linesOf(state(), orderUuid), coursesOf(state(), orderUuid), adopted ?? null),
        ).toMatchObject({ nbrOfChanges: 0, changes: [] });
    });

    it('keeps a server snapshot that does carry line detail', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA, quantity: 2 });

        const server = { at: '2026-07-28T12:00:00.000Z', lines: { 'other::|[]': 4 }, noteHash: 'x' };
        adoptPrepSnapshot(orderUuid, server);

        expect(orderOf(orderUuid).last_prep_snapshot).toEqual(server);
    });
});

describe('selection helpers', () => {
    it('selecting an order clears the selected line', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA });
        expect(state().selectedLineUuid).not.toBeNull();

        useOrderStore.getState().selectOrder(orderUuid);
        expect(state().selectedLineUuid).toBeNull();
    });

    it('paymentsOf reads back what was added, keyed by order', async () => {
        const a = await createOrder();
        const b = await createOrder();
        addPayment(a, 1, '5.00');
        addPayment(b, 1, '9.00');

        expect(paymentsOf(state(), a).map((p) => p.amount)).toEqual(['5.00']);
        expect(paymentsOf(state(), b).map((p) => p.amount)).toEqual(['9.00']);
        expect(paymentsOf(state(), asUuid('nope'))).toEqual([]);
    });
});
