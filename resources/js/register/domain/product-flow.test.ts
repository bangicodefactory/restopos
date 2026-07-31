import { beforeEach, describe, expect, it } from 'vitest';

import { setCatalog } from '../data/catalog';
import { linesOf, useOrderStore } from '../state/order-store';
import { useUiStore } from '../state/ui-store';
import {
    buildCatalog,
    installCatalog,
    makeProduct,
    makeVariant,
    resetRegisterState,
    type CatalogParts,
} from './__fixtures__/catalog';
import { addLine, createOrder } from './order-actions';
import { decideAdd, excludedValueIds, matchVariant, startAdd } from './product-flow';

/** Unit coverage for REG-100 — the add-a-product pipeline, and REG-073 — attribute exclusions. */

const PLAIN = makeProduct({ id: 1, name: 'Pizza', list_price: '10.00' });
const WITH_ATTRS = makeProduct({ id: 2, name: 'Frites', list_price: '4.00', attribute_count: 2 });
const COMBO = makeProduct({ id: 3, name: 'Menu', list_price: '15.00', combo_count: 1 });
const WEIGHED = makeProduct({ id: 4, name: 'Fromage', list_price: '20.00', to_weight: true });
const DEPOSIT = makeProduct({ id: 5, name: 'Consigne', list_price: '2.00', special_kind: 'deposit' });
const FREE = makeProduct({ id: 6, name: 'Divers', list_price: '0' });
const NO_VARIANT = makeProduct({ id: 7, name: 'Fantôme' });

/** A product whose configurator *and* combo are both set — the order of the checks decides. */
const COMBO_AND_ATTRS = makeProduct({ id: 8, name: 'Menu Frites', combo_count: 1, attribute_count: 1 });

function install(parts: CatalogParts = {}): void {
    installCatalog({
        products: [PLAIN, WITH_ATTRS, COMBO, WEIGHED, DEPOSIT, FREE, NO_VARIANT, COMBO_AND_ATTRS],
        variants: [
            makeVariant({ id: 101, product_id: 1, display_name: 'Pizza' }),
            makeVariant({ id: 102, product_id: 2, display_name: 'Frites' }),
            makeVariant({ id: 103, product_id: 3, display_name: 'Menu' }),
            makeVariant({ id: 104, product_id: 4, display_name: 'Fromage' }),
            makeVariant({ id: 105, product_id: 5, display_name: 'Consigne' }),
            makeVariant({ id: 106, product_id: 6, display_name: 'Divers' }),
            makeVariant({ id: 108, product_id: 8, display_name: 'Menu Frites' }),
        ],
        ...parts,
    });
}

beforeEach(() => {
    resetRegisterState();
    useUiStore.getState().closeDialog();
    install();
});

describe('decideAdd', () => {
    it.each([
        { product: PLAIN, expected: { kind: 'add', variantId: 101 } },
        { product: COMBO, expected: { kind: 'combo', productId: 3 } },
        { product: WITH_ATTRS, expected: { kind: 'variant', productId: 2 } },
        { product: WEIGHED, expected: { kind: 'scale', variantId: 104 } },
        { product: DEPOSIT, expected: { kind: 'openPrice', variantId: 105 } },
        { product: FREE, expected: { kind: 'openPrice', variantId: 106 } },
        { product: NO_VARIANT, expected: { kind: 'blocked', reason: 'no_variant' } },
    ])('routes $product.name', ({ product, expected }) => {
        expect(decideAdd(product, null)).toEqual(expected);
    });

    it('asks for the combo before the configurator, so components are priced last', () => {
        expect(decideAdd(COMBO_AND_ATTRS, null)).toEqual({ kind: 'combo', productId: 8 });
    });

    it('blocks any positive line on a refund order (REG-274)', async () => {
        const orderUuid = await createOrder({ isRefund: true });
        expect(decideAdd(PLAIN, orderUuid)).toEqual({ kind: 'blocked', reason: 'refund_order' });
    });

    it('the refund guard runs before the missing-variant check', async () => {
        const orderUuid = await createOrder({ isRefund: true });
        expect(decideAdd(NO_VARIANT, orderUuid)).toEqual({ kind: 'blocked', reason: 'refund_order' });
    });
});

