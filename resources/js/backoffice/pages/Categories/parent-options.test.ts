/**
 * `parentOptions` — which categories the "parent" picker may offer (BAN-422).
 *
 * The server refuses a move onto the node itself or onto one of its own descendants, because the
 * result is a ring with no root: nothing reaches it afterwards, so every pricelist category rule on
 * that branch stops applying and the categories vanish from any screen that renders the tree from
 * the roots down.
 *
 * Offering those choices anyway means the only way to learn the rule is to be told off by a save
 * that failed. This is the picker agreeing with the endpoint — tested rather than assumed, because
 * the two are enforced in different languages and can drift apart silently.
 */

import { describe, expect, it } from 'vitest';

import { parentOptions, type CategoryRow } from './types';

function row(id: number, parentId: number | null, name: string): CategoryRow {
    return {
        id,
        name,
        parent_id: parentId,
        depth: 0,
        sequence: id * 10,
        color: 0,
        hour_after: null,
        hour_until: null,
        self_order_visible: true,
        active: true,
    };
}

//  Drinks ── Wine ── Red ── Bordeaux
//  Food (unrelated)
const TREE: CategoryRow[] = [
    row(1, null, 'Drinks'),
    row(2, 1, 'Wine'),
    row(3, 2, 'Red'),
    row(4, 3, 'Bordeaux'),
    row(5, null, 'Food'),
];

const names = (rows: CategoryRow[]): string[] => rows.map((r) => r.name);

describe('parentOptions', () => {
    it('offers every category when creating a new one', () => {
        expect(names(parentOptions(TREE, null))).toEqual(['Drinks', 'Wine', 'Red', 'Bordeaux', 'Food']);
    });

    it('never offers the category itself', () => {
        expect(names(parentOptions(TREE, row(2, 1, 'Wine')))).not.toContain('Wine');
    });

    it('never offers a direct child', () => {
        expect(names(parentOptions(TREE, row(2, 1, 'Wine')))).not.toContain('Red');
    });

    it('never offers a grandchild, which is the case a one-level check misses', () => {
        // The shallow version of this guard — "exclude my children" — passes every other test here
        // and still lets Wine be filed under Bordeaux.
        expect(names(parentOptions(TREE, row(2, 1, 'Wine')))).not.toContain('Bordeaux');
    });

    it('still offers the ancestors and unrelated branches', () => {
        // A move has to remain possible, or the picker is just empty. Wine may go under Drinks
        // (where it already is), or over to Food.
        expect(names(parentOptions(TREE, row(2, 1, 'Wine')))).toEqual(['Drinks', 'Food']);
    });

    it('offers everything else for a leaf', () => {
        expect(names(parentOptions(TREE, row(4, 3, 'Bordeaux')))).toEqual(['Drinks', 'Wine', 'Red', 'Food']);
    });

    it('does not loop forever on a tree that is already a ring', () => {
        // Data written before the guard existed, or by hand. The picker must render rather than
        // hang the back office.
        const ring: CategoryRow[] = [row(1, 2, 'A'), row(2, 1, 'B')];

        expect(names(parentOptions(ring, row(1, 2, 'A')))).toEqual([]);
    });
});
