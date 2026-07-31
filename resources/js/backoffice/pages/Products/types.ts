/**
 * `Products/Index` and `Products/Edit` props — spec 05 §12.
 *
 * `product` is `$product->attributesToArray()` plus `pos_category_ids`, `tax_ids` and the
 * computed `variants[]`, so every `products` column is present. Money columns
 * (`list_price`, `standard_price`, `price_extra`) are decimal strings.
 */

import type { Deferred, MoneyString, Paginator } from '../../types/inertia';

export type ProductListRow = {
    id: number;
    name: string;
    default_code: string | null;
    barcode: string | null;
    list_price: MoneyString;
    standard_price: MoneyString;
    available_in_pos: boolean;
    self_order_available: boolean;
    active: boolean;
    /** Category *names*, not ids — the controller plucks `name`. */
    categories: string[];
};

export type ProductFilters = {
    search?: string | null;
    category_id?: number | string | null;
};

export type PosCategoryOption = {
    id: number;
    name: string;
    parent_id: number | null;
};

export type ProductsIndexProps = {
    products: Paginator<ProductListRow>;
    filters: ProductFilters;
    categories: Deferred<PosCategoryOption[]>;
};

export type ProductVariantRow = {
    id: number;
    uuid: string;
    product_id: number;
    company_id: number;
    name_suffix: string | null;
    display_name: string;
    default_code: string | null;
    barcode: string | null;
    price_extra: MoneyString;
    list_price: MoneyString | null;
    standard_price: MoneyString;
    on_hand_qty: string;
    self_order_available: boolean;
    is_active_combination: boolean;
    image_media_id: number | null;
    active: boolean;
    created_at: string | null;
    updated_at: string | null;
};

export type ProductRecord = {
    id: number;
    uuid: string;
    company_id: number;
    name: string;
    product_category_id: number | null;
    product_type: string;
    default_code: string | null;
    barcode: string | null;
    uom_id: number;
    list_price: MoneyString;
    standard_price: MoneyString;
    available_in_pos: boolean;
    self_order_available: boolean;
    to_weight: boolean;
    track_stock: boolean;
    allow_negative_stock: boolean;
    is_special: boolean;
    special_kind: string;
    description_sale: string | null;
    public_description: string | null;
    internal_note: string | null;
    color: number;
    pos_sequence: number;
    is_favorite: boolean;
    last_sold_at: string | null;
    sale_count: number;
    image_media_id: number | null;
    has_image: boolean;
    attribute_count: number;
    combo_count: number;
    sale_ok: boolean;
    active: boolean;
    created_at: string | null;
    updated_at: string | null;

    pos_category_ids: number[];
    tax_ids: number[];
    variants: ProductVariantRow[];
};

export type TaxOption = {
    id: number;
    name: string;
    amount: MoneyString;
    amount_type: string;
};

export type ProductOptions = {
    categories: PosCategoryOption[];
    taxes: TaxOption[];
};

export type ProductEditProps = {
    product: ProductRecord;
    options: Deferred<ProductOptions>;
};

/** Keys `PATCH /products/{product}` validates. Everything else is displayed read-only. */
export const WRITABLE_PRODUCT_KEYS = [
    'name',
    'default_code',
    'barcode',
    'list_price',
    'standard_price',
    'available_in_pos',
    'self_order_available',
    'active',
    'pos_category_ids',
    'tax_ids',
] as const;
