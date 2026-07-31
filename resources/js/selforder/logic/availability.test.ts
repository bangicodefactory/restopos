import { describe, expect, it } from 'vitest';

import {
    availablePresets,
    canOrder,
    isCategoryOpen,
    isConsultation,
    isKiosk,
    isProductOrderable,
    productsIn,
    visibleCategories,
} from './availability';
import { SELF_ORDER_CONFIG, testCatalog } from './fixtures';

const catalog = testCatalog();

const at = (hours: number, minutes = 0): Date => new Date(2026, 6, 28, hours, minutes, 0);

describe('canOrder', () => {
    it('is true only for mobile and kiosk with an open venue', () => {
        expect(canOrder(SELF_ORDER_CONFIG)).toBe(true);
        expect(canOrder({ ...SELF_ORDER_CONFIG, mode: 'kiosk' })).toBe(true);
        expect(canOrder({ ...SELF_ORDER_CONFIG, mode: 'consultation' })).toBe(false);
        expect(canOrder({ ...SELF_ORDER_CONFIG, mode: 'nothing' })).toBe(false);
    });

    it('is false while the venue has no open session (SLF-015)', () => {
        expect(canOrder({ ...SELF_ORDER_CONFIG, ordering_open: false })).toBe(false);
    });

    it('classifies the browse-only modes', () => {
        expect(isConsultation({ ...SELF_ORDER_CONFIG, mode: 'consultation' })).toBe(true);
        expect(isConsultation(SELF_ORDER_CONFIG)).toBe(false);
        expect(isKiosk({ ...SELF_ORDER_CONFIG, mode: 'kiosk' })).toBe(true);
    });
});

describe('isCategoryOpen', () => {
    it('is always open with no window', () => {
        expect(isCategoryOpen({ hourAfter: null, hourUntil: null }, at(3))).toBe(true);
    });

    it('respects a plain window', () => {
        expect(isCategoryOpen({ hourAfter: 6, hourUntil: 11 }, at(8))).toBe(true);
        expect(isCategoryOpen({ hourAfter: 6, hourUntil: 11 }, at(12))).toBe(false);
        expect(isCategoryOpen({ hourAfter: 6, hourUntil: 11 }, at(5, 59))).toBe(false);
    });

    it('is inclusive at the start and exclusive at the end', () => {
        expect(isCategoryOpen({ hourAfter: 6, hourUntil: 11 }, at(6))).toBe(true);
        expect(isCategoryOpen({ hourAfter: 6, hourUntil: 11 }, at(11))).toBe(false);
    });

    it('handles half hours', () => {
        expect(isCategoryOpen({ hourAfter: 11.5, hourUntil: 14 }, at(11, 29))).toBe(false);
        expect(isCategoryOpen({ hourAfter: 11.5, hourUntil: 14 }, at(11, 30))).toBe(true);
    });

    it('handles a window that wraps midnight', () => {
        expect(isCategoryOpen({ hourAfter: 22, hourUntil: 2 }, at(23))).toBe(true);
        expect(isCategoryOpen({ hourAfter: 22, hourUntil: 2 }, at(1))).toBe(true);
        expect(isCategoryOpen({ hourAfter: 22, hourUntil: 2 }, at(12))).toBe(false);
    });

    it('treats a half-open window as open on that side', () => {
        expect(isCategoryOpen({ hourAfter: 18, hourUntil: null }, at(20))).toBe(true);
        expect(isCategoryOpen({ hourAfter: 18, hourUntil: null }, at(9))).toBe(false);
        expect(isCategoryOpen({ hourAfter: null, hourUntil: 12 }, at(9))).toBe(true);
    });
});

describe('visibleCategories', () => {
    it('hides a category outside its time window', () => {
        const lunch = visibleCategories(catalog, at(13)).map((category) => category.id);
        expect(lunch).toContain(10);
        expect(lunch).not.toContain(30);

        const breakfast = visibleCategories(catalog, at(9)).map((category) => category.id);
        expect(breakfast).toContain(30);
    });

    it('hides a category whose every product is unavailable', () => {
        const noPizza = testCatalog({
            products: [
                {
                    id: 100,
                    name: 'Margherita',
                    list_price: '12.00',
                    tax_ids: [1],
                    pos_category_ids: [10],
                    available_in_pos: true,
                    self_order_available: false,
                    public_description: null,
                },
            ],
        });
        expect(visibleCategories(noPizza, at(13)).map((category) => category.id)).not.toContain(10);
    });
});

describe('isProductOrderable / productsIn', () => {
    it("excludes an 86'd product", () => {
        expect(isProductOrderable(catalog, catalog.productsById.get(100)!)).toBe(true);
        expect(isProductOrderable(catalog, catalog.productsById.get(102)!)).toBe(false);
        expect(productsIn(catalog, 10).map((product) => product.id)).toEqual([100, 101]);
    });

    it('excludes a product with no active variant', () => {
        const noVariants = testCatalog({ product_variants: [] });
        expect(isProductOrderable(noVariants, noVariants.productsById.get(100)!)).toBe(false);
    });
});

describe('availablePresets', () => {
    it('hides table service on mobile when no table was scanned (SLF-021)', () => {
        const withoutTable = availablePresets(catalog, SELF_ORDER_CONFIG, false).map((preset) => preset.id);
        expect(withoutTable).toEqual([2]);

        const withTable = availablePresets(catalog, SELF_ORDER_CONFIG, true).map((preset) => preset.id);
        expect(withTable).toEqual([1, 2]);
    });

    it('shows everything on a kiosk, which is itself the counter', () => {
        const kiosk = availablePresets(catalog, { ...SELF_ORDER_CONFIG, mode: 'kiosk' }, false);
        expect(kiosk).toHaveLength(2);
    });
});
