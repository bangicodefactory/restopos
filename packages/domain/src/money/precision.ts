import { Decimal } from './decimal';
import { HALF_UP, type RoundingMode } from './rounding';

/**
 * Client-side decimal precision — the `decimal_precisions` table (spec 01 §2.C, REG-177).
 *
 * Odoo keeps a `decimal.precision` row per domain (`Product Price`, `Product Unit of Measure`,
 * `Discount`, …) and every client-side rounding and zero test is expressed in terms of the
 * matching number of digits. This module is the arithmetic half of that; the register reads the
 * digits out of the replica and passes them in.
 *
 * The names are the seeded ones — they are data, not an enum, so a site that renames a precision
 * row falls back to the caller's default rather than crashing.
 */
export const PRECISION_PRODUCT_PRICE = 'Product Price';
export const PRECISION_PRODUCT_UOM = 'Product Unit of Measure';
export const PRECISION_DISCOUNT = 'Discount';
export const PRECISION_PAYMENT_TERMINAL = 'Payment Terminal';

/** Seed defaults, used when the replica has no row for the domain. */
export const DEFAULT_PRICE_DIGITS = 4;
export const DEFAULT_QUANTITY_DIGITS = 3;
export const DEFAULT_MONEY_DIGITS = 2;

function assertDigits(digits: number): void {
    if (!Number.isInteger(digits) || digits < 0 || digits > 12) {
        throw new Error(`invalid decimal precision ${digits}`);
    }
}

/** One unit in the last place at `digits` decimals — `3 → 0.001`, `0 → 1`. */
export function stepForDigits(digits: number): Decimal {
    assertDigits(digits);
    return Decimal.make(false, 1n, digits);
}

/** Half a unit in the last place — the widest deviation that still rounds back to the value. */
export function epsilonForDigits(digits: number): Decimal {
    assertDigits(digits);
    return Decimal.make(false, 5n, digits + 1);
}

/** Round to `digits` decimal places. */
export function roundToPrecision(
    value: string | Decimal,
    digits: number,
    mode: RoundingMode = HALF_UP,
): Decimal {
    assertDigits(digits);
    return Decimal.of(value).withScale(digits, mode);
}

/**
 * A zero test that knows what "zero" means at a given precision (REG-177).
 *
 * `Decimal.isZero()` asks whether the value is *exactly* zero, which is the right question about a
 * literal and the wrong one about the tail of a division: a residue of 0.0000001 on a 2-decimal
 * money value is zero for every purpose the register has. Anything that would round back to 0.00 at
 * `digits` places counts as zero here.
 */
export function isZeroAtPrecision(value: string | Decimal, digits: number): boolean {
    return Decimal.of(value).abs().lt(epsilonForDigits(digits));
}

/** `a` and `b` are indistinguishable once rounded to `digits` places. */
export function equalsAtPrecision(
    a: string | Decimal,
    b: string | Decimal,
    digits: number,
): boolean {
    return isZeroAtPrecision(Decimal.of(a).sub(b), digits);
}
