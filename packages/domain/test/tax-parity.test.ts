import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TaxEngine } from '../src/tax/engine';
import { PricelistResolver, type Pricelist, type PricelistContext } from '../src/pricing/pricelist';
import { ComboPriceDistributor, type ComboDistributionInput } from '../src/pricing/combo';
import type { OrderInput } from '../src/tax/types';

/**
 * The parity harness — docs/spec/04-tax-engine.md §13.
 *
 * Reads exactly the same fixture files as `tests/Unit/Tax/TaxEngineParityTest.php` and asserts
 * exact string equality. No tolerance, ever.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = resolve(HERE, '../../../tests/fixtures/tax');

type Fixture = OrderInput & {
    name: string;
    description: string;
    specRefs?: string[];
    pricelist?: {
        pricelists: Pricelist[];
        resolve: { id: string; pricelistId: number; context: PricelistContext; rate?: string }[];
    } | null;
    combo?: ComboDistributionInput | null;
    expected: {
        pricelist?: { id: string; price: string }[];
        combo?: { id: string; priceUnit: string }[];
        lines: unknown[];
        totals: unknown;
    };
};

function loadFixtures(): { file: string; fixture: Fixture }[] {
    const files = readdirSync(FIXTURE_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort();
    return files.map((file) => ({
        file,
        fixture: JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as Fixture,
    }));
}

const fixtures = loadFixtures();
const engine = new TaxEngine();
const distributor = new ComboPriceDistributor();

describe('tax engine parity corpus', () => {
    it('finds the shared fixture corpus', () => {
        expect(fixtures.length).toBeGreaterThanOrEqual(60);
    });

    for (const { file, fixture } of fixtures) {
        describe(file, () => {
            // §13 step 1
            if (fixture.pricelist) {
                it('resolves pricelist rules', () => {
                    const resolver = PricelistResolver.fromArray(fixture.pricelist!.pricelists);
                    const actual = fixture.pricelist!.resolve.map((entry) => ({
                        id: entry.id,
                        price: resolver.resolve(entry.pricelistId, entry.context, entry.rate ?? '1'),
                    }));
                    expect(actual).toEqual(fixture.expected.pricelist);
                });
            }

            // §13 step 2
            if (fixture.combo) {
                it('distributes the combo price', () => {
                    expect(distributor.distribute(fixture.combo!)).toEqual(fixture.expected.combo);
                });
            }

            // §13 steps 3 and 4
            it('computes taxes and totals', () => {
                const result = engine.compute(fixture);
                expect(result.lines).toEqual(fixture.expected.lines);
                expect(result.totals).toEqual(fixture.expected.totals);
            });
        });
    }
});
