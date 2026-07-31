/**
 * `Pricelists/Index` and `Pricelists/Edit` props — spec 05 §12 (BOF-090).
 *
 * `items[]` is every `pricelist_items` column. All the monetary and percentage columns arrive as
 * decimal strings.
 */

import type { MoneyString } from '../../types/inertia';

export type PricelistListRow = {
    id: number;
    name: string;
    currency_id: number;
    sequence: number;
    active: boolean;
    item_count: number;
};

export type PricelistsIndexProps = {
    pricelists: PricelistListRow[];
};

export type PricelistRecord = {
    id: number;
    company_id: number;
    name: string;
    currency_id: number;
    discount_policy: string;
    sequence: number;
    active: boolean;
    created_at: string | null;
    updated_at: string | null;
};

export type PricelistAppliedOn = 'variant' | 'product' | 'pos_category' | 'global';
export type PricelistComputePrice = 'fixed' | 'percentage' | 'formula';
export type PricelistBase = 'list_price' | 'standard_price' | 'pricelist';

export type PricelistItemRecord = {
    id: number;
    pricelist_id: number;
    company_id: number;
    applied_on: PricelistAppliedOn;
    product_variant_id: number | null;
    product_id: number | null;
    pos_category_id: number | null;
    min_quantity: string;
    date_start: string | null;
    date_end: string | null;
    compute_price: PricelistComputePrice;
    fixed_price: MoneyString;
    percent_price: string;
    base: PricelistBase;
    base_pricelist_id: number | null;
    price_discount: string;
    price_surcharge: MoneyString;
    price_round: string;
    price_min_margin: MoneyString;
    price_max_margin: MoneyString;
    sequence: number;
    active: boolean;
    created_at: string | null;
    updated_at: string | null;
};

export type PricelistEditProps = {
    pricelist: PricelistRecord;
    items: PricelistItemRecord[];
};

/**
 * Resolution order, most specific first — the same ranking `@domain/pricing` applies at the till.
 * Surfacing it as a number in the list is the answer to "why is this price not applying", which
 * is the single most common support question about pricelists.
 */
export const APPLIED_ON_RANK: Record<PricelistAppliedOn, number> = {
    variant: 1,
    product: 2,
    pos_category: 3,
    global: 4,
};

export const APPLIED_ON_LABEL: Record<PricelistAppliedOn, string> = {
    variant: 'Variante',
    product: 'Produit',
    pos_category: 'Catégorie PDV',
    global: 'Global',
};

export const COMPUTE_LABEL: Record<PricelistComputePrice, string> = {
    fixed: 'Prix fixe',
    percentage: 'Pourcentage',
    formula: 'Formule',
};

export const BASE_LABEL: Record<PricelistBase, string> = {
    list_price: 'Prix de vente',
    standard_price: 'Coût',
    pricelist: 'Autre liste de prix',
};

/** Is the rule in force right now? A window that has lapsed is the second-most-common cause. */
export function windowState(item: PricelistItemRecord, now = Date.now()): 'active' | 'scheduled' | 'expired' {
    const start = item.date_start === null ? null : Date.parse(item.date_start.replace(' ', 'T'));
    const end = item.date_end === null ? null : Date.parse(item.date_end.replace(' ', 'T'));
    if (start !== null && !Number.isNaN(start) && now < start) return 'scheduled';
    if (end !== null && !Number.isNaN(end) && now > end) return 'expired';
    return 'active';
}
