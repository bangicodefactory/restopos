import { describe, expect, it } from 'vitest';

import {
    eanToUpc,
    gtinCheckDigit,
    isValidEan13,
    isValidEan8,
    isValidUpcA,
    stripGtinPadding,
    upcToEan,
    withCheckDigit,
} from '../src/barcode/checksum';
import { looksLikeGs1, parseGs1 } from '../src/barcode/gs1';
import { buildNomenclature, parseBarcode, parseBarcodeWithFallback } from '../src/barcode/nomenclature';
import { matchPattern, patternToRegExp } from '../src/barcode/pattern';
import type { BarcodeNomenclatureRow, BarcodeRuleRow } from '../src/types';

/** Unit coverage for docs/spec/03-architecture.md §7.5 and spec 01 §2.B `barcode_rules`. */

const nomenclatureRow: BarcodeNomenclatureRow = {
    id: 1,
    name: 'Default',
    upc_ean_conv: 'always',
    is_gs1: false,
};

let ruleId = 0;
function rule(partial: Partial<BarcodeRuleRow> & Pick<BarcodeRuleRow, 'rule_type' | 'pattern'>): BarcodeRuleRow {
    return {
        id: ++ruleId,
        barcode_nomenclature_id: 1,
        name: partial.rule_type,
        encoding: 'any',
        alias: null,
        sequence: 10,
        ...partial,
    };
}

const rules: BarcodeRuleRow[] = [
    rule({ rule_type: 'weight', pattern: '21.....{NNDDD}', encoding: 'ean13', sequence: 1 }),
    rule({ rule_type: 'price', pattern: '23.....{NNNDD}', encoding: 'ean13', sequence: 2 }),
    rule({ rule_type: 'discount', pattern: '22{NN}', sequence: 3 }),
    rule({ rule_type: 'customer', pattern: '041', sequence: 4 }),
    rule({ rule_type: 'cashier', pattern: '042', sequence: 5 }),
    rule({ rule_type: 'coupon', pattern: '043', sequence: 6 }),
    rule({ rule_type: 'lot', pattern: '10', encoding: 'gs1_128', sequence: 7 }),
    rule({ rule_type: 'alias', pattern: '999', alias: '5901234123457', sequence: 8 }),
    rule({ rule_type: 'product', pattern: '.*', sequence: 100 }),
];

const nomenclature = buildNomenclature(nomenclatureRow, rules);

describe('GTIN check digits', () => {
    it('computes the EAN-13 check digit', () => {
        expect(gtinCheckDigit('590123412345')).toBe(7);
        expect(withCheckDigit('590123412345')).toBe('5901234123457');
    });

    it('validates EAN-13, EAN-8 and UPC-A', () => {
        expect(isValidEan13('5901234123457')).toBe(true);
        expect(isValidEan13('5901234123458')).toBe(false);
        expect(isValidEan8('96385074')).toBe(true);
        expect(isValidUpcA('036000291452')).toBe(true);
    });

    it('converts between UPC-A and EAN-13', () => {
        expect(upcToEan('036000291452')).toBe('0036000291452');
        expect(eanToUpc('0036000291452')).toBe('036000291452');
        expect(eanToUpc('5901234123457')).toBe('5901234123457');
    });

    it('strips scanner zero padding', () => {
        expect(stripGtinPadding('0000000012345')).toBe('12345');
        expect(stripGtinPadding('0')).toBe('0');
    });
});

describe('pattern matching', () => {
    it('treats "." as any character and digits as literals', () => {
        expect(patternToRegExp('21...').test('21999')).toBe(true);
        expect(patternToRegExp('21...').test('22999')).toBe(false);
    });

    it('extracts an embedded decimal value', () => {
        const m = matchPattern('2100001015001', '21.....{NNDDD}', withCheckDigit);
        expect(m.matched).toBe(true);
        expect(m.value).toBeCloseTo(1.5, 6);
    });

    it('zeroes the embedded field and recomputes the check digit for the base code', () => {
        const m = matchPattern('2100001015001', '21.....{NNDDD}', withCheckDigit);
        expect(m.baseCode.slice(0, 12)).toBe('210000100000');
        expect(isValidEan13(m.baseCode)).toBe(true);
    });

    it('does not match when the pattern is longer than the code', () => {
        expect(matchPattern('21', '21.....{NNDDD}').matched).toBe(false);
    });
});

