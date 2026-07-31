/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildCatalog,
    makeNomenclature,
    makeProduct,
    makeRule,
    makeVariant,
    type CatalogParts,
} from './__fixtures__/catalog';
import { attachScanner, routeScan } from './scanner';

/** Unit coverage for REG-080 (wedge capture) and REG-083 … REG-087 (scan routing). */

// Codes produced by the rules below, with their base code after the embedded field is zeroed.
const PLAIN_EAN = '5901234123457';
const WEIGHT_SCAN = '2100001015003'; // 1.500 kg
const WEIGHT_BASE = '2100001000004';
const PRICE_SCAN = '2312345067890'; // 67.89 €
const PRICE_BASE = '2312345000002';

const rules = [
    makeRule({ id: 1, rule_type: 'weight', pattern: '21.....{NNDDD}', encoding: 'ean13', sequence: 1 }),
    makeRule({ id: 2, rule_type: 'price', pattern: '23.....{NNNDD}', encoding: 'ean13', sequence: 2 }),
    makeRule({ id: 3, rule_type: 'discount', pattern: '22{NN}', sequence: 3 }),
    makeRule({ id: 4, rule_type: 'customer', pattern: '041', sequence: 4 }),
    makeRule({ id: 5, rule_type: 'cashier', pattern: '042', sequence: 5 }),
    makeRule({ id: 6, rule_type: 'alias', pattern: '999', alias: PLAIN_EAN, sequence: 8 }),
    makeRule({ id: 7, rule_type: 'product', pattern: '.*', sequence: 100 }),
];

/** Fallback nomenclature: only knows the legacy `CUST` loyalty card prefix. */
const FALLBACK_ROW = { id: 2, name: 'Legacy', upc_ean_conv: 'none', is_gs1: false } as const;
const fallbackRules = [
    makeRule({ id: 20, barcode_nomenclature_id: 2, rule_type: 'customer', pattern: 'CUST', sequence: 1 }),
];

/** Primary nomenclature that deliberately matches nothing but EAN-13, so the fallback gets a turn. */
const strictRules = [makeRule({ id: 30, rule_type: 'product', pattern: '.*', encoding: 'ean13', sequence: 1 })];

function catalogWith(parts: CatalogParts = {}) {
    return buildCatalog({
        products: [
            makeProduct({ id: 1, name: 'Pizza' }),
            makeProduct({ id: 2, name: 'Jambon' }),
            makeProduct({ id: 3, name: 'Vin' }),
        ],
        variants: [
            makeVariant({ id: 11, product_id: 1, display_name: 'Pizza', barcode: PLAIN_EAN }),
            makeVariant({ id: 12, product_id: 2, display_name: 'Jambon', barcode: WEIGHT_BASE }),
            makeVariant({ id: 13, product_id: 3, display_name: 'Vin', barcode: PRICE_BASE }),
        ],
        nomenclature: makeNomenclature(rules),
        ...parts,
    });
}

describe('routeScan with a nomenclature', () => {
    const catalog = catalogWith();

    it('routes a plain product barcode', () => {
        const action = routeScan(PLAIN_EAN, catalog);
        expect(action.kind).toBe('product');
        expect(action.kind === 'product' && action.variant.id).toBe(11);
        expect(action.kind === 'product' && action.quantity).toBe(1);
    });

    it('routes a weight-embedded label to the base product with the embedded quantity', () => {
        const action = routeScan(WEIGHT_SCAN, catalog);
        expect(action.kind).toBe('weighed');
        expect(action.kind === 'weighed' && action.variant.id).toBe(12);
        expect(action.kind === 'weighed' && action.quantity).toBe(1.5);
    });

    it('routes a price-embedded label to the base product with a 2-decimal price string', () => {
        const action = routeScan(PRICE_SCAN, catalog);
        expect(action.kind).toBe('priced');
        expect(action.kind === 'priced' && action.variant.id).toBe(13);
        expect(action.kind === 'priced' && action.price).toBe('67.89');
    });

    it('routes a discount label without touching the catalog', () => {
        const action = routeScan('2215', catalog);
        expect(action.kind).toBe('discount');
        expect(action.kind === 'discount' && action.percent).toBe('15');
    });

    it.each([
        { raw: '0410001', kind: 'customer' },
        { raw: '0420002', kind: 'cashier' },
    ])('routes $raw as $kind', ({ raw, kind }) => {
        const action = routeScan(raw, catalog);
        expect(action.kind).toBe(kind);
        expect(action.kind === 'customer' || action.kind === 'cashier' ? action.code : null).toBe(raw);
    });

    it('resolves an alias rule to the aliased product', () => {
        const action = routeScan('9990001', catalog);
        expect(action.kind).toBe('product');
        expect(action.kind === 'product' && action.variant.id).toBe(11);
        expect(action.parsed?.ruleId).toBe(6);
    });

    it('reports an unknown product barcode as unknown, keeping the parse for the caller', () => {
        const action = routeScan('4006381333931', catalog);
        expect(action.kind).toBe('unknown');
        expect(action.parsed).not.toBeNull();
    });

    it('reports a weight label for an unknown base product as unknown, not as a 0-price line', () => {
        const catalogWithoutHam = catalogWith({
            variants: [makeVariant({ id: 11, product_id: 1, display_name: 'Pizza', barcode: PLAIN_EAN })],
        });
        expect(routeScan(WEIGHT_SCAN, catalogWithoutHam).kind).toBe('unknown');
    });

    it('trims the scanned string', () => {
        expect(routeScan(`  ${PLAIN_EAN}  `, catalog).kind).toBe('product');
    });
});

