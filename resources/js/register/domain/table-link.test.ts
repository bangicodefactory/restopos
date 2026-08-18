import { describe, expect, it } from 'vitest';

import { makeTable } from './__fixtures__/catalog';
import { billTableFor, canLink, linkTargets, linkedChildren } from './table-link';

/**
 * RST-050 (BAN-463) — which drops the floor screen may offer.
 *
 * A linked group is a tree, and the drops that break it are exactly the ones a waiter produces by
 * accident: onto the table already in hand, onto something that is itself hanging off a third table,
 * or back onto one of your own children. The server refuses all of them; this is the affordance that
 * keeps the refusal off the screen in the first place.
 */

const T1 = makeTable({ id: 1, floor_id: 1, table_number: '1' });
const T2 = makeTable({ id: 2, floor_id: 1, table_number: '2' });
const T3 = makeTable({ id: 3, floor_id: 1, table_number: '3' });
const UPSTAIRS = makeTable({ id: 9, floor_id: 2, table_number: '9' });

describe('an ordinary pair', () => {
    it('lets one table drop onto the other', () => {
        expect(canLink(T2, T1)).toBe(true);
    });

    it('refuses a table dropped on itself', () => {
        expect(canLink(T1, T1)).toBe(false);
    });

    it('refuses a table in another room, which cannot be pushed through a wall', () => {
        expect(canLink(UPSTAIRS, T1)).toBe(false);
    });
});

describe('a table that is already part of a group', () => {
    const child = { ...T2, parent_id: 1 };

    it('is not offered as a parent, because its own parent is', () => {
        // Dropping onto a child would re-home the whole group under a table the waiter never
        // touched — the bill would move somewhere nobody chose.
        expect(canLink(T3, child)).toBe(false);
    });

    it('can still be dropped onto something else', () => {
        expect(canLink(child, T3)).toBe(true);
    });
});

describe('a drop that would close a loop', () => {
    it('refuses the parent being dropped onto its own child', () => {
        // Two tables pointing at each other is a group with no head: every bill in it becomes
        // unreachable, because the tap that opens one walks the chain forever.
        //
        // Refused by the same rule that refuses any child as a parent — which is what keeps a group
        // one level deep and a cycle unbuildable from this gesture.
        const child = { ...T2, parent_id: 1 };

        expect(canLink(T1, child)).toBe(false);
    });

    it('refuses it through a longer chain too', () => {
        const bottom = { ...T3, parent_id: 2 };

        expect(canLink(T1, bottom)).toBe(false);
    });
});

describe('the targets offered to a drag', () => {
    it('lists exactly the legal ones', () => {
        const child = { ...T3, parent_id: 1 };

        expect(linkTargets(T2, [T1, T2, child, UPSTAIRS]).map((table) => table.id)).toEqual([1]);
    });
});

describe('reading a group', () => {
    it('lists a table’s children in table order', () => {
        const four = { ...T2, parent_id: 1, table_number: '4' };
        const two = { ...T3, parent_id: 1, table_number: '2' };

        expect(linkedChildren(T1, [T1, four, two]).map((table) => table.table_number)).toEqual(['2', '4']);
    });

    it('sends a tap on a child to the table holding the bill', () => {
        const child = { ...T2, parent_id: 1 };

        expect(billTableFor(child, [T1, child]).id).toBe(1);
    });

    it('walks a chain up to the head', () => {
        const middle = { ...T2, parent_id: 1 };
        const bottom = { ...T3, parent_id: 2 };

        expect(billTableFor(bottom, [T1, middle, bottom]).id).toBe(1);
    });

    it('stops rather than hanging when the chain is broken', () => {
        // A parent that is not in this floor's slice — mid-refresh, or a room the device cannot see.
        // Returning the table itself is wrong but finite; looping is a frozen till.
        const orphan = { ...T2, parent_id: 404 };

        expect(billTableFor(orphan, [orphan]).id).toBe(2);
    });

    it('survives a cycle that reached the client anyway', () => {
        const a = { ...T1, parent_id: 2 };
        const b = { ...T2, parent_id: 1 };

        expect(() => billTableFor(a, [a, b])).not.toThrow();
    });
});
