import { Decimal } from '@domain/money/decimal';
import { distributeComboPrice } from '@domain/pricing/combo';

import type { Catalog, MenuCombo, MenuComboItem, MenuProduct } from '../catalog';
import { resolveVariant, taxIdsFor, variantUnitPrice } from '../catalog';
import type { CartDraft } from './cart';

/**
 * The combo stepper (SLF-030, REG-075).
 *
 * A combo product ("menu du jour") owns N *choices* (`product.combo` rows). Each choice offers a
 * set of items, includes `qty_free` picks in the headline price and allows up to `qty_max`. Picks
 * beyond the free quota cost the choice's `base_price` plus the item's `extra_price`; attribute
 * extras always apply.
 *
 * The pricing split then has to match the register's exactly, because the same order is priced
 * again server-side and a mismatch is a `client_total_mismatch` warning on every combo sold. That
 * is why the per-child unit prices come from `@domain/pricing/combo` — one implementation, already
 * fixture-tested, residue landing on the last component (`9.99` across two equal components splits
 * `5.00 / 4.99`).
 */

export type ComboStep = {
    combo: MenuCombo;
    /** Items with their resolved display data. */
    options: ComboOption[];
    qtyFree: number;
    qtyMax: number;
    /** A choice with one non-configurable item needs no interaction — it is auto-selected. */
    interactive: boolean;
};

export type ComboOption = {
    item: MenuComboItem;
    productId: number;
    name: string;
    /** Surcharge shown on the option card, before the free quota is considered. */
    extraPrice: string;
    available: boolean;
    /** True when the item has attribute questions of its own. */
    configurable: boolean;
};

export type ComboSelection = {
    comboId: number;
    comboItemId: number;
    variantId: number;
    productId: number;
    name: string;
    attributeValueIds: number[];
};

/**
 * Build the steps for a combo product.
 *
 * "Only choices needing interaction are shown as steps" (SLF-030): a choice with exactly one
 * non-configurable option and `qty_max = 1` has no decision in it, so it is marked non-interactive
 * and auto-selected rather than making the customer tap Next on a screen with one button.
 */
export function buildSteps(catalog: Catalog, product: MenuProduct): ComboStep[] {
    return product.comboIds
        .map((id) => catalog.combosById.get(id))
        .filter((combo): combo is MenuCombo => combo !== undefined)
        .sort((a, b) => a.sequence - b.sequence || a.id - b.id)
        .map((combo) => {
            const options: ComboOption[] = combo.items.map((item) => {
                const variant = catalog.variantsById.get(item.variantId);
                const itemProduct = variant ? catalog.productsById.get(variant.productId) : undefined;
                const lines = itemProduct ? (catalog.attributeLinesByProduct.get(itemProduct.id) ?? []) : [];
                return {
                    item,
                    productId: itemProduct?.id ?? 0,
                    name: variant?.displayName ?? itemProduct?.name ?? '',
                    extraPrice: item.extraPrice,
                    available: (variant?.available ?? false) && (itemProduct?.available ?? false),
                    configurable: lines.length > 0,
                };
            });

            const usable = options.filter((option) => option.available);
            return {
                combo,
                options,
                qtyFree: combo.qtyFree,
                qtyMax: combo.qtyMax,
                interactive: combo.qtyMax > 1 || usable.length > 1 || usable.some((option) => option.configurable),
            };
        });
}

/** The picks a non-interactive step makes on the customer's behalf. */
export function autoSelect(step: ComboStep): ComboSelection[] {
    if (step.interactive) return [];
    const option = step.options.find((candidate) => candidate.available);
    if (!option) return [];
    return [
        {
            comboId: step.combo.id,
            comboItemId: option.item.id,
            variantId: option.item.variantId,
            productId: option.productId,
            name: option.name,
            attributeValueIds: [],
        },
    ];
}

export type StepValidity = {
    stepIndex: number;
    comboId: number;
    /** Fewer picks than the choice requires. Every choice needs at least one. */
    missing: boolean;
    /** More picks than `qty_max`. */
    exceeded: boolean;
};

/**
 * Is this configuration orderable?
 *
 * Every choice needs at least one pick and at most `qty_max`. There is no "skip this course" —
 * a combo with an unmade choice is an order the kitchen cannot assemble.
 */
export function validateSelections(
    steps: readonly ComboStep[],
    selections: readonly ComboSelection[],
): { valid: boolean; problems: StepValidity[] } {
    const problems: StepValidity[] = [];

    steps.forEach((step, stepIndex) => {
        const count = selections.filter((selection) => selection.comboId === step.combo.id).length;
        const missing = count < 1;
        const exceeded = count > step.qtyMax;
        if (missing || exceeded) {
            problems.push({ stepIndex, comboId: step.combo.id, missing, exceeded });
        }
    });

    return { valid: problems.length === 0, problems };
}

