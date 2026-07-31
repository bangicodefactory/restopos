import { asUuid } from '@domain/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { useOrderStore } from '../state/order-store';
import {
    buildCatalog,
    installCatalog,
    makeConfig,
    makeProduct,
    makeTax,
    makeVariant,
    resetRegisterState,
    type CatalogParts,
} from './__fixtures__/catalog';
import { makeCourse, makeLine, makeOrder, makePayment, resetRowSequences } from './__fixtures__/rows';
import { addLine, addPayment, createOrder, setDiscount, setQuantity } from './order-actions';
import {
    EMPTY_TOTALS,
    amountPerGuest,
    computeTotals,
    effectiveUnitPrice,
    groupLinesByCourse,
    invalidateTotals,
    orderTotals,
    settledPayments,
} from './totals';

/**
 * Unit coverage for spec 03 §3.4.5 — order totals against `@domain/tax`.
 *
 * Every expected amount is an explicit decimal string; nothing here is derived by arithmetic in the
 * test, which is the only way a rounding regression shows up as a diff rather than as agreement.
 */

const EXCLUDED = makeTax({ id: 1, name: 'TVA 20', amount: '20', tax_group_id: 1 });
const INCLUDED = makeTax({ id: 2, name: 'TVA 20 incl', amount: '20', price_include: true, tax_group_id: 2 });
const FIXED = makeTax({ id: 3, name: 'Eco', amount_type: 'fixed', amount: '0.50', tax_group_id: 3 });
const BASE_AFFECTING = makeTax({
    id: 4,
    name: 'Base 10',
    amount: '10',
    include_base_amount: true,
    tax_group_id: 4,
    sequence: 1,
});
const COMPOUNDED = makeTax({
    id: 5,
    name: 'Surtaxe 5',
    amount: '5',
    is_base_affected: true,
    tax_group_id: 5,
    sequence: 2,
});

const ALL_TAXES = [EXCLUDED, INCLUDED, FIXED, BASE_AFFECTING, COMPOUNDED];

function catalog(parts: CatalogParts = {}) {
    return buildCatalog({ taxes: ALL_TAXES, config: makeConfig(), ...parts });
}

function totalsOf(
    lines: Parameters<typeof computeTotals>[1],
    parts: CatalogParts = {},
    order = makeOrder(),
    payments: Parameters<typeof computeTotals>[2] = [],
) {
    return computeTotals(order, lines, payments, catalog(parts));
}

beforeEach(() => {
    resetRowSequences();
});

describe('effectiveUnitPrice', () => {
    it('adds the attribute extra to the catalogue price', () => {
        expect(effectiveUnitPrice(makeLine({ price_unit: '10.00', price_extra: '1.50' }))).toBe('11.50');
    });

    it('leaves a zero extra alone', () => {
        expect(effectiveUnitPrice(makeLine({ price_unit: '10.00', price_extra: '0' }))).toBe('10.00');
    });
});