describe('startAdd', () => {
    it('adds the line immediately for a plain product', async () => {
        const orderUuid = await createOrder();
        const decision = startAdd(PLAIN, orderUuid, 2);

        expect(decision).toEqual({ kind: 'add', variantId: 101 });
        expect(linesOf(useOrderStore.getState(), orderUuid)).toMatchObject([
            { product_variant_id: 101, quantity: 2 },
        ]);
        expect(useUiStore.getState().dialog).toBeNull();
    });

    it.each([
        { product: WITH_ATTRS, kind: 'variant', payload: { productId: 2, quantity: 1 } },
        { product: COMBO, kind: 'combo', payload: { productId: 3, quantity: 1 } },
        { product: WEIGHED, kind: 'scale', payload: { variantId: 104 } },
        { product: DEPOSIT, kind: 'openPrice', payload: { variantId: 105, quantity: 1 } },
    ])('opens the $kind dialog instead of adding a line', async ({ product, kind, payload }) => {
        const orderUuid = await createOrder();
        startAdd(product, orderUuid);

        expect(useUiStore.getState().dialog).toEqual({ kind, payload });
        expect(linesOf(useOrderStore.getState(), orderUuid)).toEqual([]);
    });

    it('does nothing at all when the add is blocked', async () => {
        const orderUuid = await createOrder({ isRefund: true });
        const decision = startAdd(PLAIN, orderUuid);

        expect(decision).toEqual({ kind: 'blocked', reason: 'refund_order' });
        expect(useUiStore.getState().dialog).toBeNull();
        expect(linesOf(useOrderStore.getState(), orderUuid)).toEqual([]);
    });
});

describe('excludedValueIds (REG-073)', () => {
    beforeEach(() => {
        // The exclusion map is not one of `buildCatalog`'s inputs, so extend the index here.
        const base = buildCatalog({ products: [WITH_ATTRS] });
        setCatalog({
            ...base,
            attributeExclusions: new Map([
                [501, [601, 602]],
                [502, [601]],
            ]),
        });
    });

    it('is empty when nothing is chosen', () => {
        expect(excludedValueIds([])).toEqual(new Set());
    });

    it('unions the exclusions of every chosen value', () => {
        expect(excludedValueIds([501])).toEqual(new Set([601, 602]));
        expect(excludedValueIds([501, 502])).toEqual(new Set([601, 602]));
        expect(excludedValueIds([502])).toEqual(new Set([601]));
    });

    it('ignores a value with no exclusions', () => {
        expect(excludedValueIds([999])).toEqual(new Set());
    });
});

describe('matchVariant', () => {
    it('short-circuits to the only variant of a single-variant product', () => {
        expect(matchVariant(1, [])).toBe(101);
        expect(matchVariant(1, [1, 2, 3])).toBe(101);
    });

    it('finds the variant whose value ids are all chosen', () => {
        install({
            variants: [
                makeVariant({ id: 201, product_id: 2, attribute_line_value_ids: [501, 503] }),
                makeVariant({ id: 202, product_id: 2, attribute_line_value_ids: [502, 503] }),
            ],
        });
        expect(matchVariant(2, [502, 503])).toBe(202);
    });

    it('ignores an inactive combination and falls back to the default variant', () => {
        install({
            variants: [
                makeVariant({
                    id: 201,
                    product_id: 2,
                    attribute_line_value_ids: [501],
                    is_active_combination: false,
                }),
                makeVariant({ id: 202, product_id: 2, attribute_line_value_ids: [502] }),
            ],
        });
        // 201 matches on values but is not a sellable combination.
        expect(matchVariant(2, [501])).toBe(202);
    });

    it('falls back to the default variant when nothing matches', () => {
        install({
            variants: [
                makeVariant({ id: 201, product_id: 2, attribute_line_value_ids: [501] }),
                makeVariant({ id: 202, product_id: 2, attribute_line_value_ids: [502] }),
            ],
        });
        expect(matchVariant(2, [999])).toBe(201);
    });

    it('returns null for a product with no variants at all', () => {
        expect(matchVariant(7, [])).toBeNull();
    });
});

describe('addLine is the only door', () => {
    it('a decision that ends in a line always goes through addLine, merge rules included', async () => {
        const orderUuid = await createOrder();
        startAdd(PLAIN, orderUuid, 1);
        startAdd(PLAIN, orderUuid, 1);

        const lines = linesOf(useOrderStore.getState(), orderUuid);
        expect(lines).toHaveLength(1);
        expect(lines[0]?.quantity).toBe(2);

        // …and the manual path lands on the same line.
        addLine({ orderUuid, variantId: 101, quantity: 1 });
        expect(linesOf(useOrderStore.getState(), orderUuid)[0]?.quantity).toBe(3);
    });
});
