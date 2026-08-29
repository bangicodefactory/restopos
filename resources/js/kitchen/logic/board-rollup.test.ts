import { describe, expect, it } from 'vitest';

import type { KitchenLine, KitchenOrder, KitchenStage } from '../types';
import {
    BOARD_LAYOUTS,
    EMPTY_FILTER,
    boardLayoutOf,
    buildBoard,
    nextLayout,
    rollUp,
} from './board';
import { thresholdsFor } from './elapsed';

/**
 * The roll-up layout (KDS-013, BAN-436a).
 *
 * `grid` was a fully wired value that nothing read: a valid enum case, allowed by the migration's
 * check constraint, documented in `01-schema.md`, validated on save, offered as "Grille" in the
 * back-office picker, written by the seeder for the bar screen and shipped to the client — and then
 * flattened into `columns` by a ternary in `App.tsx`. These tests cover both halves of the fix: the
 * normaliser that stops swallowing the value, and the projection that gives it something to render.
 *
 * Colocated under `resources/js/kitchen/` and not `tests/js/`, which vitest does not scan — a test
 * written there would pass review by never running.
 */

const STAGES: KitchenStage[] = [
    { id: 1, prep_display_id: 2, name: 'À faire', stage_type: 'todo', color: null, alert_after_minutes: null, sequence: 10 },
    { id: 2, prep_display_id: 2, name: 'En cours', stage_type: 'in_progress', color: null, alert_after_minutes: null, sequence: 20 },
    { id: 3, prep_display_id: 2, name: 'Prêt', stage_type: 'ready', color: null, alert_after_minutes: null, sequence: 30 },
    { id: 4, prep_display_id: 2, name: 'Servi', stage_type: 'done', color: null, alert_after_minutes: null, sequence: 40 },
];

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const THRESHOLDS = thresholdsFor({ average_prep_minutes: 10, late_threshold_minutes: 15 });

let lineSeq = 0;

function line(partial: Partial<KitchenLine> = {}): KitchenLine {
    lineSeq += 1;
    return {
        id: lineSeq,
        uuid: `line-${lineSeq}`,
        pos_order_line_uuid: `pol-${lineSeq}`,
        prep_stage_id: 1,
        course_index: null,
        product_id: 100,
        display_name: 'Frites',
        quantity: '1.000',
        change_type: 'new',
        customer_note: null,
        internal_note: null,
        state: 'todo',
        started_at: null,
        ready_at: null,
        served_at: null,
        fired_at: '2026-07-28T11:55:00.000Z',
        ...partial,
    };
}

let orderSeq = 0;

function order(partial: Partial<KitchenOrder> = {}): KitchenOrder {
    orderSeq += 1;
    return {
        id: orderSeq,
        uuid: `prep-${orderSeq}`,
        prep_display_id: 2,
        pos_order_id: 55000 + orderSeq,
        tracking_number: String(400 + orderSeq),
        table_label: 'T1',
        guest_count: 2,
        preset_label: null,
        customer_name: null,
        order_note: null,
        state: 'pending',
        fired_at: '2026-07-28T11:55:00.000Z',
        first_started_at: null,
        ready_at: null,
        served_at: null,
        is_recalled: false,
        age_seconds: 300,
        lines: [line()],
        ...partial,
    };
}

describe('boardLayoutOf (BAN-436a — the value nothing read)', () => {
    it('keeps grid instead of collapsing it to columns', () => {
        // The defect exactly: `display.layout === 'list' ? 'list' : 'columns'` sent every `grid`
        // display to the card wall, so choosing "Grille" in the back office did nothing at all.
        expect(boardLayoutOf('grid')).toBe('grid');
    });

    it('passes the other two configured layouts through', () => {
        expect(boardLayoutOf('columns')).toBe('columns');
        expect(boardLayoutOf('list')).toBe('list');
    });

    it('falls back to columns for a value it does not recognise', () => {
        // A wall screen must degrade to the card wall, never to a blank pane.
        expect(boardLayoutOf('kanban')).toBe('columns');
        expect(boardLayoutOf(null)).toBe('columns');
        expect(boardLayoutOf(undefined)).toBe('columns');
    });
});

describe('nextLayout', () => {
    it('cycles through all three and returns to the start', () => {
        // The old toggle was a two-way ternary, which is the other reason `grid` was unreachable:
        // even once the board could render it, no control could ask for it.
        expect(nextLayout('columns')).toBe('list');
        expect(nextLayout('list')).toBe('grid');
        expect(nextLayout('grid')).toBe('columns');
    });

    it('reaches every layout the board can render', () => {
        const seen = new Set<string>();
        let layout = BOARD_LAYOUTS[0]!;
        for (let i = 0; i < BOARD_LAYOUTS.length; i += 1) {
            seen.add(layout);
            layout = nextLayout(layout);
        }

        expect([...seen].sort()).toEqual(['columns', 'grid', 'list']);
    });
});

