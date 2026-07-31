import { describe, expect, it } from 'vitest';

import type { Catalog } from '../catalog';
import {
    EMPTY_CART,
    addLine,
    cartCount,
    cartTotals,
    childrenOf,
    clearCart,
    displayUnitPrice,
    findLine,
    isEmpty,
    isSameLine,
    removeLine,
    setNote,
    setQuantity,
    toSubmitLines,
    validateCart,
    type Cart,
    type CartDraft,
} from './cart';
import { sequentialUuids, testCatalog } from './fixtures';

const catalog: Catalog = testCatalog();

function draft(overrides: Partial<CartDraft> = {}): CartDraft {
    return {
        variantId: 9100,
        productId: 100,
        name: 'Margherita',
        quantity: 1,
        unitPrice: '12.00',
        taxIds: [1],
        attributeValueIds: [],
        note: null,
        comboParentUuid: null,
        comboId: null,
        comboItemId: null,
        ...overrides,
    };
}

describe('addLine', () => {
    it('adds a line with a minted uuid', () => {
        const cart = addLine(EMPTY_CART, draft(), [], sequentialUuids());
        expect(cart.lines).toHaveLength(1);
        expect(cart.lines[0]!.uuid).toBe('u1');
        expect(EMPTY_CART.lines).toHaveLength(0);
    });

    it('merges an identical line into a quantity', () => {
        const uuid = sequentialUuids();
        let cart = addLine(EMPTY_CART, draft({ quantity: 2 }), [], uuid);
        cart = addLine(cart, draft({ quantity: 3 }), [], uuid);
        expect(cart.lines).toHaveLength(1);
        expect(cart.lines[0]!.quantity).toBe(5);
    });

    it('keeps lines with different notes apart — a note makes it a different item', () => {
        const uuid = sequentialUuids();
        let cart = addLine(EMPTY_CART, draft({ note: 'sans basilic' }), [], uuid);
        cart = addLine(cart, draft({ note: 'extra basilic' }), [], uuid);
        expect(cart.lines).toHaveLength(2);
    });

    it('keeps lines with different attribute picks apart', () => {
        const uuid = sequentialUuids();
        let cart = addLine(EMPTY_CART, draft({ attributeValueIds: [6001] }), [], uuid);
        cart = addLine(cart, draft({ attributeValueIds: [6002] }), [], uuid);
        expect(cart.lines).toHaveLength(2);
    });

    it('merges regardless of the order the attribute ids arrived in', () => {
        const uuid = sequentialUuids();
        let cart = addLine(EMPTY_CART, draft({ attributeValueIds: [6001, 6002] }), [], uuid);
        cart = addLine(cart, draft({ attributeValueIds: [6002, 6001] }), [], uuid);
        expect(cart.lines).toHaveLength(1);
        expect(cart.lines[0]!.quantity).toBe(2);
    });

    it('never merges combos and wires children to the parent uuid', () => {
        const uuid = sequentialUuids();
        const parent = draft({ productId: 400, variantId: 9400, name: 'Menu Midi', unitPrice: '0', taxIds: [] });
        const children: CartDraft[] = [
            draft({ comboId: 1, comboItemId: 11, unitPrice: '8.32' }),
            draft({ productId: 201, variantId: 9202, name: 'Eau', comboId: 2, comboItemId: 21, unitPrice: '1.67' }),
        ];

        let cart = addLine(EMPTY_CART, parent, children, uuid);
        cart = addLine(cart, parent, children, uuid);

        expect(cart.lines).toHaveLength(6);
        expect(childrenOf(cart, 'u1')).toHaveLength(2);
        expect(childrenOf(cart, 'u4')).toHaveLength(2);
    });

    it('refuses a zero or negative quantity', () => {
        expect(addLine(EMPTY_CART, draft({ quantity: 0 })).lines).toHaveLength(0);
        expect(addLine(EMPTY_CART, draft({ quantity: -1 })).lines).toHaveLength(0);
    });
});

describe('isSameLine', () => {
    it('is false whenever either side is part of a combo', () => {
        const line = { ...draft(), uuid: 'a' };
        expect(isSameLine(line, draft())).toBe(true);
        expect(isSameLine({ ...line, comboId: 1 }, draft())).toBe(false);
        expect(isSameLine(line, draft({ comboParentUuid: 'x' }))).toBe(false);
    });
});

