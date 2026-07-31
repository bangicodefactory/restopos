import { parseBarcodeWithFallback, type ParsedBarcode } from '@domain/barcode/index';
import { Decimal } from '@domain/money/decimal';
import type { ProductVariantRow } from '@domain/types';

import { getCatalog, type CatalogIndex } from '../data/catalog';

/**
 * HID keyboard-wedge capture (REG-080) and barcode routing (REG-083 … REG-087).
 *
 * A wedge scanner is a keyboard that types thirteen characters in fifteen milliseconds and presses
 * Enter. Detection is therefore **timing-based**: keystrokes arriving closer together than
 * `maxIntervalMs` are a scan, anything slower is a human. Get this wrong and scanning while a line
 * is selected turns a quantity into 5 901 234 123 457 — which is exactly why `@shared/ui`'s numpad
 * holds each digit for a scanner guard interval before committing it.
 *
 * Parsing itself is `@domain/barcode`: nomenclature rules, embedded weight/price/discount, GS1
 * composites, UPC↔EAN conversion and the zero-padded GTIN fallback all live there.
 */

export type ScannerOptions = {
    onScan: (code: string) => void;
    /** Keystrokes closer than this are a scan (Odoo's `maxTimeBetweenKeysInMs`). */
    maxIntervalMs?: number;
    minLength?: number;
    /** Ignore key events while the cashier is typing in a text field. */
    isTypingTarget?: (target: EventTarget | null) => boolean;
};

function defaultIsTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    // A search box is the one input a scan is *meant* to fill.
    return (target as HTMLInputElement).dataset['scannerPassthrough'] !== 'true';
}

/**
 * Attach the wedge listener. Returns the detach function.
 *
 * The buffer is flushed on Enter/Tab, and also on the interval timeout so a scanner configured
 * without a suffix still works — a surprising number of them are.
 */
export function attachScanner(options: ScannerOptions): () => void {
    const maxInterval = options.maxIntervalMs ?? 30;
    const minLength = options.minLength ?? 3;
    const isTyping = options.isTypingTarget ?? defaultIsTypingTarget;

    let buffer = '';
    let lastAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = (): void => {
        const code = buffer;
        buffer = '';
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        if (code.length >= minLength) options.onScan(code);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;

        const now = Date.now();
        const fast = now - lastAt <= maxInterval;
        lastAt = now;

        if (event.key === 'Enter' || event.key === 'Tab') {
            if (buffer.length >= minLength) {
                event.preventDefault();
                flush();
            }
            return;
        }

        if (event.key.length !== 1) return;
        if (!fast && buffer.length > 0) buffer = '';
        if (isTyping(event.target) && buffer.length === 0 && !fast) return;

        buffer += event.key;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(flush, maxInterval * 4);
    };

    globalThis.addEventListener?.('keydown', onKeyDown, true);
    return () => {
        if (timer !== null) clearTimeout(timer);
        globalThis.removeEventListener?.('keydown', onKeyDown, true);
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing
// ─────────────────────────────────────────────────────────────────────────────

export type ScanAction =
    | { kind: 'product'; variant: ProductVariantRow; quantity: number; parsed: ParsedBarcode }
    | { kind: 'weighed'; variant: ProductVariantRow; quantity: number; parsed: ParsedBarcode }
    | { kind: 'priced'; variant: ProductVariantRow; price: string; parsed: ParsedBarcode }
    | { kind: 'discount'; percent: string; parsed: ParsedBarcode }
    | { kind: 'customer'; code: string; parsed: ParsedBarcode }
    | { kind: 'cashier'; code: string; parsed: ParsedBarcode }
    | { kind: 'unknown'; code: string; parsed: ParsedBarcode | null };

function lookupVariant(catalog: CatalogIndex, parsed: ParsedBarcode): ProductVariantRow | null {
    for (const candidate of [parsed.code, ...parsed.candidates]) {
        const hit = catalog.barcodeIndex.get(candidate);
        if (hit) return hit;
    }
    return null;
}

/**
 * Decide what a scan means. Pure — the caller performs the side effect, which keeps this testable
 * and keeps "what does this barcode mean" separate from "what do we do about it".
 */
export function routeScan(raw: string, catalog: CatalogIndex = getCatalog()): ScanAction {
    const nomenclature = catalog.nomenclature;
    if (!nomenclature) {
        const variant = catalog.barcodeIndex.get(raw.trim());
        return variant
            ? { kind: 'product', variant, quantity: 1, parsed: syntheticParse(raw) }
            : { kind: 'unknown', code: raw, parsed: null };
    }

    const parsed = parseBarcodeWithFallback(raw, nomenclature, catalog.fallbackNomenclature);

    switch (parsed.kind) {
        case 'weight': {
            const variant = lookupVariant(catalog, parsed);
            return variant
                ? { kind: 'weighed', variant, quantity: parsed.value, parsed }
                : { kind: 'unknown', code: parsed.code, parsed };
        }
        case 'price': {
            const variant = lookupVariant(catalog, parsed);
            return variant
                ? { kind: 'priced', variant, price: Decimal.of(String(parsed.value)).withScale(2).toString(), parsed }
                : { kind: 'unknown', code: parsed.code, parsed };
        }
        case 'discount':
            return { kind: 'discount', percent: String(parsed.value), parsed };
        case 'customer':
            return { kind: 'customer', code: parsed.code, parsed };
        case 'cashier':
            return { kind: 'cashier', code: parsed.code, parsed };
        case 'gs1': {
            const variant = lookupVariant(catalog, parsed);
            if (!variant) return { kind: 'unknown', code: parsed.code, parsed };
            const quantity = parsed.gs1?.weightKg ?? parsed.gs1?.quantity ?? 1;
            return { kind: 'product', variant, quantity: quantity || 1, parsed };
        }
        case 'product':
        case 'alias':
        default: {
            const variant = lookupVariant(catalog, parsed);
            return variant
                ? { kind: 'product', variant, quantity: 1, parsed }
                : { kind: 'unknown', code: parsed.code, parsed };
        }
    }
}

function syntheticParse(raw: string): ParsedBarcode {
    return { kind: 'product', code: raw.trim(), raw, value: 0, ruleId: null, gs1: null, candidates: [raw.trim()] };
}