describe('rollUp', () => {
    it('aggregates the same item across orders into one row', () => {
        const items = rollUp(
            [
                order({ lines: [line({ quantity: '2.000' })] }),
                order({ lines: [line({ quantity: '3.000' })] }),
                order({ lines: [line({ quantity: '7.000' })] }),
            ],
            NOW,
        );

        expect(items).toHaveLength(1);
        expect(items[0]?.name).toBe('Frites');
        expect(items[0]?.quantity).toBe(12);
        expect(items[0]?.sources).toHaveLength(3);
    });

    it('aggregates two lines of the same item on one card', () => {
        // Nothing forbids a ticket carrying the same product twice — a re-fire produces exactly
        // that. Consolidating only across cards would leave "1 ×" twice on one row.
        const items = rollUp(
            [order({ lines: [line({ quantity: '2.000' }), line({ quantity: '1.000' })] })],
            NOW,
        );

        expect(items).toHaveLength(1);
        expect(items[0]?.quantity).toBe(3);
    });

    it('keeps items with different notes apart', () => {
        // The whole reason the key carries the note: "12 × frites" that silently includes one
        // "sans sel" is a portion plated wrong, and the cook never learns why.
        const items = rollUp(
            [
                order({ lines: [line({ quantity: '2.000' })] }),
                order({ lines: [line({ quantity: '1.000', customer_note: 'sans sel' })] }),
            ],
            NOW,
        );

        expect(items).toHaveLength(2);
        expect(items.find((item) => item.customerNote === 'sans sel')?.quantity).toBe(1);
        expect(items.find((item) => item.customerNote === null)?.quantity).toBe(2);
    });

    it('does not merge a name-and-note pair that concatenates to the same string', () => {
        // The separator has to be a character a product name cannot contain. With a space or a
        // pipe, "Pizza Reine"/no note and "Pizza"/note "Reine" key identically.
        const items = rollUp(
            [
                order({ lines: [line({ product_id: null, display_name: 'Pizza Reine' })] }),
                order({ lines: [line({ product_id: null, display_name: 'Pizza', customer_note: 'Reine' })] }),
            ],
            NOW,
        );

        expect(items).toHaveLength(2);
    });

    it('keeps different products apart even when they share a display name', () => {
        const items = rollUp(
            [
                order({ lines: [line({ product_id: 100, quantity: '2.000' })] }),
                order({ lines: [line({ product_id: 200, quantity: '5.000' })] }),
            ],
            NOW,
        );

        expect(items).toHaveLength(2);
        expect(items.map((item) => item.productId).sort()).toEqual([100, 200]);
    });

    it('counts only open work — a served line is already made', () => {
        const items = rollUp(
            [
                order({ lines: [line({ quantity: '4.000' })] }),
                order({ lines: [line({ quantity: '6.000', state: 'served' })] }),
            ],
            NOW,
        );

        expect(items).toHaveLength(1);
        expect(items[0]?.quantity).toBe(4);
    });

    it('excludes a cancellation row, however it is flagged', () => {
        // The server books a cancellation as a *new* prep line in state `todo` carrying
        // `change_type: 'cancelled'`. Reading `state` alone would count it as work to do and send
        // out a portion the customer called off.
        const items = rollUp(
            [
                order({ lines: [line({ quantity: '4.000' })] }),
                order({ lines: [line({ quantity: '2.000', state: 'todo', change_type: 'cancelled' })] }),
                order({ lines: [line({ quantity: '2.000', state: 'cancelled' })] }),
            ],
            NOW,
        );

        expect(items).toHaveLength(1);
        expect(items[0]?.quantity).toBe(4);
    });

    it('ignores a zero or negative quantity on an open line', () => {
        // Summing a signed correction would let it cancel a real portion out, and the item would
        // vanish from the pass entirely — the one outcome worse than a wrong number.
        const items = rollUp(
            [
                order({ lines: [line({ quantity: '3.000' })] }),
                order({ lines: [line({ quantity: '-1.000' })] }),
                order({ lines: [line({ quantity: '0.000' })] }),
            ],
            NOW,
        );

        expect(items).toHaveLength(1);
        expect(items[0]?.quantity).toBe(3);
    });

    it('survives an unparseable quantity rather than producing NaN', () => {
        const items = rollUp(
            [
                order({ lines: [line({ quantity: '2.000' })] }),
                order({ lines: [line({ quantity: 'x' })] }),
            ],
            NOW,
        );

        expect(items[0]?.quantity).toBe(2);
    });

    it('keeps a fractional total exact to the schema scale', () => {
        const items = rollUp(
            [
                order({ lines: [line({ quantity: '0.750' })] }),
                order({ lines: [line({ quantity: '0.500' })] }),
            ],
            NOW,
        );

        expect(items[0]?.quantity).toBe(1.25);
    });

    it('takes the age of the oldest contributing card', () => {
        // Half fresh and half fifteen minutes late is a late batch. Averaging would hide the
        // ticket that is actually in trouble.
        const items = rollUp(
            [
                order({ fired_at: '2026-07-28T11:59:00.000Z' }),
                order({ fired_at: '2026-07-28T11:40:00.000Z' }),
            ],
            NOW,
        );

        expect(items[0]?.oldestSeconds).toBe(20 * 60);
    });

    it('sorts oldest batch first, then biggest', () => {
        const items = rollUp(
            [
                order({
                    fired_at: '2026-07-28T11:59:00.000Z',
                    lines: [line({ product_id: 1, display_name: 'Salade', quantity: '9.000' })],
                }),
                order({
                    fired_at: '2026-07-28T11:40:00.000Z',
                    lines: [line({ product_id: 2, display_name: 'Soupe', quantity: '1.000' })],
                }),
                order({
                    fired_at: '2026-07-28T11:40:00.000Z',
                    lines: [line({ product_id: 3, display_name: 'Steak', quantity: '4.000' })],
                }),
            ],
            NOW,
        );

        expect(items.map((item) => item.name)).toEqual(['Steak', 'Soupe', 'Salade']);
    });

    it('lists each row’s tickets oldest first', () => {
        const recent = order({ fired_at: '2026-07-28T11:59:00.000Z' });
        const old = order({ fired_at: '2026-07-28T11:30:00.000Z' });
        const items = rollUp([recent, old], NOW);

        expect(items[0]?.sources.map((source) => source.orderId)).toEqual([old.id, recent.id]);
    });

    it('carries the order and line ids a cook needs to tick a ticket off', () => {
        // The chips are the roll-up's only affordance. Without a usable line id the layout is a
        // read-only poster and a cook has to switch layouts to bump anything.
        const only = line({ id: 4242, quantity: '2.000' });
        const card = order({ id: 77, tracking_number: '512', lines: [only] });
        const items = rollUp([card], NOW);

        expect(items[0]?.sources[0]).toMatchObject({ orderId: 77, lineId: 4242, label: '512', quantity: 2 });
    });

    it('labels a card with no tracking number by its id', () => {
        const items = rollUp([order({ id: 88, tracking_number: null })], NOW);

        expect(items[0]?.sources[0]?.label).toBe('#88');
    });

    it('produces no rows for a note-only ticket', () => {
        // A card with no lines owes no *items*. The card layouts remain where a note is read.
        expect(rollUp([order({ lines: [], order_note: 'allergie noix' })], NOW)).toEqual([]);
    });
});

