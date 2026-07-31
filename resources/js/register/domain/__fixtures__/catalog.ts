import { buildNomenclature, type Nomenclature } from '@domain/barcode/index';
import { PricelistResolver, type Pricelist } from '@domain/pricing/pricelist';
import type { CashRounding, FiscalPosition, TaxDefinition } from '@domain/tax/types';
import type {
    BarcodeNomenclatureRow,
    BarcodeRuleRow,
    CurrencyRow,
    EmployeeRow,
    PosCategoryRow,
    PosConfigRow,
    PosPresetRow,
    ProductAttributeLineValueRow,
    ProductAttributeValueRow,
    ProductRow,
    ProductVariantRow,
    TaxRow,
    UomRow,
} from '@domain/types';

import { emptyCatalog, setCatalog, type CatalogIndex } from '../../data/catalog';
import { useOrderStore } from '../../state/order-store';
import { resetOrderActions } from '../order-actions';
import { invalidateTotals } from '../totals';

/**
 * Catalog + store fixtures for the register domain tests.
 *
 * The production index is built from Dexie by `data/catalog-load.ts`; assembling one by hand here
 * keeps the domain tests in plain Node with no IndexedDB and makes each test's tax/pricing setup
 * visible at the top of the file rather than buried in a bootstrap payload.
 */

export function makeUom(partial: Partial<UomRow> & Pick<UomRow, 'id'>): UomRow {
    return {
        uom_category_id: 1,
        name: 'Unit',
        uom_type: 'reference',
        factor: '1',
        rounding: '0.001',
        is_pos_groupable: true,
        ...partial,
    };
}

export function makeTax(partial: Partial<TaxRow> & Pick<TaxRow, 'id'>): TaxRow {
    return {
        company_id: 1,
        name: `Tax ${partial.id}`,
        label: null,
        amount_type: 'percent',
        amount: '20',
        tax_group_id: partial.id,
        tax_scope: null,
        price_include: false,
        include_base_amount: false,
        is_base_affected: true,
        sequence: partial.id,
        children_tax_ids: [],
        active: true,
        ...partial,
    };
}

export function makeProduct(partial: Partial<ProductRow> & Pick<ProductRow, 'id'>): ProductRow {
    return {
        uuid: `product-${partial.id}`,
        company_id: 1,
        name: `Product ${partial.id}`,
        product_category_id: null,
        product_type: 'consumable',
        default_code: null,
        barcode: null,
        uom_id: 1,
        list_price: '10.00',
        standard_price: '4.00',
        tax_ids: [],
        pos_category_ids: [],
        tag_ids: [],
        optional_product_ids: [],
        combo_ids: [],
        available_in_pos: true,
        self_order_available: true,
        to_weight: false,
        track_stock: false,
        allow_negative_stock: true,
        is_special: false,
        special_kind: 'none',
        description_sale: null,
        public_description: null,
        color: 0,
        pos_sequence: 0,
        is_favorite: false,
        image_media_id: null,
        has_image: false,
        attribute_count: 0,
        combo_count: 0,
        active: true,
        updated_at: '2026-01-01T00:00:00.000Z',
        searchText: '',
        ...partial,
    };
}

export function makeVariant(
    partial: Partial<ProductVariantRow> & Pick<ProductVariantRow, 'id' | 'product_id'>,
): ProductVariantRow {
    return {
        uuid: `variant-${partial.id}`,
        company_id: 1,
        name_suffix: null,
        display_name: `Variant ${partial.id}`,
        default_code: null,
        barcode: null,
        price_extra: '0',
        list_price: null,
        standard_price: '4.00',
        on_hand_qty: 100,
        self_order_available: true,
        is_active_combination: true,
        attribute_line_value_ids: [],
        tax_ids: null,
        image_media_id: null,
        active: true,
        updated_at: '2026-01-01T00:00:00.000Z',
        searchText: '',
        ...partial,
    };
}

export function makeCategory(
    partial: Partial<PosCategoryRow> & Pick<PosCategoryRow, 'id'>,
): PosCategoryRow {
    return {
        name: `Category ${partial.id}`,
        parent_id: null,
        sequence: partial.id,
        color: 0,
        image_media_id: null,
        has_image: false,
        self_order_visible: true,
        hour_after: null,
        hour_until: null,
        ancestorIds: [],
        ...partial,
    };
}

export function makeCurrency(partial: Partial<CurrencyRow> = {}): CurrencyRow {
    return {
        id: 1,
        name: 'Euro',
        symbol: '€',
        iso_code: 'EUR',
        decimal_places: 2,
        rounding: '0.01',
        symbol_position: 'after',
        thousands_separator: ' ',
        decimal_separator: ',',
        rate: '1',
        ...partial,
    };
}

