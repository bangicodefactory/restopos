import type { Nomenclature } from '@domain/barcode/index';
import type { PricelistResolver } from '@domain/pricing/pricelist';
import type { CurrencyFormat } from '@domain/receipt/index';
import type { CashRounding, FiscalPosition, TaxDefinition } from '@domain/tax/types';
import type {
    ComboItemRow,
    ComboRow,
    CompanyRow,
    CurrencyRow,
    EmployeeRow,
    FiscalPositionRow,
    PaymentMethodRow,
    PosBillRow,
    PosCategoryRow,
    PosConfigRow,
    PosNoteRow,
    PosPresetRow,
    PosPrinterRow,
    PricelistRow,
    ProductAttributeLineRow,
    ProductAttributeLineValueRow,
    ProductAttributeRow,
    ProductAttributeValueRow,
    ProductRow,
    ProductVariantRow,
    RestaurantFloorRow,
    RestaurantTableRow,
    TaxRow,
    UomRow,
} from '@domain/types';

/**
 * The catalog index (spec 03 §3.4.2).
 *
 * **Deliberately not React state.** It is read-mostly, several megabytes, and changes only when a
 * delta lands. Putting it behind Immer would cost a structural-sharing pass over the whole thing on
 * every keystroke; putting it in a context value would re-render every consumer on every sync.
 *
 * So: one frozen module singleton, swapped wholesale on reload, with a `version` counter that acts
 * as the second memo key next to `order.rev`. Components that genuinely need to re-render on a
 * catalog swap subscribe through `useCatalog()` (`useSyncExternalStore`); the product grid reads
 * `getCatalog()` directly inside a `useMemo` keyed on `version`.
 */

export type CatalogIndex = {
    readonly version: number;

    readonly config: PosConfigRow | null;
    readonly company: CompanyRow | null;
    readonly currency: CurrencyRow | null;
    readonly currencyFormat: CurrencyFormat;

    readonly products: readonly ProductRow[];
    readonly variants: readonly ProductVariantRow[];
    readonly productsById: ReadonlyMap<number, ProductRow>;
    readonly variantsById: ReadonlyMap<number, ProductVariantRow>;
    readonly variantsByProduct: ReadonlyMap<number, ProductVariantRow[]>;
    readonly defaultVariantByProduct: ReadonlyMap<number, ProductVariantRow>;
    readonly barcodeIndex: ReadonlyMap<string, ProductVariantRow>;
    /** Sellable products, pre-sorted favourites → pos_sequence → name (REG-065). */
    readonly sellable: readonly ProductRow[];
    /** Direct children of a category id (`0` = the roots). */
    readonly categoryChildren: ReadonlyMap<number, PosCategoryRow[]>;
    readonly categoriesById: ReadonlyMap<number, PosCategoryRow>;
    /** Products whose category set contains the key, including descendants. */
    readonly productsByCategory: ReadonlyMap<number, ProductRow[]>;

    readonly attributes: ReadonlyMap<number, ProductAttributeRow>;
    readonly attributeValues: ReadonlyMap<number, ProductAttributeValueRow>;
    readonly attributeLinesByProduct: ReadonlyMap<number, ProductAttributeLineRow[]>;
    readonly attributeLineValuesByLine: ReadonlyMap<number, ProductAttributeLineValueRow[]>;
    readonly attributeLineValuesById: ReadonlyMap<number, ProductAttributeLineValueRow>;
    /** `lineValueId` → excluded `lineValueId`s (REG-073). */
    readonly attributeExclusions: ReadonlyMap<number, number[]>;

    readonly combosById: ReadonlyMap<number, ComboRow>;
    readonly comboItemsByCombo: ReadonlyMap<number, ComboItemRow[]>;

    readonly taxes: ReadonlyMap<number, TaxRow>;
    readonly taxDefinitions: ReadonlyMap<number, TaxDefinition>;
    readonly taxLabels: ReadonlyMap<number, string>;
    readonly fiscalPositions: readonly FiscalPositionRow[];
    readonly fiscalPositionMappings: ReadonlyMap<number, FiscalPosition>;
    readonly cashRounding: CashRounding | null;

    readonly pricelists: readonly PricelistRow[];
    readonly pricelistResolver: PricelistResolver | null;

    readonly paymentMethods: readonly PaymentMethodRow[];
    readonly presets: readonly PosPresetRow[];
    readonly notes: readonly PosNoteRow[];
    readonly bills: readonly PosBillRow[];
    readonly printers: readonly PosPrinterRow[];
    readonly floors: readonly RestaurantFloorRow[];
    readonly tables: readonly RestaurantTableRow[];
    readonly tablesById: ReadonlyMap<number, RestaurantTableRow>;
    readonly employees: readonly EmployeeRow[];
    readonly uoms: ReadonlyMap<number, UomRow>;
    /** `decimal_precisions` keyed by name → digits (REG-177). */
    readonly decimalPrecisions: ReadonlyMap<string, number>;
    readonly nomenclature: Nomenclature | null;
    readonly fallbackNomenclature: Nomenclature | null;
};

export const DEFAULT_CURRENCY_FORMAT: CurrencyFormat = {
    symbol: '€',
    position: 'after',
    decimalPlaces: 2,
    decimalSeparator: ',',
    thousandsSeparator: ' ',
};