describe('routeScan without a nomenclature', () => {
    const catalog = catalogWith({ nomenclature: null });

    it('falls back to a raw barcode lookup', () => {
        const action = routeScan(` ${PLAIN_EAN} `, catalog);
        expect(action.kind).toBe('product');
        expect(action.kind === 'product' && action.variant.id).toBe(11);
        expect(action.parsed?.candidates).toEqual([PLAIN_EAN]);
    });

    it('returns unknown with no parse at all when nothing matches', () => {
        const action = routeScan('nope', catalog);
        expect(action).toEqual({ kind: 'unknown', code: 'nope', parsed: null });
    });

    it('does not decode embedded weight without a nomenclature', () => {
        // The weight label is not a catalog barcode, so there is nothing to route it to.
        expect(routeScan(WEIGHT_SCAN, catalog).kind).toBe('unknown');
    });
});

describe('routeScan through the fallback nomenclature', () => {
    const catalog = catalogWith({
        nomenclature: makeNomenclature(strictRules),
        fallbackNomenclature: makeNomenclature(fallbackRules, FALLBACK_ROW),
    });

    it('uses the fallback when the primary matches no rule', () => {
        const action = routeScan('CUST-4711', catalog);
        expect(action.kind).toBe('customer');
        expect(action.kind === 'customer' && action.code).toBe('CUST-4711');
    });

    it('keeps the primary result when the primary already matched', () => {
        const action = routeScan(PLAIN_EAN, catalog);
        expect(action.kind).toBe('product');
        expect(action.parsed?.ruleId).toBe(30);
    });

    it('still reports unknown when neither nomenclature matches', () => {
        expect(routeScan('zzz', catalog).kind).toBe('unknown');
    });
});

describe('attachScanner (HID wedge capture)', () => {
    let detach: (() => void) | null = null;

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        detach?.();
        detach = null;
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    function type(keys: string, options: { gapMs?: number; target?: EventTarget } = {}): void {
        for (const key of keys) {
            if (options.gapMs) vi.advanceTimersByTime(options.gapMs);
            const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
            (options.target ?? document.body).dispatchEvent(event);
        }
    }

    it('captures a burst terminated by Enter', () => {
        const onScan = vi.fn();
        detach = attachScanner({ onScan });

        type(PLAIN_EAN);
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

        expect(onScan).toHaveBeenCalledExactlyOnceWith(PLAIN_EAN);
    });

    it('flushes on the interval timeout for scanners configured without a suffix', () => {
        const onScan = vi.fn();
        detach = attachScanner({ onScan, maxIntervalMs: 30 });

        type(PLAIN_EAN);
        expect(onScan).not.toHaveBeenCalled();

        vi.advanceTimersByTime(120);
        expect(onScan).toHaveBeenCalledExactlyOnceWith(PLAIN_EAN);
    });

    it('ignores a human typing at human speed', () => {
        const onScan = vi.fn();
        detach = attachScanner({ onScan });

        type('abcdef', { gapMs: 100 });
        vi.advanceTimersByTime(500);

        expect(onScan).not.toHaveBeenCalled();
    });

    it('ignores a burst that is shorter than minLength', () => {
        const onScan = vi.fn();
        detach = attachScanner({ onScan, minLength: 5 });

        type('12');
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        vi.advanceTimersByTime(500);

        expect(onScan).not.toHaveBeenCalled();
    });

    it('ignores modified keystrokes (Ctrl+A is not a scan)', () => {
        const onScan = vi.fn();
        detach = attachScanner({ onScan });

        for (const key of 'abc') {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }));
        }
        vi.advanceTimersByTime(500);

        expect(onScan).not.toHaveBeenCalled();
    });

    it('leaves a cashier typing in a text field alone', () => {
        const onScan = vi.fn();
        const input = document.createElement('input');
        document.body.append(input);
        detach = attachScanner({ onScan });

        type('pizza', { gapMs: 120, target: input });
        vi.advanceTimersByTime(500);

        expect(onScan).not.toHaveBeenCalled();
    });

    it('stops listening once detached', () => {
        const onScan = vi.fn();
        const stop = attachScanner({ onScan });
        stop();

        type(PLAIN_EAN);
        vi.advanceTimersByTime(500);

        expect(onScan).not.toHaveBeenCalled();
    });
});
