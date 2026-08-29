/**
 * The weight-change rule, scoped (REG-077, XCT-058).
 *
 * Odoo's legal-metrology rule is that a product may only be added at a weight that **differs from
 * the previously accepted weight**. It exists because tapping confirm twice on a settled 200 g is
 * how the same block of cheese gets charged for twice, and inspectors in France and Belgium test
 * for exactly that.
 *
 * This file exists because of *how* the register held that "previously accepted weight" before it:
 *
 *     let lastAcceptedWeight: number | null = null;     // ScaleDialog.tsx:21
 *
 * A module-level binding, alive for the lifetime of the page — which on a till PWA is the lifetime
 * of the shift. One number, shared by every product, every order and every cashier. Three things
 * follow, and all three are wrong in the direction of refusing legitimate sales:
 *
 *  1. **Across products.** 200 g of gruyère, then 200 g of olives: the second is refused, because
 *     the number remembered has nothing to do with what is being weighed.
 *  2. **Across orders.** Two customers who buy the same 300 g of coffee back to back: the second
 *     is refused. Nothing in the rule says a *different sale* may not weigh the same.
 *  3. **Never released.** Nothing reset it — not closing the order, not validating it, not logging
 *     out. A cashier who hit the refusal had no action available that would clear it.
 *
 * So the memory is keyed on (order, variant) and dropped when the order goes. The rule still bites
 * where it was written to bite — the same item, weighed twice, on the same bill — and stops biting
 * where it never should have.
 *
 * This is the *arithmetic* half of the rule. The mechanical half, "the pan must return to zero
 * between two weighings", is in `@shared/scale`'s reader and only applies when a scale is actually
 * connected. Manual entry has no pan, so this is all there is, which is why it survives the driver.
 */

/** One gram. Two weights closer than this are the same weight to any scale a bistro owns. */
const EPSILON_KG = 0.0005;

const accepted = new Map<string, number>();

function keyOf(orderUuid: string, variantId: number): string {
    return `${orderUuid}|${variantId}`;
}

/**
 * Would this weight be refused as a repeat of the last one accepted for the same item on the same
 * order? False when nothing has been weighed yet — the first weighing is always allowed.
 */
export function isRepeatWeight(orderUuid: string, variantId: number, weightKg: number): boolean {
    const last = accepted.get(keyOf(orderUuid, variantId));

    return last !== undefined && Math.abs(last - weightKg) < EPSILON_KG;
}

/** Remember a weight that went onto a line. */
export function recordAcceptedWeight(orderUuid: string, variantId: number, weightKg: number): void {
    accepted.set(keyOf(orderUuid, variantId), weightKg);
}

/**
 * Forget the weight remembered for one item, because the line carrying it is gone.
 *
 * Without this, voiding a mis-weighed line is a dead end. The repeat-weight rule refuses the same
 * weight twice for an (order, item), and the documented way out of a wrong weighing is "void the
 * line and weigh again" — but putting the same block of cheese back on the pan produces the same
 * reading, which the rule then refuses. The cashier is left with no way to re-add the item, and
 * since `setQuantity` now also refuses the numpad on a weighed line, there is no fallback at all.
 *
 * Releasing on delete keeps the rule doing its actual job — catching a *second* item weighed
 * without clearing the pan — while leaving the escape hatch open.
 */
export function releaseWeighing(orderUuid: string, variantId: number): void {
    accepted.delete(keyOf(orderUuid, variantId));
}

/**
 * Drop everything remembered for one order.
 *
 * Called when an order is validated, cancelled or discarded. Without it the map is a leak on a
 * device that stays open for a fortnight, and — worse than the memory — a table reopened under a
 * recycled uuid would inherit a stranger's weighings.
 */
export function forgetWeighings(orderUuid: string): void {
    for (const key of [...accepted.keys()]) {
        if (key.startsWith(`${orderUuid}|`)) accepted.delete(key);
    }
}

/** Test seam, and the hard-reset path. */
export function resetWeighings(): void {
    accepted.clear();
}