export function emptyCatalog(): CatalogIndex {
    const none = new Map<number, never>();
    return Object.freeze({
        version: 0,
        config: null,
        company: null,
        currency: null,
        currencyFormat: DEFAULT_CURRENCY_FORMAT,
        products: [],
        variants: [],
        productsById: none,
        variantsById: none,
        variantsByProduct: none,
        defaultVariantByProduct: none,
        barcodeIndex: new Map(),
        sellable: [],
        categoryChildren: none,
        categoriesById: none,
        productsByCategory: none,
        attributes: none,
        attributeValues: none,
        attributeLinesByProduct: none,
        attributeLineValuesByLine: none,
        attributeLineValuesById: none,
        attributeExclusions: none,
        combosById: none,
        comboItemsByCombo: none,
        taxes: none,
        taxDefinitions: none,
        taxLabels: none,
        fiscalPositions: [],
        fiscalPositionMappings: none,
        cashRounding: null,
        pricelists: [],
        pricelistResolver: null,
        paymentMethods: [],
        presets: [],
        notes: [],
        bills: [],
        printers: [],
        floors: [],
        tables: [],
        tablesById: none,
        employees: [],
        uoms: none,
        decimalPrecisions: new Map<string, number>(),
        nomenclature: null,
        fallbackNomenclature: null,
    }) as CatalogIndex;
}

let current: CatalogIndex = emptyCatalog();
const listeners = new Set<() => void>();

export function getCatalog(): CatalogIndex {
    return current;
}

/** Swap the whole index. The only writer is the boot/delta pipeline (and the tests). */
export function setCatalog(next: CatalogIndex): void {
    current = Object.freeze(next);
    for (const listener of listeners) listener();
}

export function subscribeCatalog(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookup helpers — used everywhere, so they live next to the index
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Digits configured for a `decimal.precision` domain, or `fallback` when the site has no row for
 * it (REG-177). The names are the seeded ones exported from `@domain/money/precision`.
 */
export function precisionDigits(catalog: CatalogIndex, name: string, fallback: number): number {
    return catalog.decimalPrecisions.get(name) ?? fallback;
}

export function variantOf(catalog: CatalogIndex, variantId: number): ProductVariantRow | null {
    return catalog.variantsById.get(variantId) ?? null;
}

export function productOfVariant(catalog: CatalogIndex, variantId: number): ProductRow | null {
    const variant = catalog.variantsById.get(variantId);
    return variant ? (catalog.productsById.get(variant.product_id) ?? null) : null;
}

/** The list price of a variant, falling back to the parent product plus the variant's extra. */
export function baseListPrice(catalog: CatalogIndex, variantId: number): string {
    const variant = catalog.variantsById.get(variantId);
    if (!variant) return '0';
    if (variant.list_price !== null) return variant.list_price;
    const product = catalog.productsById.get(variant.product_id);
    return product?.list_price ?? '0';
}

export function taxIdsFor(catalog: CatalogIndex, variantId: number): number[] {
    const variant = catalog.variantsById.get(variantId);
    if (!variant) return [];
    // Variant-level taxes are optional and may be absent (undefined) rather than null in the
    // payload; fall through to the product's taxes instead of crashing on `.length`.
    if (Array.isArray(variant.tax_ids) && variant.tax_ids.length > 0) return variant.tax_ids;
    return catalog.productsById.get(variant.product_id)?.tax_ids ?? [];
}

export function primaryCategoryOf(catalog: CatalogIndex, variantId: number): number | null {
    const product = productOfVariant(catalog, variantId);
    return product?.pos_category_ids[0] ?? null;
}

/** Display name used on the line and on the receipt (REG-113). */
export function fullProductName(
    catalog: CatalogIndex,
    variantId: number,
    attributeLineValueIds: readonly number[] = [],
): string {
    const variant = catalog.variantsById.get(variantId);
    if (!variant) return '';
    const base = variant.display_name;
    const suffixes = attributeLineValueIds
        .map((id) => {
            const lineValue = catalog.attributeLineValuesById.get(id);
            if (!lineValue) return null;
            return catalog.attributeValues.get(lineValue.product_attribute_value_id)?.name ?? null;
        })
        .filter((value): value is string => value !== null);
    return suffixes.length > 0 ? `${base} (${suffixes.join(', ')})` : base;
}

/** Every descendant id of a category, itself included. */
export function categoryDescendants(catalog: CatalogIndex, categoryId: number): number[] {
    const out: number[] = [categoryId];
    const queue = [categoryId];
    for (let guard = 0; queue.length > 0 && guard < 4096; guard++) {
        const id = queue.shift();
        if (id === undefined) break;
        for (const child of catalog.categoryChildren.get(id) ?? []) {
            out.push(child.id);
            queue.push(child.id);
        }
    }
    return out;
}

/** Category availability window (REG-063). `hour_after`/`hour_until` are hours of the day. */
export function categoryAvailableNow(category: PosCategoryRow, now = new Date()): boolean {
    if (category.hour_after === null && category.hour_until === null) return true;
    const hour = now.getHours() + now.getMinutes() / 60;
    const from = category.hour_after ?? 0;
    const until = category.hour_until ?? 24;
    return from <= until ? hour >= from && hour <= until : hour >= from || hour <= until;
}