describe('tax engine wiring', () => {
    it('computes a tax-excluded line', () => {
        const totals = totalsOf([makeLine({ tax_ids: [EXCLUDED.id], price_unit: '10.00' })]);
        expect(totals).toMatchObject({ subtotal: '10.00', tax: '2.00', total: '12.00', roundedTotal: '12.00' });
        expect(totals.taxGroups).toEqual([{ taxGroupId: 1, base: '10.00', amount: '2.00' }]);
    });

    it('unpacks a tax-included price into base and tax', () => {
        const totals = totalsOf([makeLine({ tax_ids: [INCLUDED.id], price_unit: '12.00' })]);
        expect(totals).toMatchObject({ subtotal: '10.00', tax: '2.00', total: '12.00' });
    });

    it('applies a fixed tax per unit', () => {
        const totals = totalsOf([makeLine({ tax_ids: [FIXED.id], price_unit: '10.00', quantity: 2 })]);
        expect(totals).toMatchObject({ subtotal: '20.00', tax: '1.00', total: '21.00' });
    });

    it('compounds a tax on top of a base-affecting one', () => {
        const totals = totalsOf([
            makeLine({ tax_ids: [BASE_AFFECTING.id, COMPOUNDED.id], price_unit: '100.00' }),
        ]);
        expect(totals).toMatchObject({ subtotal: '100.00', tax: '15.50', total: '115.50' });
        expect(totals.taxGroups).toEqual([
            { taxGroupId: 4, base: '100.00', amount: '10.00' },
            // 5 % of 110.00, not of 100.00 — that is the whole point of `include_base_amount`.
            { taxGroupId: 5, base: '110.00', amount: '5.50' },
        ]);
    });

    it('drops a tax the fiscal position maps to nothing', () => {
        const fiscalPositions = new Map([
            [9, { id: 9, name: 'Export', mappings: [{ taxSrcId: EXCLUDED.id, taxDestId: null }] }],
        ]);
        const totals = totalsOf(
            [makeLine({ tax_ids: [EXCLUDED.id], price_unit: '10.00' })],
            { fiscalPositions },
            makeOrder({ fiscal_position_id: 9 }),
        );
        expect(totals).toMatchObject({ subtotal: '10.00', tax: '0.00', total: '10.00' });
        expect(totals.taxGroups).toEqual([]);
    });

    it('taxes the attribute extra along with the base price', () => {
        const totals = totalsOf([
            makeLine({ tax_ids: [EXCLUDED.id], price_unit: '10.00', price_extra: '1.50' }),
        ]);
        expect(totals).toMatchObject({ subtotal: '11.50', tax: '2.30', total: '13.80' });
    });
});

describe('discounts', () => {
    it('discounts the taxable base, not the total', () => {
        const totals = totalsOf([
            makeLine({ tax_ids: [EXCLUDED.id], price_unit: '10.00', quantity: 2, discount_percent: '10' }),
        ]);
        expect(totals).toMatchObject({
            subtotal: '18.00',
            tax: '3.60',
            total: '21.60',
            discountTotal: '2.00',
        });
    });

    it('reports the discount total across lines', () => {
        const totals = totalsOf([
            makeLine({ tax_ids: [], price_unit: '10.00', quantity: 2, discount_percent: '50' }),
            makeLine({ tax_ids: [], price_unit: '4.00', quantity: 1, discount_percent: '25' }),
        ]);
        expect(totals).toMatchObject({ subtotal: '13.00', discountTotal: '11.00' });
    });

    it('carries a fractional discount percentage without a float artefact', () => {
        const totals = totalsOf([
            makeLine({ tax_ids: [EXCLUDED.id], price_unit: '10.00', quantity: 3, discount_percent: '33.333' }),
        ]);
        expect(totals).toMatchObject({ subtotal: '20.00', tax: '4.00', discountTotal: '10.00' });
    });
});

describe('refund sign', () => {
    it('carries the negative quantity straight through to every total', () => {
        const totals = totalsOf([makeLine({ tax_ids: [EXCLUDED.id], price_unit: '10.00', quantity: -1 })]);
        expect(totals).toMatchObject({
            subtotal: '-10.00',
            tax: '-2.00',
            total: '-12.00',
            roundedTotal: '-12.00',
            quantityCount: '-1',
        });
        expect(totals.taxGroups).toEqual([{ taxGroupId: 1, base: '-10.00', amount: '-2.00' }]);
    });

    it('presents the money owed back to the customer as change, never as an amount due', () => {
        const totals = totalsOf([makeLine({ tax_ids: [EXCLUDED.id], price_unit: '10.00', quantity: -1 })]);
        expect(totals.due).toBe('0.00');
        expect(totals.change).toBe('12.00');
    });

    it('nets a refund line against a sale line', () => {
        const totals = totalsOf([
            makeLine({ tax_ids: [EXCLUDED.id], price_unit: '10.00', quantity: 3 }),
            makeLine({ tax_ids: [EXCLUDED.id], price_unit: '10.00', quantity: -1 }),
        ]);
        expect(totals).toMatchObject({ subtotal: '20.00', tax: '4.00', total: '24.00', quantityCount: '2' });
    });
});