/** Toggle a pick, respecting `qty_max`: at the cap, a new pick replaces the oldest one. */
export function togglePick(
    step: ComboStep,
    selections: readonly ComboSelection[],
    pick: ComboSelection,
): ComboSelection[] {
    const mine = selections.filter((selection) => selection.comboId === step.combo.id);
    const others = selections.filter((selection) => selection.comboId !== step.combo.id);

    const existing = mine.findIndex(
        (selection) =>
            selection.comboItemId === pick.comboItemId &&
            selection.variantId === pick.variantId &&
            sameIds(selection.attributeValueIds, pick.attributeValueIds),
    );

    if (existing !== -1) {
        // Never leave a choice empty — un-picking the last selection is a no-op, not an invalid cart.
        if (mine.length === 1) return [...selections];
        return [...others, ...mine.filter((_, index) => index !== existing)];
    }

    if (step.qtyMax === 1) return [...others, pick];
    if (mine.length >= step.qtyMax) return [...others, ...mine.slice(1), pick];
    return [...others, ...mine, pick];
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
    if (a.length !== b.length) return false;
    const left = [...a].sort((x, y) => x - y);
    const right = [...b].sort((x, y) => x - y);
    return left.every((value, index) => value === right[index]);
}

/**
 * The surcharge on top of the combo product's headline price.
 *
 * Per choice, picks are charged in selection order: the first `qty_free` are included, and each one
 * after that costs the choice's `base_price`. Every pick, free or not, adds its item's
 * `extra_price` and any attribute extras — a "free" pick of the expensive steak is still an upsell.
 */
export function comboSurcharge(
    catalog: Catalog,
    steps: readonly ComboStep[],
    selections: readonly ComboSelection[],
): string {
    return Decimal.of(quotaSurcharge(steps, selections))
        .add(Decimal.of(extrasTotal(catalog, steps, selections)))
        .withScale(catalog.currency.decimalPlaces)
        .toString();
}

/**
 * The part of the surcharge that belongs to the *meal*: one `base_price` for every pick past the
 * choice's free quota.
 *
 * Split out from the item/attribute extras because the two behave differently in the price split
 * below — this part is distributed across the components, the extras sit on the component that
 * caused them.
 */
function quotaSurcharge(steps: readonly ComboStep[], selections: readonly ComboSelection[]): string {
    let total = Decimal.of('0');
    for (const step of steps) {
        const mine = selections.filter((selection) => selection.comboId === step.combo.id);
        for (let index = step.qtyFree; index < mine.length; index++) {
            total = total.add(Decimal.of(step.combo.basePrice));
        }
    }
    return total.toString();
}

/** Item `extra_price` plus attribute extras, across every pick. */
function extrasTotal(
    catalog: Catalog,
    steps: readonly ComboStep[],
    selections: readonly ComboSelection[],
): string {
    let total = Decimal.of('0');
    for (const selection of selections) {
        const step = steps.find((candidate) => candidate.combo.id === selection.comboId);
        const option = step?.options.find((candidate) => candidate.item.id === selection.comboItemId);
        if (option) total = total.add(Decimal.of(option.extraPrice));
        for (const valueId of selection.attributeValueIds) {
            const value = catalog.attributeLineValuesById.get(valueId);
            if (value) total = total.add(Decimal.of(value.priceExtra));
        }
    }
    return total.toString();
}

/** What the stepper's running total shows: the combo's own price plus the surcharge. */
export function comboTotalPrice(
    catalog: Catalog,
    product: MenuProduct,
    steps: readonly ComboStep[],
    selections: readonly ComboSelection[],
): string {
    return Decimal.of(product.listPrice)
        .add(Decimal.of(comboSurcharge(catalog, steps, selections)))
        .withScale(catalog.currency.decimalPlaces)
        .toString();
}

/**
 * Turn a completed stepper into cart lines: one parent carrying the whole price, one child per pick
 * carrying its share.
 *
 * The parent's own `unitPrice` is zero. All of the money lives on the children, distributed by
 * `@domain/pricing/combo` in stepper order — that is what makes the cart's total, the register's
 * total and the server's recomputation agree to the cent.
 */
