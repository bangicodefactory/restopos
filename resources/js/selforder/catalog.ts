import { Decimal } from '@domain/money/decimal';
import type { CurrencyFormat } from '@domain/receipt';
import type { TaxDefinition } from '@domain/tax/types';

import type { MenuData, MenuResponse } from './types';

/**
 * The in-memory menu.
 *
 * A customer's phone gets one payload and then browses it hard: category taps, product sheets,
 * combo steppers, a cart that recomputes on every stepper press. Doing that against arrays is
 * O(n) per interaction on a device with a 2015 CPU, so the payload is indexed once, here, into
 * plain `Map`s and frozen for the session.
 *
 * Deliberately *not* built on `@shared/db`'s `applyPayload`: that helper expects every `data` key to
 * be an array, and the menu payload ships `pos_config` and `pos_session` as single objects (spec
 * §2 "payload keys"). It also assumes a device-scoped Dexie database keyed by config id, which an
 * anonymous phone has not got at first paint. The raw payload is cached wholesale instead — see
 * `persistence.ts`.
 */

export type MenuCategory = {
    id: number;
    name: string;
    parentId: number | null;
    sequence: number;
    hourAfter: number | null;
    hourUntil: number | null;
};

export type MenuProduct = {
    id: number;
    name: string;
    description: string | null;
    listPrice: string;
    taxIds: number[];
    categoryIds: number[];
    tagIds: number[];
    comboIds: number[];
    available: boolean;
    hasImage: boolean;
    sequence: number;
};

export type MenuVariant = {
    id: number;
    productId: number;
    displayName: string;
    priceExtra: string;
    listPrice: string | null;
    taxIds: number[] | null;
    available: boolean;
    attributeLineValueIds: number[];
};

export type MenuAttribute = {
    id: number;
    name: string;
    displayType: string;
    createVariant: 'always' | 'dynamic' | 'no_variant';
    sequence: number;
};

export type MenuAttributeLine = {
    id: number;
    productId: number;
    attributeId: number;
    required: boolean;
    sequence: number;
    values: MenuAttributeLineValue[];
};

export type MenuAttributeLineValue = {
    id: number;
    attributeLineId: number;
    valueId: number;
    name: string;
    htmlColor: string | null;
    isCustom: boolean;
    priceExtra: string;
    sequence: number;
};

export type MenuCombo = {
    id: number;
    name: string;
    basePrice: string;
    qtyFree: number;
    qtyMax: number;
    sequence: number;
    items: MenuComboItem[];
};

export type MenuComboItem = {
    id: number;
    comboId: number;
    variantId: number;
    extraPrice: string;
    sequence: number;
};

export type MenuPreset = {
    id: number;
    name: string;
    serviceAt: 'counter' | 'table' | 'delivery';
    identification: 'none' | 'name' | 'address';
    sequence: number;
};

export type Catalog = {
    configId: number;
    configName: string;
    currency: CurrencyFormat;
    /** `total` → prices are shown tax-included; `subtotal` → tax-excluded (spec 01, `iface_tax_included`). */
    taxDisplay: 'total' | 'subtotal';
    roundingMethod: 'round_per_line' | 'round_globally';
    taxes: TaxDefinition[];
    taxesById: Map<number, TaxDefinition>;

    categories: MenuCategory[];
    products: MenuProduct[];
    productsById: Map<number, MenuProduct>;
    productsByCategory: Map<number, MenuProduct[]>;
    variantsById: Map<number, MenuVariant>;
    variantsByProduct: Map<number, MenuVariant[]>;

    attributesById: Map<number, MenuAttribute>;
    attributeLinesByProduct: Map<number, MenuAttributeLine[]>;
    attributeLineValuesById: Map<number, MenuAttributeLineValue>;

    combosById: Map<number, MenuCombo>;
    presets: MenuPreset[];
    /** `"product:44"` / `"pos_category:7"` → public image URL. */
    imageUrls: Map<string, string>;
    tagsById: Map<number, { id: number; name: string; visible: boolean; description: string | null }>;
    sessionOpen: boolean;
};