describe('rounding', () => {
    const three = [
        makeLine({ uuid: asUuid('a'), tax_ids: [EXCLUDED.id], price_unit: '0.99' }),
        makeLine({ uuid: asUuid('b'), tax_ids: [EXCLUDED.id], price_unit: '0.99' }),
        makeLine({ uuid: asUuid('c'), tax_ids: [EXCLUDED.id], price_unit: '0.99' }),
    ];

    it('rounds per line by default: three 0.198 taxes become 0.60', () => {
        expect(totalsOf(three, { config: makeConfig({ tax_rounding_method: 'round_per_line' }) })).toMatchObject({
            subtotal: '2.97',
            tax: '0.60',
            total: '3.57',
        });
    });

    it('rounds globally when configured: 2.97 × 20 % is 0.59', () => {
        expect(totalsOf(three, { config: makeConfig({ tax_rounding_method: 'round_globally' }) })).toMatchObject({
            subtotal: '2.97',
            tax: '0.59',
            total: '3.56',
        });
    });

    it('applies cash rounding to the nearest 0.05 and reports the delta', () => {
        const totals = totalsOf([makeLine({ tax_ids: [EXCLUDED.id], price_unit: '3.30' })], {
            cashRounding: { rounding: '0.05', method: 'half_up', strategy: 'biggest_tax' },
        });
        expect(totals).toMatchObject({ total: '3.95', roundedTotal: '3.95', rounding: '-0.01' });
    });

    it('rounds up when the cash-rounding method says so', () => {
        const totals = totalsOf([makeLine({ tax_ids: [EXCLUDED.id], price_unit: '3.30' })], {
            cashRounding: { rounding: '0.05', method: 'up', strategy: 'biggest_tax' },
        });
        expect(totals).toMatchObject({ total: '4.00', roundedTotal: '4.00', rounding: '0.04' });
    });

    it('leaves a total already on the rounding step untouched', () => {
        const totals = totalsOf([makeLine({ tax_ids: [], price_unit: '3.95' })], {
            cashRounding: { rounding: '0.05', method: 'half_up', strategy: 'biggest_tax' },
        });
        expect(totals).toMatchObject({ roundedTotal: '3.95', rounding: '0.00' });
    });

    it('keeps a fractional quantity out of the money maths', () => {
        const totals = totalsOf([makeLine({ tax_ids: [EXCLUDED.id], price_unit: '12.00', quantity: 1.5 })]);
        expect(totals).toMatchObject({ subtotal: '18.00', tax: '3.60', quantityCount: '1.5' });
    });
});

describe('payments', () => {
    it('excludes the change line, failures and cancellations from amount_paid', () => {
        const payments = [
            makePayment({ amount: '10.00' }),
            makePayment({ amount: '-2.00', is_change: true }),
            makePayment({ amount: '5.00', payment_status: 'failed' }),
            makePayment({ amount: '5.00', payment_status: 'cancelled' }),
        ];
        expect(settledPayments(payments)).toHaveLength(1);
        const totals = totalsOf([makeLine({ tax_ids: [], price_unit: '12.00' })], {}, makeOrder(), payments);
        expect(totals).toMatchObject({ paid: '10.00', due: '2.00', change: '0.00' });
    });

    it('reports change once the customer has overpaid', () => {
        const totals = totalsOf(
            [makeLine({ tax_ids: [EXCLUDED.id], price_unit: '10.00' })],
            {},
            makeOrder(),
            [makePayment({ amount: '20.00' })],
        );
        expect(totals).toMatchObject({ paid: '20.00', due: '0.00', change: '8.00' });
    });

    it('an order with no lines but a payment is all change', () => {
        const totals = totalsOf([], {}, makeOrder(), [makePayment({ amount: '5.00' })]);
        expect(totals).toMatchObject({ ...EMPTY_TOTALS, paid: '5.00', change: '5.00' });
    });

    it('an order with nothing at all is EMPTY_TOTALS', () => {
        expect(totalsOf([])).toEqual(EMPTY_TOTALS);
    });
});

