import type { RestaurantTableRow } from '@domain/types';
import { describe, expect, it } from 'vitest';

import { transferTargets } from './table-transfer';

/**
 * RST-057 (BAN-467) — moving an order from the order list.
 *
 * The only way to move an order was the arm-and-tap gesture on the floor plan, which cannot help
 * with the case that needs it most: an order that is not on a table yet. A takeaway the customer
 * decides to eat in, a bill started at the counter — both are floating, and the floor plan has
 * nothing to arm.
 */

function table(number: number, overrides: Partial<RestaurantTableRow> = {}): RestaurantTableRow {
    return { id: number, table_number: String(number), active: true, ...overrides } as RestaurantTableRow;
}

const TABLES = [table(2), table(1), table(3)];

describe('where a floating order can go', () => {
    it('offers every active table, in table-number order', () => {
        const targets = transferTargets(TABLES, [{ uuid: 'floating', restaurant_table_id: null }], 'floating');

        expect(targets.map((t) => t.label)).toEqual(['T 1', 'T 2', 'T 3']);
    });

    it('marks a table that already has a bill, because sending there is a merge', () => {
        const targets = transferTargets(
            TABLES,
            [
                { uuid: 'floating', restaurant_table_id: null },
                { uuid: 'seated', restaurant_table_id: 2 },
            ],
            'floating',
        );

        expect(targets.find((t) => t.tableId === 2)?.occupiedByUuid).toBe('seated');
        expect(targets.find((t) => t.tableId === 1)?.occupiedByUuid).toBeNull();
    });

    it('leaves out an inactive table', () => {
        const targets = transferTargets([table(1), table(9, { active: false })], [], 'floating');

        expect(targets.map((t) => t.tableId)).toEqual([1]);
    });

    it('never offers the order its own table', () => {
        // Sending a bill where it already is has no meaning, and the server refuses a self-transfer.
        const targets = transferTargets(TABLES, [{ uuid: 'seated', restaurant_table_id: 2 }], 'seated');

        expect(targets.map((t) => t.tableId)).toEqual([1, 3]);
    });

    it('does not count the order being moved as an occupant elsewhere', () => {
        const targets = transferTargets(TABLES, [{ uuid: 'seated', restaurant_table_id: 2 }], 'seated');

        expect(targets.every((t) => t.occupiedByUuid === null)).toBe(true);
    });

    it('picks the first draft when a table somehow holds two', () => {
        // Matching the server's rule that the oldest bill survives a reconciliation, so the picker
        // names the same order the merge would keep.
        const targets = transferTargets(
            TABLES,
            [
                { uuid: 'floating', restaurant_table_id: null },
                { uuid: 'older', restaurant_table_id: 3 },
                { uuid: 'newer', restaurant_table_id: 3 },
            ],
            'floating',
        );

        expect(targets.find((t) => t.tableId === 3)?.occupiedByUuid).toBe('older');
    });

    it('sorts numerically rather than as text', () => {
        const targets = transferTargets([table(10), table(9)], [], 'floating');

        expect(targets.map((t) => t.label)).toEqual(['T 9', 'T 10']);
    });
});