function one<T>(value: T | T[] | null | undefined): T | null {
    if (value === null || value === undefined) return null;
    return Array.isArray(value) ? (value[0] ?? null) : value;
}

const FALLBACK_CURRENCY: CurrencyFormat = {
    symbol: '€',
    position: 'after',
    decimalPlaces: 2,
    decimalSeparator: ',',
    thousandsSeparator: ' ',
};

export function buildCatalog(response: MenuResponse): Catalog {
    const data: MenuData = response.data ?? {};
    const config = one(data.pos_config);
    const session = one(data.pos_session);

    const currencyRow = (data.currencies ?? []).find((row) => row.id === config?.currency_id) ?? data.currencies?.[0];
    const currency: CurrencyFormat = currencyRow
        ? {
              symbol: currencyRow.symbol,
              position: currencyRow.symbol_position === 'before' ? 'before' : 'after',
              decimalPlaces: currencyRow.decimal_places,
              // Separators are locale defaults, not stored per-currency; fall back like the
              // register does (resources/js/register/data/catalog-load.ts) rather than render
              // "8undefined50 €" when the payload omits them.
              decimalSeparator: currencyRow.decimal_separator || ',',
              thousandsSeparator: currencyRow.thousands_separator || ' ',
          }
        : FALLBACK_CURRENCY;

    const taxes: TaxDefinition[] = (data.taxes ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        amountType: row.amount_type,
        amount: row.amount,
        priceInclude: row.price_include,
        includeBaseAmount: row.include_base_amount,
        isBaseAffected: row.is_base_affected,
        sequence: row.sequence,
        taxGroupId: row.tax_group_id,
        childrenTaxIds: row.children_tax_ids ?? [],
    }));

    const categories: MenuCategory[] = (data.pos_categories ?? [])
        .filter((row) => row.self_order_visible !== false)
        .map((row) => ({
            id: row.id,
            name: row.name,
            parentId: row.parent_id,
            sequence: row.sequence,
            hourAfter: row.hour_after,
            hourUntil: row.hour_until,
        }))
        .sort((a, b) => a.sequence - b.sequence || a.id - b.id);

    const products: MenuProduct[] = (data.products ?? [])
        .filter((row) => row.active !== false)
        .map((row) => ({
            id: row.id,
            name: row.name,
            description: row.public_description ?? row.description_sale ?? null,
            listPrice: row.list_price,
            taxIds: row.tax_ids ?? [],
            categoryIds: row.pos_category_ids ?? [],
            tagIds: row.tag_ids ?? [],
            comboIds: row.combo_ids ?? [],
            // SLF-025: `self_order_available` is forced false when the product is not in the POS at
            // all, but the client must not depend on the server having done so.
            available: row.available_in_pos !== false && row.self_order_available !== false,
            hasImage: row.has_image === true || typeof row.image_media_id === 'number',
            sequence: row.pos_sequence ?? 0,
        }))
        .sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name));

    const productsById = new Map(products.map((product) => [product.id, product]));
    const productsByCategory = new Map<number, MenuProduct[]>();
    for (const product of products) {
        for (const categoryId of product.categoryIds) {
            const bucket = productsByCategory.get(categoryId);
            if (bucket) bucket.push(product);
            else productsByCategory.set(categoryId, [product]);
        }
    }

    const variants: MenuVariant[] = (data.product_variants ?? [])
        .filter((row) => row.active !== false && row.is_active_combination !== false)
        .map((row) => ({
            id: row.id,
            productId: row.product_id,
            displayName: row.display_name,
            priceExtra: row.price_extra,
            listPrice: row.list_price,
            taxIds: row.tax_ids,
            available: row.self_order_available !== false,
            attributeLineValueIds: row.attribute_line_value_ids ?? [],
        }));

    const variantsById = new Map(variants.map((variant) => [variant.id, variant]));
    const variantsByProduct = new Map<number, MenuVariant[]>();
    for (const variant of variants) {
        const bucket = variantsByProduct.get(variant.productId);
        if (bucket) bucket.push(variant);
        else variantsByProduct.set(variant.productId, [variant]);
    }

    const attributesById = new Map(
        (data.product_attributes ?? []).map((row) => [
            row.id,
            {
                id: row.id,
                name: row.name,
                displayType: row.display_type,
                createVariant: row.create_variant,
                sequence: row.sequence,
            },
        ]),
    );

    const valueNames = new Map(
        (data.product_attribute_values ?? []).map((row) => [row.id, row]),
    );

    const lineValues: MenuAttributeLineValue[] = (data.product_attribute_line_values ?? [])
        .filter((row) => row.active !== false)
        .map((row) => {
            const value = valueNames.get(row.product_attribute_value_id);
            return {
                id: row.id,
                attributeLineId: row.product_attribute_line_id,
                valueId: row.product_attribute_value_id,
                name: value?.name ?? '',
                htmlColor: value?.html_color ?? null,
                isCustom: value?.is_custom === true,
                priceExtra: row.price_extra,
                sequence: row.sequence,
            };
        })
        .sort((a, b) => a.sequence - b.sequence || a.id - b.id);

    const attributeLineValuesById = new Map(lineValues.map((value) => [value.id, value]));
    const valuesByLine = new Map<number, MenuAttributeLineValue[]>();
    for (const value of lineValues) {
        const bucket = valuesByLine.get(value.attributeLineId);
        if (bucket) bucket.push(value);
        else valuesByLine.set(value.attributeLineId, [value]);
    }

    const attributeLinesByProduct = new Map<number, MenuAttributeLine[]>();
    for (const row of (data.product_attribute_lines ?? []).slice().sort((a, b) => a.sequence - b.sequence)) {
        const line: MenuAttributeLine = {
            id: row.id,
            productId: row.product_id,
            attributeId: row.product_attribute_id,
            required: row.is_required,
            sequence: row.sequence,
            values: valuesByLine.get(row.id) ?? [],
        };
        // An attribute line with no selectable values is not a question worth asking.
        if (line.values.length === 0) continue;
        const bucket = attributeLinesByProduct.get(row.product_id);
        if (bucket) bucket.push(line);
        else attributeLinesByProduct.set(row.product_id, [line]);
    }

    const itemsByCombo = new Map<number, MenuComboItem[]>();
    for (const row of (data.combo_items ?? []).slice().sort((a, b) => a.sequence - b.sequence || a.id - b.id)) {
        const item: MenuComboItem = {
            id: row.id,
            comboId: row.combo_id,
            variantId: row.product_variant_id,
            extraPrice: row.extra_price,
            sequence: row.sequence,
        };
        const bucket = itemsByCombo.get(row.combo_id);
        if (bucket) bucket.push(item);
        else itemsByCombo.set(row.combo_id, [item]);
    }

    const combosById = new Map<number, MenuCombo>(
        (data.combos ?? []).map((row) => [
            row.id,
            {
                id: row.id,
                name: row.name,
                basePrice: row.base_price,
                qtyFree: row.qty_free,
                qtyMax: Math.max(1, row.qty_max),
                sequence: row.sequence,
                items: itemsByCombo.get(row.id) ?? [],
            },
        ]),
    );

    const presets: MenuPreset[] = (data.pos_presets ?? [])
        .filter((row) => row.available_in_self !== false)
        .map((row) => ({
            id: row.id,
            name: row.name,
            serviceAt: row.service_at,
            identification: row.identification,
            sequence: row.sequence,
        }))
        .sort((a, b) => a.sequence - b.sequence || a.id - b.id);

    const imageUrls = new Map<string, string>();
    for (const media of data.media_files ?? []) {
        const url = media.variants?.['512'] ?? media.variants?.['medium'] ?? media.url;
        if (typeof url === 'string' && url !== '') imageUrls.set(`${media.model}:${media.model_id}`, url);
    }

    return {
        configId: config?.id ?? 0,
        configName: config?.name ?? '',
        currency,
        taxDisplay: config?.iface_tax_included === 'subtotal' ? 'subtotal' : 'total',
        roundingMethod: config?.tax_rounding_method ?? 'round_per_line',
        taxes,
        taxesById: new Map(taxes.map((tax) => [tax.id, tax])),
        categories,
        products,
        productsById,
        productsByCategory,
        variantsById,
        variantsByProduct,
        attributesById,
        attributeLinesByProduct,
        attributeLineValuesById,
        combosById,
        presets,
        imageUrls,
        tagsById: new Map(
            (data.product_tags ?? [])
                .filter((row) => row.visible_to_customers !== false)
                .map((row) => [
                    row.id,
                    { id: row.id, name: row.name, visible: true, description: row.pos_description },
                ]),
        ),
        sessionOpen: session !== null && session.state === 'opened',
    };
}