describe('nomenclature resolution', () => {
    it('decodes a weight-embedded shelf label', () => {
        const parsed = parseBarcode('2100001015001', nomenclature);
        expect(parsed.kind).toBe('weight');
        expect(parsed.value).toBeCloseTo(1.5, 6);
        expect(parsed.code).not.toBe(parsed.raw);
        expect(isValidEan13(parsed.code)).toBe(true);
    });

    it('decodes a price-embedded label', () => {
        // 23 + 5 product digits + 3 int + 2 dec = 12 digits + check digit.
        const parsed = parseBarcode(withCheckDigit('230000101250'), nomenclature);
        expect(parsed.kind).toBe('price');
        expect(parsed.value).toBeCloseTo(12.5, 6);
    });

    it('decodes a discount label', () => {
        const parsed = parseBarcode('2215', nomenclature);
        expect(parsed.kind).toBe('discount');
        expect(parsed.value).toBe(15);
    });

    it('routes customer, cashier and coupon prefixes', () => {
        expect(parseBarcode('0411234', nomenclature).kind).toBe('customer');
        expect(parseBarcode('0429999', nomenclature).kind).toBe('cashier');
        expect(parseBarcode('0435555', nomenclature).kind).toBe('coupon');
    });

    it('rewrites an alias rule to its target code', () => {
        const parsed = parseBarcode('999123', nomenclature);
        expect(parsed.kind).toBe('alias');
        expect(parsed.code).toBe('5901234123457');
    });

    it('falls through to a plain product lookup', () => {
        const parsed = parseBarcode('5901234123457', nomenclature);
        expect(parsed.kind).toBe('product');
        expect(parsed.code).toBe('5901234123457');
    });

    it('offers UPC/EAN conversions as lookup candidates', () => {
        const parsed = parseBarcode('036000291452', nomenclature);
        expect(parsed.candidates).toContain('0036000291452');
    });

    it('respects the encoding gate: an EAN-13 rule does not fire on a short code', () => {
        // "21" + 3 digits is not 13 long, so the weight rule must not claim it.
        const parsed = parseBarcode('21999', nomenclature);
        expect(parsed.kind).not.toBe('weight');
    });

    it('returns an error kind for junk', () => {
        const bare = buildNomenclature(nomenclatureRow, [rule({ rule_type: 'customer', pattern: '041' })]);
        expect(parseBarcode('hello world', bare).kind).toBe('error');
    });

    it('tries the fallback nomenclature only when the primary finds nothing', () => {
        const primary = buildNomenclature(nomenclatureRow, [
            rule({ rule_type: 'customer', pattern: '041', sequence: 1 }),
        ]);
        const fallbackRow: BarcodeNomenclatureRow = { ...nomenclatureRow, id: 2 };
        const fallback = buildNomenclature(fallbackRow, [
            { ...rule({ rule_type: 'coupon', pattern: '77', sequence: 1 }), barcode_nomenclature_id: 2 },
        ]);
        expect(parseBarcodeWithFallback('7712345', primary, fallback).kind).toBe('coupon');
        expect(parseBarcodeWithFallback('0411234', primary, fallback).kind).toBe('customer');
    });
});

describe('GS1-128', () => {
    it('detects the parenthesised and FNC1 forms', () => {
        expect(looksLikeGs1('(01)05901234123457')).toBe(true);
        expect(looksLikeGs1('5901234123457')).toBe(false);
    });

    it('parses a GTIN plus a weight AI with implied decimals', () => {
        const parsed = parseGs1('(01)05901234123457(3103)001500');
        expect(parsed.ok).toBe(true);
        expect(parsed.gtin).toBe('05901234123457');
        expect(parsed.weightKg).toBeCloseTo(1.5, 6);
    });

    it('parses a variable-length batch AI terminated by FNC1', () => {
        const FNC1 = '\u001d';
        const parsed = parseGs1(`010590123412345710ABC123${FNC1}17251231`);
        expect(parsed.gtin).toBe('05901234123457');
        expect(parsed.lot).toBe('ABC123');
        expect(parsed.expiry).toBe('251231');
    });

    it('surfaces a GS1 composite through the nomenclature parser', () => {
        const gs1Nomenclature = buildNomenclature({ ...nomenclatureRow, is_gs1: true }, rules);
        const parsed = parseBarcode('(01)05901234123457(3103)001500', gs1Nomenclature);
        expect(parsed.kind).toBe('gs1');
        expect(parsed.code).toBe('5901234123457');
        expect(parsed.value).toBeCloseTo(1.5, 6);
    });
});
