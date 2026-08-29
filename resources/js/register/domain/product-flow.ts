import type { ProductRow } from '@domain/types';

import { getCatalog } from '../data/catalog';
import { useOrderStore } from '../state/order-store';
import { useUiStore } from '../state/ui-store';
import { addLine } from './order-actions';

/**
 * The add-a-product pipeline (REG-100).
 *
 * Odoo's order of steps is not arbitrary and each step can cancel the add:
 *
 *     refund guard → configurator → combo → scale → price → merge → optional products
 *
 * Reproducing the *order* matters more than reproducing any single step: a combo whose components
 * are chosen after the price is computed prices the wrong thing, and a weighed product configured
 * before it is weighed asks the cashier for options they cannot answer yet.
 *
 * This module decides; the dialogs perform. Everything that ends in an actual line goes through
 * `addLine` in `order-actions`, never around it.
 */

export type AddDecision =
    | { kind: 'add'; variantId: number }
    | { kind: 'variant'; productId: number }
    | { kind: 'combo'; productId: number }
    | { kind: 'scale'; variantId: number }
    | { kind: 'openPrice'; variantId: number }
    | { kind: 'blocked'; reason: 'refund_order' | 'no_variant' | 'incomplete_options' };

export function decideAdd(product: ProductRow, orderUuid: string | null): AddDecision {
    const catalog = getCatalog();
    const order = orderUuid !== null ? useOrderStore.getState().orders[orderUuid] : null;

    // REG-274 — a refund order accepts no positive lines.
    if (order?.is_refund) return { kind: 'blocked', reason: 'refund_order' };

    const variant = catalog.defaultVariantByProduct.get(product.id);
    if (!variant) return { kind: 'blocked', reason: 'no_variant' };

    // A product can reach the grid without the data its configurator needs (BAN-421a). The lazy
    // scan-miss fetch returns products and variants only — no attribute lines, no combos — so a
    // configurable product pulled in that way is browsable and tappable with nothing behind it.
    //
    // Left unchecked the dialog opens empty, `missing` is empty because `lines` is empty, so the
    // Add button is enabled, and `matchVariant(productId, [])` falls through to the default
    // variant: the wrong SKU at the wrong price on the customer's bill and the wrong ticket in
    // the kitchen. Refuse instead — the same call as `no_variant` above, and the same reason.
    //
    // Scanning such a product is unaffected: `routeScan` resolves a barcode to a variant and
    // `applyScan` adds that variant directly, never coming through here.
    if (product.combo_count > 0) {
        // Per product, not a global count: a venue with other combos would otherwise let a
        // lazily fetched one straight through, which is the case this guard is for.
        const resolvable = product.combo_ids.filter((id) => catalog.combosById.has(id));
        if (resolvable.length === 0) return { kind: 'blocked', reason: 'incomplete_options' };

        return { kind: 'combo', productId: product.id };
    }

    if (product.attribute_count > 0) {
        const lines = catalog.attributeLinesByProduct.get(product.id) ?? [];
        if (lines.length === 0) return { kind: 'blocked', reason: 'incomplete_options' };

        return { kind: 'variant', productId: product.id };
    }
    if (product.to_weight) return { kind: 'scale', variantId: variant.id };
    if (product.special_kind === 'deposit' || product.list_price === '0')
        return { kind: 'openPrice', variantId: variant.id };

    return { kind: 'add', variantId: variant.id };
}

/** Apply a decision: either the line lands immediately, or the right dialog opens. */
export function startAdd(product: ProductRow, orderUuid: string, quantity = 1): AddDecision {
    const decision = decideAdd(product, orderUuid);
    const ui = useUiStore.getState();

    switch (decision.kind) {
        case 'add':
            addLine({ orderUuid, variantId: decision.variantId, quantity });
            break;
        case 'variant':
            ui.openDialog('variant', { productId: decision.productId, quantity });
            break;
        case 'combo':
            ui.openDialog('combo', { productId: decision.productId, quantity });
            break;
        case 'scale':
            ui.openDialog('scale', { variantId: decision.variantId });
            break;
        case 'openPrice':
            ui.openDialog('openPrice', { variantId: decision.variantId, quantity });
            break;
        case 'blocked':
            break;
    }

    return decision;
}

/** REG-073 — a value is selectable only if no already-chosen value excludes it. */
export function excludedValueIds(chosen: readonly number[]): Set<number> {
    const catalog = getCatalog();
    const out = new Set<number>();
    for (const id of chosen) {
        for (const excluded of catalog.attributeExclusions.get(id) ?? []) out.add(excluded);
    }
    return out;
}

/**
 * Find the variant matching a set of attribute values.
 *
 * Attributes configured as `no_variant` do not participate — their price extra rides on the line
 * instead — so a subset match against the variant's own value ids is the right test.
 */
export function matchVariant(productId: number, chosen: readonly number[]): number | null {
    const catalog = getCatalog();
    const variants = catalog.variantsByProduct.get(productId) ?? [];
    if (variants.length === 1) return variants[0]?.id ?? null;

    const wanted = new Set(chosen);
    const exact = variants.find(
        (variant) =>
            variant.is_active_combination &&
            variant.attribute_line_value_ids.length > 0 &&
            variant.attribute_line_value_ids.every((id) => wanted.has(id)),
    );
    return exact?.id ?? catalog.defaultVariantByProduct.get(productId)?.id ?? null;
}