/**
 * The default variant for a product with no attribute questions, or the one matching a selection.
 *
 * `always` / `dynamic` attributes resolve to a real variant whose *own* price and taxes are used
 * (SLF-028); `no_variant` values ride on the order line as `attribute_value_ids` plus a price extra
 * and do not change the variant.
 */
export function resolveVariant(
    catalog: Catalog,
    productId: number,
    selectedLineValueIds: readonly number[],
): MenuVariant | null {
    const variants = catalog.variantsByProduct.get(productId) ?? [];
    if (variants.length === 0) return null;
    if (variants.length === 1) return variants[0] ?? null;

    const variantAffecting = new Set(
        selectedLineValueIds.filter((id) => {
            const value = catalog.attributeLineValuesById.get(id);
            if (!value) return false;
            const line = (catalog.attributeLinesByProduct.get(productId) ?? []).find(
                (item) => item.id === value.attributeLineId,
            );
            const attribute = line ? catalog.attributesById.get(line.attributeId) : undefined;
            return attribute !== undefined && attribute.createVariant !== 'no_variant';
        }),
    );

    if (variantAffecting.size === 0) return variants[0] ?? null;

    return (
        variants.find((variant) =>
            [...variantAffecting].every((id) => variant.attributeLineValueIds.includes(id)),
        ) ?? null
    );
}