describe('setQuantity / removeLine', () => {
    const uuid = sequentialUuids();
    const cart = addLine(EMPTY_CART, draft(), [], uuid);

    it('updates the quantity', () => {
        expect(setQuantity(cart, cart.lines[0]!.uuid, 4).lines[0]!.quantity).toBe(4);
    });

    it('removes the line at zero rather than leaving a ghost', () => {
        expect(setQuantity(cart, cart.lines[0]!.uuid, 0).lines).toHaveLength(0);
    });

    it('removing a combo parent takes its children with it', () => {
        const ids = sequentialUuids('c');
        const withCombo = addLine(
            EMPTY_CART,
            draft({ productId: 400, unitPrice: '0' }),
            [draft({ comboId: 1, comboItemId: 11 }), draft({ comboId: 2, comboItemId: 21 })],
            ids,
        );
        expect(withCombo.lines).toHaveLength(3);
        expect(removeLine(withCombo, 'c1').lines).toHaveLength(0);
    });
});

describe('setNote', () => {
    const cart = addLine(EMPTY_CART, draft(), [], sequentialUuids());

    it('trims and normalises an empty note to null', () => {
        expect(setNote(cart, 'u1', '  sans oignon  ').lines[0]!.note).toBe('sans oignon');
        expect(setNote(cart, 'u1', '   ').lines[0]!.note).toBeNull();
        expect(setNote(cart, 'u1', null).lines[0]!.note).toBeNull();
    });
});

describe('cartCount', () => {
    it('counts top-level items only, so a meal deal is one item', () => {
        const ids = sequentialUuids();
        const cart = addLine(
            EMPTY_CART,
            draft({ productId: 400, quantity: 2, unitPrice: '0' }),
            [draft({ comboId: 1, comboItemId: 11, quantity: 2 })],
            ids,
        );
        expect(cartCount(cart)).toBe(2);
    });

    it('is zero for an empty cart', () => {
        expect(cartCount(EMPTY_CART)).toBe(0);
        expect(isEmpty(clearCart())).toBe(true);
    });
});

describe('cartTotals', () => {
    it('is all zeroes for an empty cart', () => {
        const totals = cartTotals(EMPTY_CART, catalog);
        expect(totals.totalIncluded).toBe('0.00');
        expect(totals.lineTotals).toEqual({});
    });

    it('splits a tax-included price into base and tax', () => {
        // 12.00 incl. 21 % → 9.92 excl. + 2.08 tax
        const cart = addLine(EMPTY_CART, draft(), [], sequentialUuids());
        const totals = cartTotals(cart, catalog);
        expect(totals.totalIncluded).toBe('12.00');
        expect(totals.totalExcluded).toBe('9.92');
        expect(totals.totalTax).toBe('2.08');
        expect(totals.display).toBe('12.00');
    });

    it('multiplies by quantity and sums across tax rates', () => {
        const uuid = sequentialUuids();
        let cart = addLine(EMPTY_CART, draft({ quantity: 2 }), [], uuid);
        cart = addLine(
            cart,
            draft({ productId: 200, variantId: 9200, name: 'Coca 33cl', unitPrice: '3.00', taxIds: [2] }),
            [],
            uuid,
        );
        const totals = cartTotals(cart, catalog);
        expect(totals.totalIncluded).toBe('27.00');
        expect(totals.taxGroups).toHaveLength(2);
    });

    it('reports each line total under its own uuid', () => {
        const uuid = sequentialUuids();
        const cart = addLine(EMPTY_CART, draft({ quantity: 3 }), [], uuid);
        expect(cartTotals(cart, catalog).lineTotals['u1']).toBe('36.00');
    });

    it('shows tax-excluded numbers when the venue displays subtotals', () => {
        const exclusive: Catalog = { ...catalog, taxDisplay: 'subtotal' };
        const cart = addLine(EMPTY_CART, draft(), [], sequentialUuids());
        const totals = cartTotals(cart, exclusive);
        expect(totals.display).toBe('9.92');
        expect(totals.lineTotals['u1']).toBe('9.92');
    });
});

