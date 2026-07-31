/**
 * Nomenclature pattern matching.
 *
 * Syntax (identical to Odoo's `barcode.rule.pattern`, which is what the printed shelf labels in
 * every European supermarket already speak):
 *
 *   `21`          literal digits, matched as-is
 *   `.`           any single character
 *   `{NNDDD}`     an embedded numeric field: `N` integer digits, `D` decimal digits
 *   anything else literal
 *
 * Example: `21.....{NNDDD}` on `2100001` + `01500` + check digit means "product prefix 21, five
 * free digits of product code, then 2 integer + 3 decimal digits of weight" → 1.500 kg.
 *
 * `baseCode` is the barcode with the embedded field zeroed out and the check digit recomputed —
 * that is the code we actually look the product up by, because the printed label's check digit
 * covers the *weight*, not the product.
 */

export type PatternMatch = {
    matched: boolean;
    /** The embedded numeric value (weight / price / discount), 0 when the pattern has no field. */
    value: number;
    /** The barcode with the embedded field replaced by zeros, check digit recomputed. */
    baseCode: string;
};

const FIELD_RE = /\{(N*)(D*)\}/;

/** Translate a nomenclature pattern into an anchored regular expression. */
export function patternToRegExp(pattern: string): RegExp {
    let source = '^';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i] as string;
        if (ch === '{') {
            const close = pattern.indexOf('}', i);
            if (close === -1) {
                source += '\\{';
                continue;
            }
            const field = pattern.slice(i + 1, close);
            source += `\\d{${field.length}}`;
            i = close;
            continue;
        }
        if (ch === '.') {
            source += '.';
            continue;
        }
        if (ch === '*') {
            source += '.*';
            continue;
        }
        source += ch.replace(/[\\^$+?()[\]|]/g, '\\$&');
    }
    return new RegExp(source);
}

/**
 * Match `barcode` against `pattern` and extract the embedded value.
 *
 * `recomputeCheckDigit` is supplied by the caller (checksum.ts) so this module stays pure string
 * work and the two can be tested independently.
 */
export function matchPattern(
    barcode: string,
    pattern: string,
    recomputeCheckDigit?: (body: string) => string,
): PatternMatch {
    const regexp = patternToRegExp(pattern);
    if (!regexp.test(barcode)) return { matched: false, value: 0, baseCode: barcode };

    const field = FIELD_RE.exec(pattern);
    if (!field) return { matched: true, value: 0, baseCode: barcode };

    const start = field.index;
    const intDigits = (field[1] ?? '').length;
    const decDigits = (field[2] ?? '').length;
    const width = intDigits + decDigits;
    const raw = barcode.slice(start, start + width);

    if (raw.length !== width || !/^\d+$/.test(raw)) {
        return { matched: false, value: 0, baseCode: barcode };
    }

    const intPart = raw.slice(0, intDigits);
    const decPart = raw.slice(intDigits);
    const value = Number(intPart || '0') + (decDigits > 0 ? Number(decPart) / 10 ** decDigits : 0);

    let baseCode = barcode.slice(0, start) + '0'.repeat(width) + barcode.slice(start + width);
    if (recomputeCheckDigit && /^\d+$/.test(baseCode) && baseCode.length > 1) {
        baseCode = recomputeCheckDigit(baseCode.slice(0, -1));
    }

    return { matched: true, value, baseCode };
}
