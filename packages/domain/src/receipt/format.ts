import { Decimal } from '../money/decimal';
import type { Money } from '../types';
import type { CurrencyFormat } from './types';

/**
 * Presentation-only formatting. Never used as an input to arithmetic — every value that reaches
 * here has already been rounded by the tax engine.
 */

/** "1234.5" → "1 234,50 €" */
export function formatMoney(amount: Money | Decimal, currency: CurrencyFormat, withSymbol = true): string {
    const value = Decimal.of(typeof amount === 'string' ? amount : amount.toString()).withScale(
        currency.decimalPlaces,
    );
    const raw = value.toString();
    const negative = raw.startsWith('-');
    const unsigned = negative ? raw.slice(1) : raw;
    const dot = unsigned.indexOf('.');
    const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
    const fracPart = dot === -1 ? '' : unsigned.slice(dot + 1);

    let grouped = '';
    for (let i = 0; i < intPart.length; i++) {
        const fromEnd = intPart.length - i;
        grouped += intPart[i];
        if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) grouped += currency.thousandsSeparator;
    }

    const number = fracPart ? `${grouped}${currency.decimalSeparator}${fracPart}` : grouped;
    const signed = (negative ? '-' : '') + number;

    if (!withSymbol || currency.symbol === '') return signed;
    return currency.position === 'before' ? `${currency.symbol}${signed}` : `${signed} ${currency.symbol}`;
}

/** Quantities print without trailing zeros: 1, 1.5, 0.325. */
export function formatQuantity(qty: number, maxDecimals = 3): string {
    if (Number.isInteger(qty)) return String(qty);
    return qty
        .toFixed(maxDecimals)
        .replace(/0+$/, '')
        .replace(/\.$/, '');
}

/** "12.5" → "12.5%" with the trailing zeros stripped. */
export function formatPercent(value: string): string {
    const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
    return `${trimmed}%`;
}

/**
 * Local date/time for the receipt header.
 *
 * Deliberately hand-rolled rather than `Intl`: receipts must render identically on the till, on the
 * server (Node, possibly a different ICU build) and in a snapshot test.
 */
export function formatDateTime(iso: string, opts?: { date?: boolean; time?: boolean }): string {
    const showDate = opts?.date ?? true;
    const showTime = opts?.time ?? true;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n: number, w = 2): string => String(n).padStart(w, '0');
    const date = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
    const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
    if (showDate && showTime) return `${date} ${time}`;
    return showDate ? date : time;
}
