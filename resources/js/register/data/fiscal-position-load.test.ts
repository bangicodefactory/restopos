/**
 * A fiscal position's mappings must survive the trip to the client (BAN-398).
 *
 * `FiscalPositionMapper` has rewritten taxes correctly since it was written, and
 * `packages/domain/test/tax.test.ts` covers it. None of that ran on real data, because the mappings
 * never arrived: `FiscalPositionTaxRow` declared `source_tax_id` / `dest_tax_id`, the columns are
 * `tax_src_id` / `tax_dest_id`, and `configPayload()` ships `attributesToArray()`.
 *
 * So every mapping reached the index as `{taxSrcId: undefined, taxDestId: undefined}` — probed, it
 * logged `mappings: [{}]`. The mapper compares `mapping.taxSrcId !== srcId`, never matches, and
 * passes the source tax through untouched. **No fiscal position has ever changed a tax at a till**,
 * and the back office had no way to create one either, so nothing surfaced it.
 *
 * Tested here rather than in the mapper's own suite because the mapper was never wrong. The seam
 * between the wire and the mapper was.
 */

import { describe, expect, it } from 'vitest';

import { loadCatalogIndex } from './catalog-load';
import type { PosDb } from '@shared/db';

/** Every table answers `[]` unless this test cares about it. */
function fakeDb(tables: Record<string, unknown[]>): PosDb {
    return new Proxy(
        {},
        { get: (_target, prop: string) => ({ toArray: async () => tables[prop] ?? [] }) },
    ) as unknown as PosDb;
}

const POSITION = { id: 1, name: 'À emporter' };

describe('a fiscal position reaching the till', () => {
    it('carries the ids the server actually sent', async () => {
        const index = await loadCatalogIndex(
            fakeDb({
                fiscalPositions: [POSITION],
                // Exactly what `attributesToArray()` produces for `fiscal_position_taxes`.
                fiscalPositionTaxes: [
                    { id: 1, fiscal_position_id: 1, tax_src_id: 10, tax_dest_id: 20 },
                ],
            }),
            1,
        );

        expect(index.fiscalPositionMappings.get(1)?.mappings).toEqual([
            { taxSrcId: 10, taxDestId: 20 },
        ]);
    });

    it('keeps a removal a removal', async () => {
        // `tax_dest_id: null` is how an exempt or export regime takes the tax off entirely. Read
        // through the wrong key it was `undefined`, which the mapper treats identically to a
        // missing mapping — so the tax stayed on, which is the opposite of exempt.
        const index = await loadCatalogIndex(
            fakeDb({
                fiscalPositions: [POSITION],
                fiscalPositionTaxes: [
                    { id: 1, fiscal_position_id: 1, tax_src_id: 10, tax_dest_id: null },
                ],
            }),
            1,
        );

        expect(index.fiscalPositionMappings.get(1)?.mappings).toEqual([
            { taxSrcId: 10, taxDestId: null },
        ]);
    });

    it('does not put one venue mapping under another position', async () => {
        const index = await loadCatalogIndex(
            fakeDb({
                fiscalPositions: [POSITION, { id: 2, name: 'Export' }],
                fiscalPositionTaxes: [
                    { id: 1, fiscal_position_id: 1, tax_src_id: 10, tax_dest_id: 20 },
                    { id: 2, fiscal_position_id: 2, tax_src_id: 10, tax_dest_id: null },
                ],
            }),
            1,
        );

        expect(index.fiscalPositionMappings.get(1)?.mappings).toEqual([{ taxSrcId: 10, taxDestId: 20 }]);
        expect(index.fiscalPositionMappings.get(2)?.mappings).toEqual([{ taxSrcId: 10, taxDestId: null }]);
    });
});
