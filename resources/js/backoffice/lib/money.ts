/**
 * Money for the back-office.
 *
 * The rule from docs/CONVENTIONS.md, restated because it is the one that breaks ledgers:
 * **a monetary value coming from the server is a decimal string and must never be turned into a
 * JS number.** `Number("24.2000").toFixed(2)` is right until it is not, and the first time it is
 * not, a Z-report disagrees with the drawer by a cent and nobody can explain why.
 *
 * So every amount rendered by this app goes through `money()`, which parses with
 * `@domain/money`'s arbitrary-precision `Decimal` and formats with `@domain/receipt`'s
 * `formatMoney` — the same formatter the printed receipt uses, so the screen and the paper
 * always agree.
 *
 * **Contract gap (reported, not worked around):** spec 05 §12 gives the back-office a
 * `currency_id` on registers, pricelists and payment methods but never the currency *record*
 * (symbol, decimal places, separators). Until a `currencies` payload is shared, this module
 * resolves ids through a small registry seeded with the venue default below.
 */

import { Decimal } from '@domain/money/decimal';
import { formatMoney, formatPercent, type CurrencyFormat } from '@domain/receipt/index';

/** The venue default. French formatting: "1 234,50 €". */
export const EUR: CurrencyFormat = {
    symbol: '€',
    position: 'after',
    decimalPlaces: 2,
    decimalSeparator: ',',
    thousandsSeparator: ' ',
};

const REGISTRY = new Map<number, CurrencyFormat>();

/** Register a currency once it is known (e.g. from a future `currencies` prop). */
export function registerCurrency(id: number, format: CurrencyFormat): void {
    REGISTRY.set(id, format);
}

export function currencyFor(id: number | null | undefined): CurrencyFormat {
    if (id === null || id === undefined) return EUR;
    return REGISTRY.get(id) ?? EUR;
}

/**
 * Tolerant parse. Server aggregates arrive as strings on Postgres and as numbers on SQLite,
 * and a deferred prop can be `undefined` for a frame; none of those may throw mid-render.
 */
export function toDecimal(value: string | number | null | undefined): Decimal {
    if (value === null || value === undefined) return Decimal.of('0');
    const text = typeof value === 'number' ? numberToPlainString(value) : value.trim();
    if (text === '' || text === '-') return Decimal.of('0');
    try {
        return Decimal.of(text);
    } catch {
        return Decimal.of('0');
    }
}

/**
 * `String(1e-7)` is `"1e-7"`, which `Decimal.of` rightly refuses. Aggregates never reach that
 * magnitude in practice, but a formatter that throws on a report page is not acceptable, so the
 * exponent form is expanded here rather than guarded at forty call sites.
 */
function numberToPlainString(value: number): string {
    if (!Number.isFinite(value)) return '0';
    if (!/e/i.test(String(value))) return String(value);
    // 20 is the maximum `toFixed` accepts; this path only exists for pathological inputs.
    return value.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

/** The formatter every amount on screen goes through. */
export function money(
    value: string | number | null | undefined,
    currency: CurrencyFormat = EUR,
    withSymbol = true,
): string {
    return formatMoney(toDecimal(value).toString(), currency, withSymbol);
}

/** Sum decimal strings without ever touching a float. */
export function sumMoney(values: readonly (string | number | null | undefined)[]): string {
    let total = Decimal.of('0');
    for (const value of values) total = total.add(toDecimal(value));
    return total.toString();
}

/** `a - b` as a decimal string. */
export function subtractMoney(
    a: string | number | null | undefined,
    b: string | number | null | undefined,
): string {
    return toDecimal(a).sub(toDecimal(b)).toString();
}

/** Sign of an amount: -1, 0 or 1. Used to colour variances. */
export function signOf(value: string | number | null | undefined): number {
    return toDecimal(value).signum();
}

/** `part / whole` as a 0–100 percentage number, safe for chart geometry only. */
export function ratio(
    part: string | number | null | undefined,
    whole: string | number | null | undefined,
): number {
    const total = toDecimal(whole);
    if (total.isZero()) return 0;
    return Number(toDecimal(part).mul('100').div(total, 6).toString());
}

/**
 * Quantities are decimal(16,3) strings. They are not money — they may become numbers for
 * layout — but they are still displayed through a formatter so "2.000" reads as "2".
 */
export function quantity(value: string | number | null | undefined, maxDecimals = 3): string {
    const text = toDecimal(value).withScale(maxDecimals).toString();
    if (!text.includes('.')) return text;
    return text.replace(/0+$/, '').replace(/\.$/, '');
}

/** "12.5000" → "12,5 %". */
export function percent(value: string | number | null | undefined, decimals = 2): string {
    const text = toDecimal(value).withScale(decimals).toString();
    return formatPercent(text).replace('.', ',').replace('%', ' %');
}

export type { CurrencyFormat };