describe('displayUnitPrice', () => {
    it('quotes tax-included prices for a tax-included venue', () => {
        expect(displayUnitPrice('12.00', [1], catalog)).toBe('12.00');
    });

    it('quotes the bare price when the venue displays subtotals', () => {
        expect(displayUnitPrice('12.00', [1], { ...catalog, taxDisplay: 'subtotal' })).toBe('12.00');
    });
});

describe('toSubmitLines', () => {
    it('sends no prices — the server resolves them (spec §10)', () => {
        const cart = addLine(EMPTY_CART, draft({ note: 'sans basilic', attributeValueIds: [6001] }), [], sequentialUuids());
        const [line] = toSubmitLines(cart);
        expect(line).toEqual({
            uuid: 'u1',
            variant_id: 9100,
            quantity: 1,
            customer_note: 'sans basilic',
            attribute_value_ids: [6001],
            combo_parent_uuid: null,
            combo_item_id: null,
        });
        expect(Object.keys(line ?? {})).not.toContain('price_unit');
    });

    it('preserves the combo wiring', () => {
        const ids = sequentialUuids();
        const cart = addLine(
            EMPTY_CART,
            draft({ productId: 400, unitPrice: '0' }),
            [draft({ comboId: 1, comboItemId: 11 })],
            ids,
        );
        const lines = toSubmitLines(cart);
        expect(lines[1]!.combo_parent_uuid).toBe(lines[0]!.uuid);
        expect(lines[1]!.combo_item_id).toBe(11);
    });
});

describe('validateCart', () => {
    it('passes a cart of available products through untouched', () => {
        const cart = addLine(EMPTY_CART, draft(), [], sequentialUuids());
        const result = validateCart(cart, catalog);
        expect(result.issues).toHaveLength(0);
        expect(result.cart).toBe(cart);
    });

    it("drops a product that has been 86'd and explains why", () => {
        const cart = addLine(
            EMPTY_CART,
            draft({ productId: 102, variantId: 9102, name: 'Calzone' }),
            [],
            sequentialUuids(),
        );
        const result = validateCart(cart, catalog);
        expect(result.cart.lines).toHaveLength(0);
        expect(result.issues).toEqual([{ uuid: 'u1', name: 'Calzone', reason: 'unavailable' }]);
    });

    it('drops a product the catalog no longer knows at all', () => {
        const cart = addLine(EMPTY_CART, draft({ productId: 999, variantId: 9999 }), [], sequentialUuids());
        const result = validateCart(cart, catalog);
        expect(result.issues[0]!.reason).toBe('unknown');
        expect(result.cart.lines).toHaveLength(0);
    });

    it('takes the whole combo when one component vanishes — half a meal deal is not servable', () => {
        const ids = sequentialUuids();
        const cart: Cart = addLine(
            EMPTY_CART,
            draft({ productId: 400, variantId: 9400, unitPrice: '0' }),
            [
                draft({ comboId: 1, comboItemId: 11 }),
                draft({ productId: 102, variantId: 9102, name: 'Calzone', comboId: 1, comboItemId: 12 }),
            ],
            ids,
        );
        expect(cart.lines).toHaveLength(3);
        const result = validateCart(cart, catalog);
        expect(result.cart.lines).toHaveLength(0);
        expect(result.issues).toHaveLength(1);
    });

    it('keeps the healthy lines when only one product went away', () => {
        const ids = sequentialUuids();
        let cart = addLine(EMPTY_CART, draft(), [], ids);
        cart = addLine(cart, draft({ productId: 102, variantId: 9102, name: 'Calzone' }), [], ids);
        const result = validateCart(cart, catalog);
        expect(result.cart.lines).toHaveLength(1);
        expect(result.cart.lines[0]!.productId).toBe(100);
    });
});

describe('findLine', () => {
    it('finds by uuid and returns null otherwise', () => {
        const cart = addLine(EMPTY_CART, draft(), [], sequentialUuids());
        expect(findLine(cart, 'u1')?.productId).toBe(100);
        expect(findLine(cart, 'nope')).toBeNull();
    });
});
