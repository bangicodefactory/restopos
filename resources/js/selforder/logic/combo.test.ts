import { Decimal } from '@domain/money/decimal';
import { describe, expect, it } from 'vitest';

import type { MenuProduct } from '../catalog';
import { EMPTY_CART, addLine, cartTotals } from './cart';
import {
    autoSelect,
    buildSteps,
    comboLineName,
    comboSurcharge,
    comboTotalPrice,
    isCombo,
    missingRequiredAttributes,
    needsConfiguration,
    toCartLines,
    toSimpleCartLine,
    togglePick,
    validateSelections,
    type ComboSelection,
} from './combo';
import { sequentialUuids, testCatalog } from './fixtures';

const catalog = testCatalog();
const menu = catalog.productsById.get(400) as MenuProduct;
const pizza = catalog.productsById.get(100) as MenuProduct;
const coca = catalog.productsById.get(200) as MenuProduct;

const steps = buildSteps(catalog, menu);

function pick(comboId: number, comboItemId: number, variantId: number, productId: number, name: string): ComboSelection {
    return { comboId, comboItemId, variantId, productId, name, attributeValueIds: [] };
}

const MARGHERITA = pick(1, 11, 9100, 100, 'Margherita');
const QUATTRO = pick(1, 12, 9101, 101, 'Quattro Formaggi');
const EAU = pick(2, 21, 9202, 201, 'Eau');
const COCA33 = pick(2, 22, 9200, 200, 'Coca 33cl');

describe('buildSteps', () => {
    it('builds one step per choice, in sequence order', () => {
        expect(steps).toHaveLength(2);
        expect(steps.map((step) => step.combo.name)).toEqual(['Plat', 'Boisson']);
    });

    it('carries the free and max quotas', () => {
        expect(steps[0]!.qtyFree).toBe(1);
        expect(steps[0]!.qtyMax).toBe(1);
        expect(steps[1]!.qtyMax).toBe(2);
    });

    it('marks a choice interactive when there is a real decision in it', () => {
        expect(steps[0]!.interactive).toBe(true);
        expect(steps[1]!.interactive).toBe(true);
    });

    it("marks a single-option, single-pick choice non-interactive so the customer isn't asked", () => {
        const single = testCatalog({
            combos: [{ id: 1, name: 'Plat', base_price: '10.00', qty_free: 1, qty_max: 1, sequence: 1 }],
            combo_items: [{ id: 11, combo_id: 1, product_variant_id: 9101, extra_price: '0', sequence: 1 }],
        });
        const built = buildSteps(single, single.productsById.get(400) as MenuProduct);
        expect(built[0]!.interactive).toBe(false);
        expect(autoSelect(built[0]!)).toEqual([
            expect.objectContaining({ comboId: 1, comboItemId: 11, variantId: 9101 }),
        ]);
    });

    it("hides an 86'd option from the usable set", () => {
        const withDead = testCatalog({
            combo_items: [
                { id: 11, combo_id: 1, product_variant_id: 9102, extra_price: '0', sequence: 1 },
                { id: 21, combo_id: 2, product_variant_id: 9202, extra_price: '0', sequence: 1 },
            ],
        });
        const built = buildSteps(withDead, withDead.productsById.get(400) as MenuProduct);
        expect(built[0]!.options[0]!.available).toBe(false);
        // One dead option and nothing else: the step has no usable decision left.
        expect(built[0]!.interactive).toBe(false);
        expect(autoSelect(built[0]!)).toEqual([]);
    });

    it('returns no steps for a product that is not a combo', () => {
        expect(buildSteps(catalog, pizza)).toEqual([]);
        expect(isCombo(pizza)).toBe(false);
        expect(isCombo(menu)).toBe(true);
    });
});

