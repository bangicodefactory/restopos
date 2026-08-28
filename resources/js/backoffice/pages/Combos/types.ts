/**
 * `Combos/Index` and `Combos/Edit` props — spec §11 (BOF-088).
 *
 * A `combos` row is one **course** of a set menu, not the menu itself. The menu is a product, and
 * the courses hang off it through `combo_product` — which is why `menus` appears on a course rather
 * than the other way round.
 */

export type NamedRow = { id: number; name: string };

export type ComboListRow = {
    id: number;
    name: string;
    /** The weight the distributor splits the menu's price by — not what the customer pays. */
    base_price: string;
    qty_free: number;
    qty_max: number;
    sequence: number;
    active: boolean;
    item_count: number;
    menus: NamedRow[];
};

export type CombosIndexProps = {
    combos: ComboListRow[];
};

export type ComboRecord = {
    id: number;
    company_id: number;
    name: string;
    base_price: string;
    qty_free: number;
    qty_max: number;
    sequence: number;
    active: boolean;
};

export type ComboItemRow = {
    id: number;
    product_variant_id: number;
    name: string;
    /** What the dish sells for on its own. Shown for context; it is not the split weight. */
    list_price: string;
    /** The supplement, added on top of the menu price. Negative is a real menu. */
    extra_price: string;
    sequence: number;
    active: boolean;
};

export type VariantRow = { id: number; name: string; list_price: string };

export type ComboEditProps = {
    combo: ComboRecord;
    items: ComboItemRow[];
    variants: VariantRow[];
    menus: NamedRow[];
    products: NamedRow[];
};
