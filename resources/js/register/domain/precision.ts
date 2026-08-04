import { Decimal, ZERO } from '@domain/money/decimal';
import {
    DEFAULT_QUANTITY_DIGITS,
    MAX_PRECISION_DIGITS,
    PRECISION_PRODUCT_UOM,
    clampDigits,
    isZeroAtPrecision,
} from '@domain/money/precision';
import { HALF_UP } from '@domain/money/rounding';

import { getCatalog, precisionDigits, type CatalogIndex } from '../data/catalog';

/**
 * Precision the register actually applies — REG-177.
 *
 * Two sources, and they answer different questions:
 *
 *  - the **UoM's `rounding`** is a *step*. A unit sold by the half-kilo has `rounding` 0.5, and a
 *    quantity of 0.001 on that line is not "0.001 kg", it is a typo the scale or the numpad let
 *    through. Snapping to the step is what makes it representable.
 *  - `decimal_precisions` gives the number of **digits** to keep afterwards, so a quantity never
 *    grows a tail of its own through the combo-child ratio multiplication.
 *
 * Both used to be one hardcoded `Math.round(q * 1000) / 1000`, which silently accepted a
 * milligram on a product sold by the half-kilo.
 */

/**
 * Working scale for the `number` ⇄ `Decimal` hop. Held at the digit ceiling rather than something
 * smaller so the hop itself never becomes the binding constraint on a configured precision.
 */
const WORKING_DIGITS = MAX_PRECISION_DIGITS;

/** `number` → `Decimal` without ever handing `Decimal.of` an exponential literal. */
function toDecimal(value: number): Decimal {
    if (!Number.isFinite(value)) return ZERO;
    // toFixed switches to exponent notation only at |v| >= 1e21; a quantity never gets there.
    return Decimal.of(value.toFixed(WORKING_DIGITS));
}

function quantityDigits(catalog: CatalogIndex): number {
    return clampDigits(
        precisionDigits(catalog, PRECISION_PRODUCT_UOM, DEFAULT_QUANTITY_DIGITS),
        DEFAULT_QUANTITY_DIGITS,
    );
}

/** The UoM's rounding step, or `null` when the unit is unknown or unstepped. */
function quantityStepOf(uomId: number | null, catalog: CatalogIndex): Decimal | null {
    if (uomId === null) return null;
    const rounding = catalog.uoms.get(uomId)?.rounding;
    if (rounding === undefined) return null;
    const step = Decimal.of(rounding).abs();
    return step.isZero() ? null : step;
}

/**
 * Round a quantity to what its unit of measure can express (REG-177).
 *
 * Snap to the UoM step first, then cap at the configured digits — in that order, because the step
 * is the physical constraint and the digit count only trims what the arithmetic added.
 */
export function roundQuantity(
    quantity: number,
    uomId: number | null,
    catalog: CatalogIndex = getCatalog(),
): number {
    const step = quantityStepOf(uomId, catalog);
    const value = toDecimal(quantity);
    const snapped = step === null ? value : value.roundToStep(step, HALF_UP);
    return Number(snapped.withScale(quantityDigits(catalog), HALF_UP).toString());
}

/**
 * Trim a quantity to the configured digits **without** snapping to the UoM step.
 *
 * For quantities that are a difference between two already-snapped values. Snapping a difference
 * is wrong: the compensating line in `reduceQuantity` has to satisfy `sent + delta = requested`
 * exactly, and re-snapping `delta` breaks that identity whenever `sent` is itself off-grid — which
 * it can be, since it comes from a prep snapshot written before this rule existed.
 */
export function trimQuantity(quantity: number, catalog: CatalogIndex = getCatalog()): number {
    return Number(toDecimal(quantity).withScale(quantityDigits(catalog), HALF_UP).toString());
}

/**
 * Is this quantity nothing? (REG-177)
 *
 * Guards the "the line has been reduced to nothing, drop it" decisions. `=== 0` is an exact float
 * test, and a quantity that arrived through a ratio multiplication can land on 1e-16 instead of 0 —
 * which leaves a ghost line on the order carrying a quantity too small to render.
 */
export function isZeroQuantity(quantity: number, catalog: CatalogIndex = getCatalog()): boolean {
    if (!Number.isFinite(quantity)) return true;
    return isZeroAtPrecision(toDecimal(quantity), quantityDigits(catalog));
}