describe('buildBoard exposes the roll-up from the same projection', () => {
    const build = (orders: KitchenOrder[], filter = EMPTY_FILTER) =>
        buildBoard({
            orders,
            stages: STAGES,
            filter,
            categoryOf: () => 7,
            thresholds: THRESHOLDS,
            now: NOW,
            doneRetentionMinutes: 60,
        });

    it('rolls up exactly what the list layout shows', () => {
        const view = build([
            order({ lines: [line({ quantity: '2.000' })] }),
            order({ lines: [line({ quantity: '5.000' })] }),
        ]);

        expect(view.list).toHaveLength(2);
        expect(view.rollUp).toHaveLength(1);
        expect(view.rollUp[0]?.quantity).toBe(7);
    });

    it('honours the category filter, so a filter cannot hide an item in one layout only', () => {
        // The invariant the projection exists for: three layouts, one pass, no disagreement about
        // what is on the board.
        const fryer = order({ lines: [line({ pos_category_id: 7, quantity: '3.000' })] });
        const bar = order({
            lines: [line({ pos_category_id: 9, display_name: 'Bière', product_id: 300, quantity: '4.000' })],
        });

        const view = build([fryer, bar], { ...EMPTY_FILTER, categoryIds: [9] });

        expect(view.rollUp).toHaveLength(1);
        expect(view.rollUp[0]?.name).toBe('Bière');
        expect(view.rollUp[0]?.quantity).toBe(4);
    });

    it('drops a served card from the roll-up as well as from the columns', () => {
        const view = build([
            order({
                state: 'served',
                served_at: '2026-07-28T11:59:00.000Z',
                lines: [line({ state: 'served', quantity: '6.000' })],
            }),
        ]);

        expect(view.list).toHaveLength(0);
        expect(view.recallable).toHaveLength(1);
        expect(view.rollUp).toEqual([]);
    });
});