export function toCartLines(
    catalog: Catalog,
    product: MenuProduct,
    steps: readonly ComboStep[],
    selections: readonly ComboSelection[],
    quantity = 1,
): { parent: CartDraft; children: CartDraft[] } {
    const parentVariant = resolveVariant(catalog, product.id, []);

    /*
     * `distributeComboPrice` adds `extraPrice` and `attributeExtra` *on top of* each component's
     * share (spec 04 §11.2.4), so the amount handed to it must be the meal's own price only —
     * headline price plus the beyond-free-quota base prices. Passing the customer-facing total here
     * would charge every item extra twice, which is exactly the bug the first version of this
     * function had and the reason the test asserts cart total == quoted total.
     */
    const parentPrice = Decimal.of(product.listPrice)
        .add(Decimal.of(quotaSurcharge(steps, selections)))
        .toString();

    const components = selections.map((selection) => {
        const step = steps.find((candidate) => candidate.combo.id === selection.comboId);
        const option = step?.options.find((candidate) => candidate.item.id === selection.comboItemId);
        const attributeExtra = selection.attributeValueIds.reduce(
            (total, id) => total.add(Decimal.of(catalog.attributeLineValuesById.get(id)?.priceExtra ?? '0')),
            Decimal.of('0'),
        );
        return {
            id: String(selection.comboItemId),
            // The weight of this component in the split: the choice's base price, which is what
            // "how much of the meal deal is this item worth" means in the data model.
            comboBasePrice: step?.combo.basePrice ?? '0',
            quantity: '1',
            extraPrice: option?.extraPrice ?? '0',
            attributeExtra: attributeExtra.toString(),
        };
    });

    const shares = distributeComboPrice({
        parentPrice,
        precision: roundingStep(catalog.currency.decimalPlaces),
        components,
    });

    const children: CartDraft[] = selections.map((selection, index) => {
        const variant = catalog.variantsById.get(selection.variantId) ?? null;
        const childProduct = catalog.productsById.get(selection.productId);
        return {
            variantId: selection.variantId,
            productId: selection.productId,
            name: selection.name,
            quantity,
            unitPrice: shares[index]?.priceUnit ?? '0',
            taxIds: childProduct ? taxIdsFor(variant, childProduct) : [],
            attributeValueIds: [...selection.attributeValueIds],
            note: null,
            comboParentUuid: null, // rewritten by `addLine` to the parent's uuid
            comboId: selection.comboId,
            comboItemId: selection.comboItemId,
        };
    });

    return {
        parent: {
            variantId: parentVariant?.id ?? 0,
            productId: product.id,
            name: product.name,
            quantity,
            // All of the money is on the children; a parent that also carried a price would
            // double-count the meal.
            unitPrice: '0',
            taxIds: [],
            attributeValueIds: [],
            note: null,
            comboParentUuid: null,
            comboId: null,
            comboItemId: null,
        },
        children,
    };
}

/** The name a combo line shows in the cart: "Menu — Margherita, Coke". */
export function comboLineName(product: MenuProduct, selections: readonly ComboSelection[]): string {
    if (selections.length === 0) return product.name;
    return `${product.name} — ${selections.map((selection) => selection.name).join(', ')}`;
}

export function isCombo(product: MenuProduct): boolean {
    return product.comboIds.length > 0;
}

/** True when the product needs a detail sheet before it can be added (SLF-027, SLF-029). */
export function needsConfiguration(catalog: Catalog, product: MenuProduct): boolean {
    if (isCombo(product)) return true;
    return (catalog.attributeLinesByProduct.get(product.id) ?? []).length > 0;
}

/** Required attribute lines with nothing chosen yet (SLF-029). */
export function missingRequiredAttributes(
    catalog: Catalog,
    product: MenuProduct,
    selectedLineValueIds: readonly number[],
): number[] {
    const lines = catalog.attributeLinesByProduct.get(product.id) ?? [];
    return lines
        .filter(
            (line) =>
                line.required &&
                !line.values.some((value) => selectedLineValueIds.includes(value.id)),
        )
        .map((line) => line.id);
}

/** Add-to-cart draft for a simple (non-combo) product. */
export function toSimpleCartLine(
    catalog: Catalog,
    product: MenuProduct,
    selectedLineValueIds: readonly number[],
    quantity: number,
    note: string | null,
): CartDraft | null {
    const variant = resolveVariant(catalog, product.id, selectedLineValueIds);
    if (!variant) return null;

    // `no_variant` attribute values ride on the line; variant-affecting ones are already baked into
    // the resolved variant's price, so charging their extra again would double-count it.
    const rideAlong = selectedLineValueIds.filter((id) => !variant.attributeLineValueIds.includes(id));
    const suffix = rideAlong
        .map((id) => catalog.attributeLineValuesById.get(id)?.name)
        .filter((name): name is string => typeof name === 'string' && name !== '');

    return {
        variantId: variant.id,
        productId: product.id,
        name: suffix.length > 0 ? `${variant.displayName} (${suffix.join(', ')})` : variant.displayName,
        quantity,
        unitPrice: variantUnitPrice(catalog, variant, product, rideAlong),
        taxIds: taxIdsFor(variant, product),
        attributeValueIds: [...selectedLineValueIds],
        note,
        comboParentUuid: null,
        comboId: null,
        comboItemId: null,
    };
}

function roundingStep(decimalPlaces: number): string {
    if (decimalPlaces <= 0) return '1';
    return `0.${'0'.repeat(decimalPlaces - 1)}1`;
}