/** The unit price a customer is quoted, before taxes are displayed either way. */
export function variantUnitPrice(
    catalog: Catalog,
    variant: MenuVariant | null,
    product: MenuProduct,
    selectedLineValueIds: readonly number[],
): string {
    const base =
        variant?.listPrice !== null && variant?.listPrice !== undefined
            ? Decimal.of(variant.listPrice)
            : Decimal.of(product.listPrice).add(Decimal.of(variant?.priceExtra ?? '0'));

    let total = base;
    for (const id of selectedLineValueIds) {
        const value = catalog.attributeLineValuesById.get(id);
        if (value) total = total.add(Decimal.of(value.priceExtra));
    }
    return total.toString();
}

export function taxIdsFor(variant: MenuVariant | null, product: MenuProduct): number[] {
    return variant?.taxIds ?? product.taxIds;
}

/**
 * The product's public image, or `null`.
 *
 * The URL comes from the `media_files` rows in the payload; this client never *constructs* a media
 * path, because guessing one is how you ship a 404 on every card in a venue whose storage layout
 * differs. No image is a supported state — the card renders a coloured monogram instead.
 */
export function productImageUrl(catalog: Catalog, product: MenuProduct): string | null {
    return catalog.imageUrls.get(`product:${product.id}`) ?? null;
}
