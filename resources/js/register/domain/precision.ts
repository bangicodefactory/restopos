import { Decimal, ZERO } from '@domain/money/decimal';
import {
    DEFAULT_MONEY_DIGITS,
    DEFAULT_QUANTITY_DIGITS,
    PRECISION_PRODUCT_UOM,
    epsilonForDigits,
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

/** Working scale for the number ⇄ Decimal hop. Wide enough that a ratio's tail survives it. */
const WORKING_DIGITS = 6;

/** `number` → `Decimal` without ever handing `Decimal.of` an exponential literal. */
function toDecimal(value: number): Decimal {
    if (!Number.isFinite(value)) return ZERO;
    // toFixed switches to exponent notation only at |v| >= 1e21; a quantity never gets there.
    return Decimal.of(value.toFixed(WORKING_DIGITS));
}

export function quantityDigits(catalog: CatalogIndex = getCatalog()): number {
    return precisionDigits(catalog, PRECISION_PRODUCT_UOM, DEFAULT_QUANTITY_DIGITS);
}

/** The UoM's rounding step, or `null` when the unit is unknown or unstepped. */
export function quantityStepOf(uomId: number | null, catalog: CatalogIndex = getCatalog()): Decimal | null {
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
    const value = toDecimal(quantity);
    const step = quantityStepOf(uomId, catalog);
    const snapped = step === null ? value : value.roundToStep(step, HALF_UP);
    return Number(snapped.withScale(quantityDigits(catalog), HALF_UP).toString());
}

/**
 * The epsilon a money value is compared against instead of exact zero (REG-177).
 *
 * Driven by the currency's decimal places, falling back to the seeded 2.
 */
export function moneyEpsilon(catalog: CatalogIndex = getCatalog()): Decimal {
    return epsilonForDigits(catalog.currency?.decimal_places ?? DEFAULT_MONEY_DIGITS);
}

/** Precision-aware "is this amount nothing?" for money. */
export function isZeroMoney(value: string | Decimal, catalog: CatalogIndex = getCatalog()): boolean {
    return isZeroAtPrecision(value, catalog.currency?.decimal_places ?? DEFAULT_MONEY_DIGITS);
}