describe('validateSelections', () => {
    it('requires at least one pick per choice', () => {
        const result = validateSelections(steps, [MARGHERITA]);
        expect(result.valid).toBe(false);
        expect(result.problems).toEqual([{ stepIndex: 1, comboId: 2, missing: true, exceeded: false }]);
    });

    it('accepts a complete configuration', () => {
        expect(validateSelections(steps, [MARGHERITA, EAU]).valid).toBe(true);
    });

    it('refuses more picks than qty_max', () => {
        const result = validateSelections(steps, [MARGHERITA, QUATTRO, EAU]);
        expect(result.valid).toBe(false);
        expect(result.problems[0]).toMatchObject({ comboId: 1, exceeded: true });
    });

    it('accepts two drinks because that choice allows two', () => {
        expect(validateSelections(steps, [MARGHERITA, EAU, COCA33]).valid).toBe(true);
    });
});

describe('togglePick', () => {
    it('replaces the pick on a single-choice step', () => {
        const next = togglePick(steps[0]!, [MARGHERITA, EAU], QUATTRO);
        expect(next.filter((s) => s.comboId === 1)).toEqual([QUATTRO]);
        expect(next.filter((s) => s.comboId === 2)).toEqual([EAU]);
    });

    it('accumulates up to qty_max on a multi-pick step', () => {
        const next = togglePick(steps[1]!, [MARGHERITA, EAU], COCA33);
        expect(next.filter((s) => s.comboId === 2)).toHaveLength(2);
    });

    it('evicts the oldest pick once the cap is reached', () => {
        const coca50 = pick(2, 23, 9201, 200, 'Coca 50cl');
        const next = togglePick(steps[1]!, [MARGHERITA, EAU, COCA33], coca50);
        const drinks = next.filter((s) => s.comboId === 2);
        expect(drinks).toHaveLength(2);
        expect(drinks.map((s) => s.name)).toEqual(['Coca 33cl', 'Coca 50cl']);
    });

    it('un-picks a selected option when others remain', () => {
        const next = togglePick(steps[1]!, [MARGHERITA, EAU, COCA33], COCA33);
        expect(next.filter((s) => s.comboId === 2)).toEqual([EAU]);
    });

    it('refuses to leave a choice empty', () => {
        const next = togglePick(steps[0]!, [MARGHERITA, EAU], MARGHERITA);
        expect(next.filter((s) => s.comboId === 1)).toEqual([MARGHERITA]);
    });
});

describe('comboSurcharge', () => {
    it('is only the item extras when every pick is inside the free quota', () => {
        // Margherita extra 0 + Eau extra 0.
        expect(comboSurcharge(catalog, steps, [MARGHERITA, EAU])).toBe('0.00');
    });

    it('adds the item extra of a dearer free pick', () => {
        // Quattro extra 1.50.
        expect(comboSurcharge(catalog, steps, [QUATTRO, EAU])).toBe('1.50');
    });

    it('charges base_price for a pick beyond the free quota', () => {
        // 2nd drink: base 2.00 + Coca extra 0.50.
        expect(comboSurcharge(catalog, steps, [MARGHERITA, EAU, COCA33])).toBe('2.50');
    });

    it('adds attribute extras on a combo component', () => {
        const withExtra: ComboSelection = { ...MARGHERITA, attributeValueIds: [6001] };
        expect(comboSurcharge(catalog, steps, [withExtra, EAU])).toBe('2.00');
    });

    it('is zero for no selections at all', () => {
        expect(comboSurcharge(catalog, steps, [])).toBe('0.00');
    });
});

describe('comboTotalPrice', () => {
    it('is the headline price plus the surcharge', () => {
        expect(comboTotalPrice(catalog, menu, steps, [MARGHERITA, EAU])).toBe('9.99');
        expect(comboTotalPrice(catalog, menu, steps, [QUATTRO, EAU])).toBe('11.49');
        expect(comboTotalPrice(catalog, menu, steps, [MARGHERITA, EAU, COCA33])).toBe('12.49');
    });
});

