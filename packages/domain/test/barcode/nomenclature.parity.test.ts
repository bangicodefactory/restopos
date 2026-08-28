/**
 * The parser's half of the barcode contract (BOF-043, BAN-488).
 *
 * `tests/fixtures/barcode/nomenclature-parity.json` says two things: what the back office must ship
 * for a nomenclature, and what this parser must then make of it. The PHP side
 * (`BarcodeNomenclatureTest`) authors those rules through the real endpoint and asserts the
 * bootstrap payload matches the fixture field for field; this asserts the parse.
 *
 * Neither test alone means much. Together they close the join the ticket names — that a rule
 * authored in the back office parses the same way at the till — without a second implementation of
 * the parser to disagree with.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { BarcodeNomenclatureRow, BarcodeRuleRow } from '../../src/types';

import { buildNomenclature, parseBarcode } from '../../src/barcode/nomenclature';

type ParityCase = {
    why: string;
    scan: string;
    kind: string;
    value: number;
    ruleId: number | null;
};

type ParityFixture = {
    nomenclature: BarcodeNomenclatureRow;
    rules: BarcodeRuleRow[];
    cases: ParityCase[];
};

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
    readFileSync(resolve(here, '../../../../tests/fixtures/barcode/nomenclature-parity.json'), 'utf8'),
) as ParityFixture;

describe('nomenclature parity with the back office', () => {
    it('finds the shared fixture corpus', () => {
        // The guard on the guard: an empty or renamed fixture would make every case below pass by
        // having nothing to run.
        expect(fixture.rules.length).toBeGreaterThanOrEqual(3);
        expect(fixture.cases.length).toBeGreaterThanOrEqual(5);
        expect(fixture.cases.map((c) => c.kind)).toContain('weight');
    });

    it.each(fixture.cases)('$why', (parityCase) => {
        const built = buildNomenclature(fixture.nomenclature, fixture.rules);
        const parsed = parseBarcode(parityCase.scan, built);

        expect(parsed.kind).toBe(parityCase.kind);
        expect(parsed.value).toBe(parityCase.value);
        expect(parsed.ruleId).toBe(parityCase.ruleId);
    });

    it('reports the base code for a weighed item, not the scanned one', () => {
        // The distinction the whole feature turns on. The printed check digit covers the *weight*,
        // so looking the product up by the scanned string finds nothing — every weighed item would
        // miss, and a cashier would key it in by hand at whatever price they remembered.
        const built = buildNomenclature(fixture.nomenclature, fixture.rules);
        const parsed = parseBarcode('2100001015005', built);

        expect(parsed.code).not.toBe('2100001015005');
        expect(parsed.code.slice(0, 7)).toBe('2100001');
        expect(parsed.code.slice(7, 12)).toBe('00000');
    });
});
