import { Decimal } from './decimal';

/**
 * Client-side decimal precision — the `decimal_precisions` table (spec 01 §2.C, REG-177).
 *
 * Odoo keeps a `decimal.precision` row per domain and expresses every client-side rounding and
 * zero test in terms of the matching number of digits. This module is the arithmetic half; the
 * register reads the digits out of the replica and passes them in.
 *
 * The names are data, not an enum — a site that renames a precision row falls back to the caller's
 * default rather than crashing. Only the ones something actually reads live here; add a constant
 * when a call site needs it, not before.
 */
export const PRECISION_PRODUCT_UOM = 'Product Unit of Measure';

/** Seed default for `Product Unit of Measure`, used when the replica has no row for it. */
export const DEFAULT_QUANTITY_DIGITS = 3;

/**
 * `decimal_precisions.digits` is an `unsignedTinyInteger`, so the replica can hand us 0…255, and
 * `Decimal` scales past this are a memory problem rather than a precision one. Clamp rather than
 * throw: a nonsense precision row must not take the register down mid-sale.
 */
export const MAX_PRECISION_DIGITS = 12;

export function clampDigits(digits: number, fallback: number): number {
    if (!Number.isFinite(digits)) return fallback;
    return Math.min(MAX_PRECISION_DIGITS, Math.max(0, Math.trunc(digits)));
}

/** One unit in the last place at `digits` decimals — `3 → 0.001`, `0 → 1`. */
export function stepForDigits(digits: number): Decimal {
    return Decimal.make(false, 1n, clampDigits(digits, DEFAULT_QUANTITY_DIGITS));
}

/** Half a unit in the last place — the widest deviation that still rounds back to the value. */
export function epsilonForDigits(digits: number): Decimal {
    return Decimal.make(false, 5n, clampDigits(digits, DEFAULT_QUANTITY_DIGITS) + 1);
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