describe('toCartLines', () => {
    it('puts all the money on the children and none on the parent', () => {
        const { parent, children } = toCartLines(catalog, menu, steps, [MARGHERITA, EAU]);
        expect(parent.unitPrice).toBe('0');
        expect(parent.taxIds).toEqual([]);
        expect(children).toHaveLength(2);
    });

    it('distributes the price with the residue on the last component', () => {
        // 9.99 split by weights 10.00 / 2.00 → 8.325 → 8.33 and the remainder on the drink.
        const { children } = toCartLines(catalog, menu, steps, [MARGHERITA, EAU]);
        const total = children.reduce((sum, child) => sum.add(Decimal.of(child.unitPrice)), Decimal.of('0'));
        expect(total.withScale(2).toString()).toBe('9.99');
        // Weights 10.00 / 2.00 do not divide 9.99 evenly; the residue lands on the last component.
        expect(children.map((child) => child.unitPrice)).toEqual(['8.3300', '1.6600']);
    });

    it('keeps the cart total equal to the quoted combo price', () => {
        const { parent, children } = toCartLines(catalog, menu, steps, [QUATTRO, EAU]);
        const cart = addLine(EMPTY_CART, parent, children, sequentialUuids());
        expect(cartTotals(cart, catalog).totalIncluded).toBe(comboTotalPrice(catalog, menu, steps, [QUATTRO, EAU]));
    });

    it('carries each child’s combo item id and its own taxes', () => {
        const { children } = toCartLines(catalog, menu, steps, [MARGHERITA, EAU]);
        expect(children[0]!.comboItemId).toBe(11);
        expect(children[0]!.taxIds).toEqual([1]);
        expect(children[1]!.comboItemId).toBe(21);
        expect(children[1]!.taxIds).toEqual([2]);
    });

    it('multiplies the whole combo by the parent quantity', () => {
        const { parent, children } = toCartLines(catalog, menu, steps, [MARGHERITA, EAU], 3);
        expect(parent.quantity).toBe(3);
        expect(children.every((child) => child.quantity === 3)).toBe(true);
    });
});

describe('comboLineName', () => {
    it('lists the picks after the combo name', () => {
        expect(comboLineName(menu, [MARGHERITA, EAU])).toBe('Menu Midi — Margherita, Eau');
        expect(comboLineName(menu, [])).toBe('Menu Midi');
    });
});

describe('needsConfiguration / missingRequiredAttributes', () => {
    it('sends combos and attributed products to a detail sheet', () => {
        expect(needsConfiguration(catalog, menu)).toBe(true);
        expect(needsConfiguration(catalog, coca)).toBe(true);
        expect(needsConfiguration(catalog, catalog.productsById.get(201)!)).toBe(false);
    });

    it('reports a required attribute line with nothing chosen', () => {
        expect(missingRequiredAttributes(catalog, coca, [])).toEqual([700]);
        expect(missingRequiredAttributes(catalog, coca, [5002])).toEqual([]);
    });

    it('does not complain about optional attribute lines', () => {
        expect(missingRequiredAttributes(catalog, pizza, [])).toEqual([]);
    });
});

describe('toSimpleCartLine', () => {
    it('resolves the variant chosen by a variant-affecting attribute and uses its price', () => {
        const line = toSimpleCartLine(catalog, coca, [5002], 1, null);
        expect(line?.variantId).toBe(9201);
        // 3.00 list + 1.00 variant price extra; the attribute extra is not charged twice.
        expect(line?.unitPrice).toBe('4.00');
        expect(line?.name).toBe('Coca 50cl');
    });

    it('charges no_variant extras on the line and names them', () => {
        const line = toSimpleCartLine(catalog, pizza, [6001], 2, 'bien cuite');
        expect(line?.variantId).toBe(9100);
        expect(line?.unitPrice).toBe('14.00');
        expect(line?.name).toBe('Margherita (Extra fromage)');
        expect(line?.quantity).toBe(2);
        expect(line?.note).toBe('bien cuite');
        expect(line?.attributeValueIds).toEqual([6001]);
    });

    it('returns null when no variant can be resolved', () => {
        const orphan = { ...pizza, id: 12345 };
        expect(toSimpleCartLine(catalog, orphan, [], 1, null)).toBeNull();
    });
});
