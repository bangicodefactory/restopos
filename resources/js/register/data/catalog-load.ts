import { buildNomenclature } from '@domain/barcode/index';
import { PricelistResolver, type Pricelist, type PricelistItem } from '@domain/pricing/pricelist';
import type { CurrencyFormat } from '@domain/receipt/index';
import type { CashRounding, FiscalPosition, TaxDefinition } from '@domain/tax/types';
import type {
    PosCategoryRow,
    PosConfigRow,
    PricelistItemRow,
    ProductAttributeExclusionRow,
    ProductAttributeLineRow,
    ProductAttributeLineValueRow,
    ProductRow,
    ProductVariantRow,
    TaxRow,
} from '@domain/types';
import type { PosDb } from '@shared/db';

import { DEFAULT_CURRENCY_FORMAT, emptyCatalog, type CatalogIndex } from './catalog';

/**
 * Build the in-memory index from IndexedDB — one read transaction, then pure map building.
 *
 * This is on the cold-boot critical path (spec 03 §3.3: interactive in < 1.2 s on a 2019 tablet),
 * so everything here is a single pass. Sorting the sellable list once at load is what lets the
 * product grid be a plain slice of a frozen array instead of a per-keystroke sort.
 */

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K | null): Map<K, T[]> {
    const out = new Map<K, T[]>();
    for (const row of rows) {
        const k = key(row);
        if (k === null) continue;
        const bucket = out.get(k);
        if (bucket) bucket.push(row);
        else out.set(k, [row]);
    }
    return out;
}

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

function toPricelistItem(row: PricelistItemRow): PricelistItem {
    return {
        id: row.id,
        appliedOn: row.applied_on,
        productVariantId: row.product_variant_id,
        productId: row.product_id,
        posCategoryId: row.pos_category_id,
        minQuantity: String(row.min_quantity),
        dateStart: row.date_start,
        dateEnd: row.date_end,
        computePrice: row.compute_price,
        fixedPrice: row.fixed_price,
        percentPrice: row.percent_price,
        base: row.base,
        basePricelistId: row.base_pricelist_id,
        priceDiscount: row.price_discount,
        priceSurcharge: row.price_surcharge,
        priceRound: row.price_round,
        priceMinMargin: row.price_min_margin,
        priceMaxMargin: row.price_max_margin,
        sequence: row.sequence,
    };
}

function currencyFormatOf(
    currency: { symbol: string; symbol_position: string; decimal_places: number; decimal_separator: string; thousands_separator: string } | undefined,
): CurrencyFormat {
    if (!currency) return DEFAULT_CURRENCY_FORMAT;
    return {
        symbol: currency.symbol,
        position: currency.symbol_position === 'before' ? 'before' : 'after',
        decimalPlaces: currency.decimal_places,
        decimalSeparator: currency.decimal_separator || ',',
        thousandsSeparator: currency.thousands_separator || ' ',
    };
}

/** Favourites first, then `pos_sequence`, then name (REG-065). */
function sellableOrder(a: ProductRow, b: ProductRow): number {
    if (a.is_favorite !== b.is_favorite) return a.is_favorite ? -1 : 1;
    if (a.pos_sequence !== b.pos_sequence) return a.pos_sequence - b.pos_sequence;
    return a.name.localeCompare(b.name);
}

function ancestorsOf(category: PosCategoryRow, byId: Map<number, PosCategoryRow>): number[] {
    if (category.ancestorIds && category.ancestorIds.length > 0) return category.ancestorIds;
    const out: number[] = [];
    let parent = category.parent_id;
    for (let depth = 0; parent !== null && depth < 32; depth++) {
        out.unshift(parent);
        parent = byId.get(parent)?.parent_id ?? null;
    }
    return out;
}

