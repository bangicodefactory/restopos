import type { RestaurantTableRow } from '@domain/types';
import { describe, expect, it } from 'vitest';

import { needsOrderName, orderName } from './order-naming';

/**
 * RST-140, RST-141 (BAN-467) — what an order is called.
 *
 * The name existed only as a rendered string: `OrderPanel` worked out "Table 5" at paint time and
 * `floating_order_name` stayed null. The ticket screen, the receipt, the kitchen and a second till
 * each derived their own answer from whatever they had — usually the raw reference — so the only
 * surface that named the order correctly was the panel in front of the waiter.
 */

function table(number: string | number, overrides: Partial<RestaurantTableRow> = {}): RestaurantTableRow {
    return { id: Number(number), table_number: String(number), ...overrides } as RestaurantTableRow;
}

describe('naming an order', () => {
    it('calls a counter sale Direct Sale', () => {
        expect(orderName({ table: null, linked: [] })).toBe('Direct Sale');
    });

    it('names a table order by its number', () => {
        expect(orderName({ table: table(5), linked: [] })).toBe('T 5');
    });

    it('joins linked tables the way a waiter says them', () => {
        expect(orderName({ table: table(3), linked: [table(4)] })).toBe('T 3 & 4');
    });

    it('sorts linked tables numerically, not by the order they were merged', () => {
        // "T 4 & 3" is the same pair described backwards, and reads on the pass as a different one.
        expect(orderName({ table: table(4), linked: [table(3)] })).toBe('T 3 & 4');
    });

    it('handles three tables pushed together', () => {
        expect(orderName({ table: table(7), linked: [table(9), table(8)] })).toBe('T 7 & 8 & 9');
    });

    it('sorts numerically rather than as text', () => {
        // The bug a string sort would produce: T 10 sorting before T 9.
        expect(orderName({ table: table(9), linked: [table(10)] })).toBe('T 9 & 10');
    });
});

describe('a name the cashier typed', () => {
    it('wins over the table', () => {
        // Somebody looked at this order and decided what to call it. No amount of table movement
        // should overwrite that.
        expect(orderName({ table: table(5), linked: [], manual: 'Birthday party' })).toBe('Birthday party');
    });

    it('wins over Direct Sale', () => {
        expect(orderName({ table: null, linked: [], manual: 'Amina — collection' })).toBe('Amina — collection');
    });

    it('is ignored when it is blank', () => {
        expect(orderName({ table: table(5), linked: [], manual: '   ' })).toBe('T 5');
        expect(orderName({ table: table(5), linked: [], manual: null })).toBe('T 5');
    });
});

describe('when a name has to be asked for', () => {
    it('asks on a preset with no table', () => {
        // Takeaway or collection: no table number to call it by, so without a name the pass has
        // nothing to shout and every order that hour is "Direct Sale".
        expect(needsOrderName({ hasTable: false, hasPreset: true, name: null })).toBe(true);
    });

    it('does not ask once a name is there', () => {
        expect(needsOrderName({ hasTable: false, hasPreset: true, name: 'Amina' })).toBe(false);
    });

    it('treats whitespace as no name', () => {
        expect(needsOrderName({ hasTable: false, hasPreset: true, name: '  ' })).toBe(true);
    });

    it('never asks for a table order — the table is the name', () => {
        expect(needsOrderName({ hasTable: true, hasPreset: true, name: null })).toBe(false);
    });

    it('never asks on an ordinary counter sale with no preset', () => {
        // A till with no service modes at all would otherwise prompt on every sale.
        expect(needsOrderName({ hasTable: false, hasPreset: false, name: null })).toBe(false);
    });
});
