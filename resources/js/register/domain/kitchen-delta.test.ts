import type { PrepSnapshot } from '@domain/types';
import { asUuid } from '@domain/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeCourse, makeLine, resetRowSequences } from './__fixtures__/rows';
import {
    buildPrepSnapshot,
    changeCountsByCategory,
    computePrepDelta,
    filterChangesByCategories,
    hashNotes,
    prepKey,
    splitChangesForTickets,
} from './kitchen-delta';

/** Unit coverage for KDS-051 … KDS-055 — "what has the kitchen not yet seen". */

const AT = '2026-07-28T12:00:00.000Z';

function snapshotOf(lines: Parameters<typeof buildPrepSnapshot>[0], note: string | null = null): PrepSnapshot {
    return buildPrepSnapshot(lines, note, null, AT);
}

beforeEach(() => {
    resetRowSequences();
});

describe('prepKey', () => {
    it('keys on uuid *and* note, so the same line with a new note is a different item', () => {
        const line = makeLine({ uuid: asUuid('a'), customer_note: 'no basil' });
        const renoted = { ...line, customer_note: 'extra basil' };
        expect(prepKey(line)).not.toBe(prepKey(renoted));
        expect(prepKey(line)).toBe('a::no basil|[]');
    });

    it('keeps two identical products with different notes distinct in the snapshot', () => {
        const a = makeLine({ uuid: asUuid('a'), product_id: 7, customer_note: 'rare' });
        const b = makeLine({ uuid: asUuid('b'), product_id: 7, customer_note: 'well done' });
        const snapshot = snapshotOf([a, b]);
        expect(Object.keys(snapshot.lines)).toHaveLength(2);
        expect(snapshot.lines[prepKey(a)]).toBe(1);
        expect(snapshot.lines[prepKey(b)]).toBe(1);
    });

    it('folds the internal note into the key too', () => {
        const line = makeLine({ uuid: asUuid('a'), internal_note: [{ text: 'allergy', color_index: 1 }] });
        expect(prepKey(line)).toBe('a::|[{"text":"allergy","color_index":1}]');
    });
});

describe('buildPrepSnapshot', () => {
    it('sums quantities and skips lines flagged skip_preparation', () => {
        const cooked = makeLine({ uuid: asUuid('a'), quantity: 2 });
        const notCooked = makeLine({ uuid: asUuid('b'), skip_preparation: true });
        const snapshot = snapshotOf([cooked, notCooked]);
        expect(snapshot.lines).toEqual({ 'a::|[]': 2 });
        expect(snapshot.at).toBe(AT);
    });

    it('hashes the order-level notes', () => {
        expect(snapshotOf([], 'take away').noteHash).toBe(hashNotes('take away', null));
        expect(hashNotes('a', null)).not.toBe(hashNotes('b', null));
        expect(hashNotes(null, null)).toBe(hashNotes(null, null));
    });
});

