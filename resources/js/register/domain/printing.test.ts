/**
 * The register's half of the printer binding contract (XCT-050, BAN-426).
 *
 * `tests/fixtures/printing/printer-binding.json` says two things: what the bootstrap must ship for
 * a printer, and what the register must then make of it. The PHP side
 * (`PrinterBindingContractTest`) asserts the real endpoint emits those field names with those
 * derivations; this asserts the binding and the routing.
 *
 * Neither alone would have caught what was actually wrong. `bindingsFromCatalog` had no test at
 * all, and the only printer-shaped objects in the tree were hand-written to the declared type — so
 * both sides were internally consistent and disagreed with each other, which is precisely the
 * failure a one-sided test cannot see.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { PosPrinterRow } from '@domain/types';
import { PrinterRouter } from '@shared/printing/router';

import { bindingsFromCatalog } from './printing';

type Fixture = {
    printers: PosPrinterRow[];
    bindings: Array<{
        id: string;
        role: string;
        categoryIds: number[];
        allCategories: boolean;
        transport: string;
        address: string;
        eposDeviceId: string | null;
        profile: string;
    }>;
    routing: Array<{
        why: string;
        job: { role: string; categoryIds: number[] };
        expect: string[];
    }>;
};

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
    readFileSync(resolve(here, '../../../../tests/fixtures/printing/printer-binding.json'), 'utf-8'),
) as Fixture;

const bindings = bindingsFromCatalog({ printers: fixture.printers } as never);

describe('bindingsFromCatalog', () => {
    it('binds every printer the bootstrap sent, in order', () => {
        expect(bindings.map((b) => b.id)).toEqual(fixture.bindings.map((b) => b.id));
    });

    for (const [index, expected] of fixture.bindings.entries()) {
        it(`binds printer ${expected.id} as ${expected.role} on ${expected.transport}`, () => {
            const actual = bindings[index];
            if (actual === undefined) throw new Error(`no binding at index ${index}`);

            expect(actual.role).toBe(expected.role);
            expect(actual.categoryIds).toEqual(expected.categoryIds);
            expect(actual.allCategories === true).toBe(expected.allCategories);
            expect(actual.transport).toBe(expected.transport);
            expect(actual.address).toBe(expected.address);
            expect(actual.eposDeviceId ?? null).toBe(expected.eposDeviceId);
            expect(actual.profile).toBe(expected.profile);
        });
    }

    it('does not invent a placeholder when the venue has a real receipt printer', () => {
        // The placeholder is a printer-less-till affordance. Emitting it here would mean the
        // receipt printer was not recognised as one — the original symptom of this whole defect.
        expect(bindings.some((b) => b.placeholder === true)).toBe(false);
    });

    it('survives a printer whose categories relation was never loaded', () => {
        // `pos_category_ids` is appended off an eager-loaded relation. If that eager load is ever
        // dropped the field goes missing, and `resolveTargets` calls `.some()` on it mid-service.
        const [receipt, kitchen] = fixture.printers;
        const stripped = { ...kitchen } as Record<string, unknown>;
        delete stripped.pos_category_ids;

        const built = bindingsFromCatalog({ printers: [receipt, stripped] } as never);

        expect(built[1]?.categoryIds).toEqual([]);
        expect(() =>
            new PrinterRouter({ bindings: built }).resolveTargets({ role: 'prep', categoryIds: [10] } as never),
        ).not.toThrow();
    });
});

describe('prep routing', () => {
    const router = new PrinterRouter({ bindings });

    for (const testCase of fixture.routing) {
        it(testCase.why, () => {
            const targets = router.resolveTargets(testCase.job as never);

            expect(targets.map((t) => t.id).sort()).toEqual([...testCase.expect].sort());
        });
    }
});