export function makeConfig(partial: Partial<PosConfigRow> = {}): PosConfigRow {
    return {
        id: 1,
        uuid: 'config-1',
        company_id: 1,
        name: 'Salle',
        currency_id: 1,
        config_revision: 1,
        sequence_prefix: null,
        default_screen: 'register',
        is_restaurant: true,
        use_preparation_display: true,
        module_pos_restaurant_bill_split: true,
        iface_tax_included: 'total',
        tax_rounding_method: 'round_per_line',
        cash_rounding_id: null,
        pricelist_id: null,
        available_pricelist_ids: [],
        default_fiscal_position_id: null,
        available_fiscal_position_ids: [],
        payment_method_ids: [1],
        pos_category_ids: [],
        limit_categories: false,
        limited_product_count: 500,
        limited_customer_count: 500,
        default_preset_id: null,
        available_preset_ids: [],
        floor_ids: [],
        printer_ids: [],
        prep_display_ids: [],
        note_ids: [],
        bill_ids: [],
        trusted_config_ids: [],
        iface_start_categ_id: null,
        iface_available_categ_ids: [],
        iface_print_auto: false,
        iface_print_skip_screen: false,
        iface_electronic_scale: false,
        iface_customer_facing_display: false,
        iface_big_scrollbars: false,
        cash_control: false,
        amount_authorized_diff: null,
        restrict_price_control: false,
        manual_discount: true,
        ship_later: false,
        set_maximum_difference: false,
        receipt_header: null,
        receipt_footer: null,
        receipt_logo_media_id: null,
        ticket_url_display_mode: null,
        self_ordering_mode: 'nothing',
        self_ordering_service_mode: 'table',
        self_ordering_pay_after: 'each',
        self_ordering_default_language: null,
        self_ordering_available_languages: [],
        self_ordering_image_media_id: null,
        self_order_online_payment_method_id: null,
        access_token: null,
        employee_idle_logout_seconds: 0,
        allow_offline_manager_override: true,
        role_abilities: null,
        active: true,
        updated_at: '2026-01-01T00:00:00.000Z',
        ...partial,
    };
}

export function makeEmployee(partial: Partial<EmployeeRow> & Pick<EmployeeRow, 'id'>): EmployeeRow {
    return {
        uuid: `employee-${partial.id}`,
        name: `Employee ${partial.id}`,
        default_role: 'cashier',
        access_level: 'basic',
        avatar_media_id: null,
        avatar_url: null,
        has_pin: false,
        pin_verifier: null,
        badge_verifier: null,
        abilities: [],
        active: true,
        ...partial,
    };
}

export function makePreset(partial: Partial<PosPresetRow> & Pick<PosPresetRow, 'id'>): PosPresetRow {
    return {
        name: `Preset ${partial.id}`,
        service_at: 'table',
        identification: 'none',
        pricelist_id: null,
        fiscal_position_id: null,
        is_timing: false,
        slots_per_interval: 0,
        interval_time_minutes: 0,
        color: 0,
        available_in_self: false,
        sequence: partial.id,
        ...partial,
    };
}

/** Mirrors `catalog-load.ts`'s `toTaxDefinition` — the tax engine's view of a `TaxRow`. */
function toTaxDefinition(tax: TaxRow): TaxDefinition {
    return {
        id: tax.id,
        name: tax.name,
        amountType: tax.amount_type,
        amount: tax.amount,
        priceInclude: tax.price_include,
        includeBaseAmount: tax.include_base_amount,
        isBaseAffected: tax.is_base_affected,
        sequence: tax.sequence,
        taxGroupId: tax.tax_group_id,
        childrenTaxIds: tax.children_tax_ids,
    };
}

export type CatalogParts = {
    version?: number;
    config?: PosConfigRow | null;
    currency?: CurrencyRow | null;
    products?: readonly ProductRow[];
    variants?: readonly ProductVariantRow[];
    categories?: readonly PosCategoryRow[];
    taxes?: readonly TaxRow[];
    uoms?: readonly UomRow[];
    pricelists?: readonly Pricelist[];
    fiscalPositions?: ReadonlyMap<number, FiscalPosition>;
    cashRounding?: CashRounding | null;
    nomenclature?: Nomenclature | null;
    fallbackNomenclature?: Nomenclature | null;
    employees?: readonly EmployeeRow[];
    presets?: readonly PosPresetRow[];
    attributeValues?: readonly ProductAttributeValueRow[];
    attributeLineValues?: readonly ProductAttributeLineValueRow[];
};