describe('orderTotals memoisation', () => {
    const PIZZA = 101;

    beforeEach(() => {
        resetRegisterState();
        installCatalog({
            taxes: ALL_TAXES,
            config: makeConfig(),
            products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00', tax_ids: [EXCLUDED.id] })],
            variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
        });
    });

    it('returns EMPTY_TOTALS for a null or unknown order', () => {
        expect(orderTotals(null)).toBe(EMPTY_TOTALS);
        expect(orderTotals('nope')).toBe(EMPTY_TOTALS);
    });

    it('returns the identical object until something changes', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA, quantity: 1 });

        const first = orderTotals(orderUuid);
        expect(orderTotals(orderUuid)).toBe(first);
        expect(first).toMatchObject({ subtotal: '10.00', tax: '2.00', total: '12.00' });
    });

    it('recomputes after a quantity change', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 1 });

        const before = orderTotals(orderUuid);
        setQuantity(lineUuid, 2);
        const after = orderTotals(orderUuid);

        expect(after).not.toBe(before);
        expect(after).toMatchObject({ subtotal: '20.00', tax: '4.00', total: '24.00' });
    });

    it('recomputes after a discount change', async () => {
        const orderUuid = await createOrder();
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 1 });
        setDiscount(lineUuid, '25');

        expect(orderTotals(orderUuid)).toMatchObject({
            subtotal: '7.50',
            tax: '1.50',
            total: '9.00',
            discountTotal: '2.50',
        });
    });

    it('recomputes when a payment is added, even though the order graph is unchanged', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA, quantity: 1 });
        const before = orderTotals(orderUuid);

        addPayment(orderUuid, 1, '12.00');
        const after = orderTotals(orderUuid);

        expect(after).not.toBe(before);
        expect(after).toMatchObject({ paid: '12.00', due: '0.00', change: '0.00' });
    });

    it('invalidateTotals() drops the cache for one order or for all of them', async () => {
        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA, quantity: 1 });

        const first = orderTotals(orderUuid);
        invalidateTotals(orderUuid);
        const second = orderTotals(orderUuid);
        expect(second).not.toBe(first);
        expect(second).toEqual(first);

        invalidateTotals();
        expect(orderTotals(orderUuid)).not.toBe(second);
    });
});

describe('amountPerGuest', () => {
    it.each([
        { total: '24.00', guests: 0, expected: '24.00' },
        { total: '24.00', guests: 1, expected: '24.00' },
        { total: '24.00', guests: 2, expected: '12.00' },
        { total: '10.00', guests: 3, expected: '3.33' },
    ])('$total over $guests guests → $expected', ({ total, guests, expected }) => {
        expect(amountPerGuest(total, guests)).toBe(expected);
    });
});

describe('groupLinesByCourse', () => {
    it('returns one anonymous group when the order has no courses', () => {
        resetRegisterState();
        const state = useOrderStore.getState();
        state.mutate((draft) => {
            const line = makeLine({ uuid: asUuid('l1'), order_uuid: asUuid('o1') });
            draft.lines[line.uuid] = line;
            draft.linesByOrder['o1'] = [line.uuid];
        });

        const groups = groupLinesByCourse(useOrderStore.getState(), 'o1');
        expect(groups).toHaveLength(1);
        expect(groups[0]?.course).toBeNull();
        expect(groups[0]?.lines.map((l) => l.uuid)).toEqual(['l1']);
    });

    it('groups by course in index order and puts unassigned lines last', () => {
        resetRegisterState();
        useOrderStore.getState().mutate((draft) => {
            const second = makeCourse({ uuid: asUuid('c2'), order_uuid: asUuid('o1'), index: 2 });
            const first = makeCourse({ uuid: asUuid('c1'), order_uuid: asUuid('o1'), index: 1 });
            draft.courses[first.uuid] = first;
            draft.courses[second.uuid] = second;
            // Deliberately indexed out of order — `coursesOf` sorts.
            draft.coursesByOrder['o1'] = [second.uuid, first.uuid];

            const lines = [
                makeLine({ uuid: asUuid('l1'), order_uuid: asUuid('o1'), course_uuid: asUuid('c2') }),
                makeLine({ uuid: asUuid('l2'), order_uuid: asUuid('o1'), course_uuid: asUuid('c1') }),
                makeLine({ uuid: asUuid('l3'), order_uuid: asUuid('o1') }),
            ];
            for (const line of lines) draft.lines[line.uuid] = line;
            draft.linesByOrder['o1'] = lines.map((l) => l.uuid);
        });

        const groups = groupLinesByCourse(useOrderStore.getState(), 'o1');
        expect(groups.map((g) => [g.course?.index ?? null, g.lines.map((l) => l.uuid)])).toEqual([
            [1, ['l2']],
            [2, ['l1']],
            [null, ['l3']],
        ]);
    });
});
