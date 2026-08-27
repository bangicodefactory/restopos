/**
 * Deactivated options must leave the till (BAN-412 review).
 *
 * The back office refuses to *delete* an option a past order recorded, and tells the operator to
 * deactivate it instead — so deactivating has to actually do something. It did not: the index
 * grouped every attribute line and line value regardless of `active`, unlike variants, which have
 * always filtered. `ProductAttributeLineRow` did not even carry the column, though the table has it
 * and the bootstrap sends it.
 *
 * The filtering is client-side on purpose. The bootstrap deliberately ships archived rows so the
 * client can purge its own copies (§5.5), so a server-side filter would hide the row rather than
 * retire it.
 */

import { describe, expect, it } from 'vitest';

import { loadCatalogIndex } from './catalog-load';
import type { PosDb } from '@shared/db';

/** Every table answers `[]` unless this test cares about it. */
function fakeDb(tables: Record<string, unknown[]>): PosDb {
    return new Proxy(
        {},
        {
            get: (_target, prop: string) => ({
                toArray: async () => tables[prop] ?? [],
            }),
        },
    ) as unknown as PosDb;
}

const LINES = [
    { id: 1, product_id: 7, product_attribute_id: 1, is_required: true, sequence: 10, active: true },
    { id: 2, product_id: 7, product_attribute_id: 2, is_required: false, sequence: 20, active: false },
];

const LINE_VALUES = [
    { id: 11, product_attribute_line_id: 1, product_attribute_value_id: 100, product_id: 7, price_extra: '2.00', sequence: 10, active: true },
    { id: 12, product_attribute_line_id: 1, product_attribute_value_id: 101, product_id: 7, price_extra: '0.00', sequence: 20, active: false },
];

describe('the catalogue index', () => {
    it('drops a deactivated attribute line', async () => {
        const index = await loadCatalogIndex(
            fakeDb({ attributeLines: LINES, attributeLineValues: LINE_VALUES }),
            1,
        );

        expect(index.attributeLinesByProduct.get(7)?.map((line) => line.id)).toEqual([1]);
    });

    it('drops a deactivated option within a line', async () => {
        // The finer case: the line still applies, one of its choices does not. An operator retiring
        // "extra bacon" is not retiring "Extras".
        const index = await loadCatalogIndex(
            fakeDb({ attributeLines: LINES, attributeLineValues: LINE_VALUES }),
            1,
        );

        expect(index.attributeLineValuesByLine.get(1)?.map((value) => value.id)).toEqual([11]);
    });

    it('keeps the active ones in sequence order', async () => {
        // The filter must not disturb the ordering the picker renders in.
        const index = await loadCatalogIndex(
            fakeDb({
                attributeLines: [
                    { ...LINES[0]!, id: 3, sequence: 30, active: true },
                    { ...LINES[0]!, id: 1, sequence: 10, active: true },
                    { ...LINES[0]!, id: 2, sequence: 20, active: true },
                ],
                attributeLineValues: [],
            }),
            1,
        );

        expect(index.attributeLinesByProduct.get(7)?.map((line) => line.id)).toEqual([1, 2, 3]);
    });
});