export async function loadCatalogIndex(db: PosDb, version: number): Promise<CatalogIndex> {
    const [
        configs,
        companies,
        currencies,
        decimalPrecisions,
        uoms,
        taxes,
        fiscalPositions,
        fiscalPositionTaxes,
        cashRoundings,
        categories,
        products,
        variants,
        attributes,
        attributeValues,
        attributeLines,
        attributeLineValues,
        attributeExclusions,
        combos,
        comboItems,
        pricelists,
        pricelistItems,
        nomenclatures,
        barcodeRules,
        paymentMethods,
        presets,
        notes,
        bills,
        printers,
        floors,
        tables,
        employees,
    ] = await Promise.all([
        db.configs.toArray(),
        db.companies.toArray(),
        db.currencies.toArray(),
        db.decimalPrecisions.toArray(),
        db.uoms.toArray(),
        db.taxes.toArray(),
        db.fiscalPositions.toArray(),
        db.fiscalPositionTaxes.toArray(),
        db.cashRoundings.toArray(),
        db.posCategories.toArray(),
        db.products.toArray(),
        db.variants.toArray(),
        db.attributes.toArray(),
        db.attributeValues.toArray(),
        db.attributeLines.toArray(),
        db.attributeLineValues.toArray(),
        db.attributeExclusions.toArray(),
        db.combos.toArray(),
        db.comboItems.toArray(),
        db.pricelists.toArray(),
        db.pricelistItems.toArray(),
        db.barcodeNomenclatures.toArray(),
        db.barcodeRules.toArray(),
        db.paymentMethods.toArray(),
        db.presets.toArray(),
        db.notes.toArray(),
        db.bills.toArray(),
        db.printers.toArray(),
        db.floors.toArray(),
        db.restaurantTables.toArray(),
        db.employees.toArray(),
    ]);

    const config: PosConfigRow | null = configs[0] ?? null;
    const currency = currencies.find((c) => c.id === config?.currency_id) ?? currencies[0] ?? null;
    const company = companies.find((c) => c.id === config?.company_id) ?? companies[0] ?? null;

    const productsById = new Map(products.map((p) => [p.id, p]));
    const variantsById = new Map(variants.map((v) => [v.id, v]));
    const variantsByProduct = groupBy(variants, (v) => v.product_id);
    const defaultVariantByProduct = new Map<number, ProductVariantRow>();
    const barcodeIndex = new Map<string, ProductVariantRow>();
    for (const [productId, list] of variantsByProduct) {
        const active = list.filter((v) => v.active && v.is_active_combination);
        const first = active[0] ?? list[0];
        if (first) defaultVariantByProduct.set(productId, first);
    }
    for (const variant of variants) {
        if (variant.barcode) barcodeIndex.set(variant.barcode, variant);
    }
    for (const product of products) {
        if (!product.barcode) continue;
        const variant = defaultVariantByProduct.get(product.id);
        if (variant && !barcodeIndex.has(product.barcode)) barcodeIndex.set(product.barcode, variant);
    }

    const categoriesById = new Map(categories.map((c) => [c.id, c]));
    const categoryChildren = new Map<number, PosCategoryRow[]>();
    for (const category of [...categories].sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name))) {
        const key = category.parent_id ?? 0;
        const bucket = categoryChildren.get(key);
        if (bucket) bucket.push(category);
        else categoryChildren.set(key, [category]);
    }

    const allowed = config?.limit_categories === true ? new Set(config.iface_available_categ_ids) : null;
    const sellable = products
        .filter((p) => p.active && p.available_in_pos && !p.is_special)
        .filter((p) => allowed === null || p.pos_category_ids.some((id) => allowed.has(id)))
        .sort(sellableOrder);

    // A product listed in a leaf category is browsable from every ancestor of that category.
    const productsByCategory = new Map<number, ProductRow[]>();
    for (const product of sellable) {
        const seen = new Set<number>();
        for (const categoryId of product.pos_category_ids) {
            const category = categoriesById.get(categoryId);
            const ids = category ? [...ancestorsOf(category, categoriesById), categoryId] : [categoryId];
            for (const id of ids) {
                if (seen.has(id)) continue;
                seen.add(id);
                const bucket = productsByCategory.get(id);
                if (bucket) bucket.push(product);
                else productsByCategory.set(id, [product]);
            }
        }
    }

    const exclusions = new Map<number, number[]>();
    for (const row of attributeExclusions as ProductAttributeExclusionRow[]) {
        const bucket = exclusions.get(row.product_attribute_line_value_id);
        if (bucket) bucket.push(row.excluded_value_id);
        else exclusions.set(row.product_attribute_line_value_id, [row.excluded_value_id]);
    }

    const fiscalPositionMappings = new Map<number, FiscalPosition>();
    for (const position of fiscalPositions) {
        fiscalPositionMappings.set(position.id, {
            id: position.id,
            name: position.name,
            mappings: fiscalPositionTaxes
                .filter((t) => t.fiscal_position_id === position.id)
                .map((t) => ({ taxSrcId: t.source_tax_id, taxDestId: t.dest_tax_id })),
        });
    }

    const roundingRow = cashRoundings.find((r) => r.id === config?.cash_rounding_id) ?? null;
    const cashRounding: CashRounding | null = roundingRow
        ? {
              rounding: roundingRow.rounding,
              method: roundingRow.rounding_method,
              strategy: roundingRow.strategy,
          }
        : null;

    const pricelistDefs: Pricelist[] = pricelists.map((list) => ({
        id: list.id,
        items: pricelistItems.filter((item) => item.pricelist_id === list.id).map(toPricelistItem),
    }));

    const primaryNomenclature =
        nomenclatures.find((n) => n.id === company?.barcode_nomenclature_id) ?? nomenclatures[0] ?? null;
    const fallbackRow = nomenclatures.find((n) => n.id !== primaryNomenclature?.id) ?? null;

    const attributeLinesByProduct = groupBy<ProductAttributeLineRow, number>(
        [...attributeLines].sort((a, b) => a.sequence - b.sequence || a.id - b.id),
        (row) => row.product_id,
    );
    const attributeLineValuesByLine = groupBy<ProductAttributeLineValueRow, number>(
        [...attributeLineValues].sort((a, b) => a.sequence - b.sequence || a.id - b.id),
        (row) => row.product_attribute_line_id,
    );

    return {
        ...emptyCatalog(),
        version,
        config,
        company,
        currency,
        currencyFormat: currencyFormatOf(currency ?? undefined),

        products,
        variants,
        productsById,
        variantsById,
        variantsByProduct,
        defaultVariantByProduct,
        barcodeIndex,
        sellable,
        categoryChildren,
        categoriesById,
        productsByCategory,

        attributes: new Map(attributes.map((a) => [a.id, a])),
        attributeValues: new Map(attributeValues.map((v) => [v.id, v])),
        attributeLinesByProduct,
        attributeLineValuesByLine,
        attributeLineValuesById: new Map(attributeLineValues.map((v) => [v.id, v])),
        attributeExclusions: exclusions,

        combosById: new Map(combos.map((c) => [c.id, c])),
        comboItemsByCombo: groupBy(
            [...comboItems].sort((a, b) => a.sequence - b.sequence || a.id - b.id),
            (row) => row.combo_id,
        ),

        taxes: new Map(taxes.map((t) => [t.id, t])),
        taxDefinitions: new Map(taxes.map((t) => [t.id, toTaxDefinition(t)])),
        taxLabels: new Map(taxes.map((t) => [t.id, t.label ?? t.name])),
        fiscalPositions,
        fiscalPositionMappings,
        cashRounding,

        pricelists,
        pricelistResolver: PricelistResolver.fromArray(pricelistDefs),

        paymentMethods: [...paymentMethods].sort((a, b) => a.sequence - b.sequence),
        presets: [...presets].sort((a, b) => a.sequence - b.sequence),
        notes: [...notes].sort((a, b) => a.sequence - b.sequence),
        bills: [...bills].sort((a, b) => a.sequence - b.sequence),
        printers,
        floors: [...floors].sort((a, b) => a.sequence - b.sequence),
        tables,
        tablesById: new Map(tables.map((t) => [t.id, t])),
        // The bootstrap employee verifier payload is already scoped to active candidates for this
        // config and omits `active`; treat absent as active rather than filtering everyone out.
        employees: employees.filter((e) => e.active !== false),
        uoms: new Map(uoms.map((u) => [u.id, u])),
        decimalPrecisions: new Map(decimalPrecisions.map((p) => [p.name, p.digits])),
        nomenclature: primaryNomenclature ? buildNomenclature(primaryNomenclature, barcodeRules) : null,
        fallbackNomenclature: fallbackRow ? buildNomenclature(fallbackRow, barcodeRules) : null,
    };
}
