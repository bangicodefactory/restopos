/**
 * Rounding modes — docs/spec/04-tax-engine.md §3.1.
 *
 * Every mode is defined on the magnitude and then signed: there is no CEIL/FLOOR, so a refund
 * rounds as the exact mirror of the sale that produced it (§3.1, §7.3).
 */
export type RoundingMode = 'half_up' | 'half_down' | 'half_even' | 'up' | 'down';

export const HALF_UP: RoundingMode = 'half_up';
export const HALF_DOWN: RoundingMode = 'half_down';
export const HALF_EVEN: RoundingMode = 'half_even';
export const UP: RoundingMode = 'up';
export const DOWN: RoundingMode = 'down';

const MODES: readonly string[] = ['half_up', 'half_down', 'half_even', 'up', 'down'];

export function parseRoundingMode(v: string | null | undefined): RoundingMode {
    if (v === null || v === undefined) {
        return HALF_UP;
    }
    if (!MODES.includes(v)) {
        throw new Error(`unknown rounding mode "${v}"`);
    }
    return v as RoundingMode;
}

/**
 * §3.2 — decide whether the truncated quotient `q` is incremented, given the remainder `r`
 * of the division by `den`. All three arguments are non-negative and `r < den`.
 */
export function applyRounding(q: bigint, r: bigint, den: bigint, mode: RoundingMode): bigint {
    if (r === 0n) {
        return q;
    }
    const twice = 2n * r;
    switch (mode) {
        case 'down':
            return q;
        case 'up':
            return q + 1n;
        case 'half_up':
            return twice >= den ? q + 1n : q;
        case 'half_down':
            return twice > den ? q + 1n : q;
        case 'half_even':
            if (twice > den) return q + 1n;
            if (twice < den) return q;
            return q % 2n === 1n ? q + 1n : q;
        default: {
            const never: never = mode;
            throw new Error(`unknown rounding mode "${String(never)}"`);
        }
    }
}
