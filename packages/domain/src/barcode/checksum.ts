/**
 * GTIN check digits. Every function here takes the code *without* assuming a check digit is
 * present and is total: never throws, returns `null` for input it cannot judge.
 */

/** Modulo-10 weighted sum used by EAN-8, EAN-13, UPC-A and GTIN-14. */
export function gtinCheckDigit(digitsWithoutCheck: string): number | null {
    if (!/^\d+$/.test(digitsWithoutCheck)) return null;
    let sum = 0;
    // Weights alternate 3,1,… counting from the rightmost digit of the body.
    for (let i = digitsWithoutCheck.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
        sum += Number(digitsWithoutCheck[i]) * weight;
    }
    return (10 - (sum % 10)) % 10;
}

export function isValidGtin(code: string, length: 8 | 12 | 13 | 14): boolean {
    if (code.length !== length || !/^\d+$/.test(code)) return false;
    return gtinCheckDigit(code.slice(0, -1)) === Number(code[code.length - 1]);
}

export const isValidEan13 = (code: string): boolean => isValidGtin(code, 13);
export const isValidEan8 = (code: string): boolean => isValidGtin(code, 8);
export const isValidUpcA = (code: string): boolean => isValidGtin(code, 12);

/** Append (or fix) the check digit — used when we synthesise a barcode from a weight/price rule. */
export function withCheckDigit(body: string): string {
    const check = gtinCheckDigit(body);
    return check === null ? body : body + String(check);
}

/** UPC-A (12) → EAN-13 (13) by zero-prefixing. */
export function upcToEan(code: string): string {
    return code.length === 12 ? '0' + code : code;
}

/** EAN-13 (13, leading zero) → UPC-A (12). */
export function eanToUpc(code: string): string {
    return code.length === 13 && code.startsWith('0') ? code.slice(1) : code;
}

/**
 * Strip the zero padding some scanners add to short codes (Odoo's "padded GTIN zero-strip"
 * fallback): `0000000012345` and `12345` must find the same product.
 */
export function stripGtinPadding(code: string): string {
    if (!/^\d+$/.test(code)) return code;
    const stripped = code.replace(/^0+/, '');
    return stripped === '' ? '0' : stripped;
}