export function buildCatalog(parts: CatalogParts = {}): CatalogIndex {
    const products = parts.products ?? [];
    const variants = parts.variants ?? [];
    const categories = parts.categories ?? [];
    const taxes = parts.taxes ?? [];
    const uoms = parts.uoms ?? [makeUom({ id: 1 })];

    const variantsByProduct = new Map<number, ProductVariantRow[]>();
    const defaultVariantByProduct = new Map<number, ProductVariantRow>();
    const barcodeIndex = new Map<string, ProductVariantRow>();
    for (const variant of variants) {
        const bucket = variantsByProduct.get(variant.product_id);
        if (bucket) bucket.push(variant);
        else variantsByProduct.set(variant.product_id, [variant]);
        if (variant.barcode) barcodeIndex.set(variant.barcode, variant);
    }
    // Same rule as `catalog-load.ts`: the first sellable combination, else the first variant at all.
    for (const [productId, list] of variantsByProduct) {
        const first = list.filter((v) => v.active && v.is_active_combination)[0] ?? list[0];
        if (first) defaultVariantByProduct.set(productId, first);
    }
    for (const product of products) {
        if (!product.barcode) continue;
        const variant = defaultVariantByProduct.get(product.id);
        if (variant && !barcodeIndex.has(product.barcode)) barcodeIndex.set(product.barcode, variant);
    }

    const categoryChildren = new Map<number, PosCategoryRow[]>();
    for (const category of categories) {
        const key = category.parent_id ?? 0;
        const bucket = categoryChildren.get(key);
        if (bucket) bucket.push(category);
        else categoryChildren.set(key, [category]);
    }

    return Object.freeze({
        ...emptyCatalog(),
        version: parts.version ?? 1,
        config: parts.config === undefined ? makeConfig() : parts.config,
        currency: parts.currency === undefined ? makeCurrency() : parts.currency,
        currencyFormat: emptyCatalog().currencyFormat,

        products,
        variants,
        productsById: new Map(products.map((p) => [p.id, p])),
        variantsById: new Map(variants.map((v) => [v.id, v])),
        variantsByProduct,
        defaultVariantByProduct,
        barcodeIndex,
        sellable: products.filter((p) => p.available_in_pos && !p.is_special),
        categoryChildren,
        categoriesById: new Map(categories.map((c) => [c.id, c])),
        productsByCategory: new Map<number, ProductRow[]>(),

        attributeValues: new Map((parts.attributeValues ?? []).map((v) => [v.id, v])),
        attributeLineValuesById: new Map((parts.attributeLineValues ?? []).map((v) => [v.id, v])),

        taxes: new Map(taxes.map((t) => [t.id, t])),
        taxDefinitions: new Map(taxes.map((t) => [t.id, toTaxDefinition(t)])),
        taxLabels: new Map(taxes.map((t) => [t.id, t.label ?? t.name])),
        fiscalPositionMappings: parts.fiscalPositions ?? new Map<number, FiscalPosition>(),
        cashRounding: parts.cashRounding ?? null,

        pricelistResolver:
            parts.pricelists === undefined ? null : PricelistResolver.fromArray([...parts.pricelists]),

        presets: parts.presets ?? [],
        employees: parts.employees ?? [],
        uoms: new Map(uoms.map((u) => [u.id, u])),
        nomenclature: parts.nomenclature ?? null,
        fallbackNomenclature: parts.fallbackNomenclature ?? null,
    }) as CatalogIndex;
}

/** Build a catalog and make it the module singleton the domain modules read. */
export function installCatalog(parts: CatalogParts = {}): CatalogIndex {
    const catalog = buildCatalog(parts);
    setCatalog(catalog);
    invalidateTotals();
    return catalog;
}

/** Clear the order store, the totals memo and the injected action deps. */
export function resetRegisterState(): void {
    useOrderStore.getState().resetAll();
    invalidateTotals();
    resetOrderActions();
}

// ── barcode nomenclature helpers ─────────────────────────────────────────────

export const NOMENCLATURE_ROW: BarcodeNomenclatureRow = {
    id: 1,
    name: 'Default',
    upc_ean_conv: 'always',
    is_gs1: false,
};

export function makeRule(
    partial: Partial<BarcodeRuleRow> & Pick<BarcodeRuleRow, 'id' | 'rule_type' | 'pattern'>,
): BarcodeRuleRow {
    return {
        barcode_nomenclature_id: 1,
        name: partial.rule_type,
        encoding: 'any',
        alias: null,
        sequence: partial.id,
        ...partial,
    };
}

export function makeNomenclature(
    rules: readonly BarcodeRuleRow[],
    row: BarcodeNomenclatureRow = NOMENCLATURE_ROW,
): Nomenclature {
    return buildNomenclature(row, rules);
}