describe('computePrepDelta', () => {
    it('first send: everything is new', () => {
        const lines = [makeLine({ uuid: asUuid('a'), quantity: 2 }), makeLine({ uuid: asUuid('b'), quantity: 1 })];
        const delta = computePrepDelta(lines, [], null);

        expect(delta.changes.map((c) => [c.lineUuid, c.changeType, c.quantity])).toEqual([
            ['a', 'new', 2],
            ['b', 'new', 1],
        ]);
        expect(delta.nbrOfChanges).toBe(3);
        expect(delta.count).toBe(3);
        expect(delta.orderNoteChanged).toBe(false);
    });

    it('re-sending an unchanged order is a no-op', () => {
        const lines = [makeLine({ uuid: asUuid('a'), quantity: 2 })];
        const delta = computePrepDelta(lines, [], snapshotOf(lines));
        expect(delta.changes).toEqual([]);
        expect(delta.nbrOfChanges).toBe(0);
        expect(delta.count).toBe(0);
    });

    it('reports an added line only', () => {
        const first = makeLine({ uuid: asUuid('a') });
        const snapshot = snapshotOf([first]);
        const added = makeLine({ uuid: asUuid('b'), full_product_name: 'Calzone' });

        const delta = computePrepDelta([first, added], [], snapshot);
        expect(delta.changes).toHaveLength(1);
        expect(delta.changes[0]).toMatchObject({ lineUuid: 'b', changeType: 'new', quantity: 1, name: 'Calzone' });
    });

    it('reports a removed line as a negative cancellation', () => {
        const kept = makeLine({ uuid: asUuid('a') });
        const gone = makeLine({ uuid: asUuid('b'), quantity: 3 });
        const snapshot = snapshotOf([kept, gone]);

        const delta = computePrepDelta([kept], [], snapshot);
        expect(delta.changes).toEqual([
            expect.objectContaining({ lineUuid: 'b', changeType: 'cancelled', quantity: -3 }),
        ]);
        expect(delta.nbrOfChanges).toBe(3);
        expect(delta.count).toBe(-3);
    });

    it.each([
        { label: 'increase', before: 1, after: 3, quantity: 2, type: 'new' },
        { label: 'decrease', before: 3, after: 1, quantity: -2, type: 'cancelled' },
    ])('reports a quantity $label as a signed $type change', ({ before, after, quantity, type }) => {
        const snapshot = snapshotOf([makeLine({ uuid: asUuid('a'), quantity: before })]);
        const delta = computePrepDelta([makeLine({ uuid: asUuid('a'), quantity: after })], [], snapshot);

        expect(delta.changes).toHaveLength(1);
        expect(delta.changes[0]?.quantity).toBe(quantity);
        expect(delta.changes[0]?.changeType).toBe(type);
        expect(delta.nbrOfChanges).toBe(Math.abs(quantity));
        expect(delta.count).toBe(quantity);
    });

    it('turns a note change into one note_update carrying the whole quantity, not a cancel/new pair', () => {
        const before = makeLine({ uuid: asUuid('a'), quantity: 2, customer_note: 'no basil' });
        const after = { ...before, customer_note: 'extra basil' };

        const delta = computePrepDelta([after], [], snapshotOf([before]));
        expect(delta.changes).toHaveLength(1);
        expect(delta.changes[0]).toMatchObject({
            lineUuid: 'a',
            changeType: 'note_update',
            quantity: 2,
            customerNote: 'extra basil',
        });
    });

    it('flattens an internal note list onto the change', () => {
        const line = makeLine({
            uuid: asUuid('a'),
            internal_note: [
                { text: 'allergy', color_index: 1 },
                { text: 'rush', color_index: 2 },
            ],
        });
        const delta = computePrepDelta([line], [], null);
        expect(delta.changes[0]?.internalNote).toBe('allergy, rush');
    });

    it('carries the course index so the pass can group the ticket', () => {
        const course = makeCourse({ uuid: asUuid('c2'), index: 2, name: 'Plat' });
        const line = makeLine({ uuid: asUuid('a'), course_uuid: asUuid('c2') });

        const delta = computePrepDelta([line], [course], null);
        expect(delta.changes[0]).toMatchObject({ courseUuid: 'c2', courseIndex: 2 });
    });

    it('a course change alone produces no kitchen change — the item is unchanged', () => {
        const before = makeLine({ uuid: asUuid('a'), course_uuid: asUuid('c1') });
        const after = { ...before, course_uuid: asUuid('c2') };
        const courses = [
            makeCourse({ uuid: asUuid('c1'), index: 1 }),
            makeCourse({ uuid: asUuid('c2'), index: 2 }),
        ];

        const delta = computePrepDelta([after], courses, snapshotOf([before]));
        expect(delta.changes).toEqual([]);
        expect(delta.nbrOfChanges).toBe(0);
    });

    it('keeps two same-product lines with different notes apart across a diff', () => {
        const rare = makeLine({ uuid: asUuid('a'), product_id: 7, customer_note: 'rare' });
        const welldone = makeLine({ uuid: asUuid('b'), product_id: 7, customer_note: 'well done' });
        const snapshot = snapshotOf([rare, welldone]);

        // Only the "rare" one goes up to 2; the other must not absorb the change.
        const delta = computePrepDelta([{ ...rare, quantity: 2 }, welldone], [], snapshot);
        expect(delta.changes).toEqual([
            expect.objectContaining({ lineUuid: 'a', quantity: 1, changeType: 'new' }),
        ]);
    });

    it('flags an order-level note change without inventing line changes', () => {
        const lines = [makeLine({ uuid: asUuid('a') })];
        const delta = computePrepDelta(lines, [], snapshotOf(lines, null), 'allergie arachide', null);
        expect(delta.changes).toEqual([]);
        expect(delta.orderNoteChanged).toBe(true);
        expect(delta.generalCustomerNote).toBe('allergie arachide');
    });

    it('never flags an order-note change on the first send (there is nothing to compare to)', () => {
        const delta = computePrepDelta([makeLine()], [], null, 'allergie arachide', null);
        expect(delta.orderNoteChanged).toBe(false);
    });

    it('ignores skip_preparation lines on both sides of the diff', () => {
        const line = makeLine({ uuid: asUuid('a'), skip_preparation: true, quantity: 5 });
        expect(computePrepDelta([line], [], null).changes).toEqual([]);
    });
});

describe('routing a delta to printers', () => {
    const food = makeLine({ uuid: asUuid('a'), pos_category_id: 10 });
    const drink = makeLine({ uuid: asUuid('b'), pos_category_id: 20, quantity: 2 });
    const delta = computePrepDelta([food, drink], [], null);

    it('returns the whole delta when a printer declares no categories', () => {
        expect(filterChangesByCategories(delta, [])).toHaveLength(2);
    });

    it('slices the delta per station', () => {
        expect(filterChangesByCategories(delta, [20]).map((c) => c.lineUuid)).toEqual(['b']);
    });

    it('counts absolute changes per category for the send button chips', () => {
        expect(changeCountsByCategory(delta)).toEqual(
            new Map([
                [10, 1],
                [20, 2],
            ]),
        );
    });

    it('splits a delta into created / cancelled / note-update tickets', () => {
        const before = makeLine({ uuid: asUuid('x'), quantity: 1, customer_note: 'a' });
        const removed = makeLine({ uuid: asUuid('y'), quantity: 1 });
        const snapshot = snapshotOf([before, removed]);
        const noted = { ...before, customer_note: 'b' };
        const fresh = makeLine({ uuid: asUuid('z') });

        const tickets = splitChangesForTickets(computePrepDelta([noted, fresh], [], snapshot).changes);
        expect(tickets.created.map((c) => c.lineUuid)).toEqual(['z']);
        expect(tickets.noteUpdates.map((c) => c.lineUuid)).toEqual(['x']);
        expect(tickets.cancelled.map((c) => c.lineUuid)).toEqual(['y']);
    });
});
