import { describe, expect, it } from 'vitest';

import type { KitchenLine, KitchenOrder, KitchenStage } from '../types';
import {
    EMPTY_FILTER,
    aggregateState,
    applyLineStateLocally,
    applyRecallLocally,
    applyStageLocally,
    applyTicketUpdate,
    buildBoard,
    effectiveStageId,
    filterLines,
    groupLinesByCourse,
    isCardComplete,
    isLineCancelled,
    isLineDone,
    isLineOpen,
    nextLineState,
    nextStage,
    previousStage,
    replayQueue,
    sortStages,
} from './board';
import { thresholdsFor } from './elapsed';

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
        display_name: 'Margherita',
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

function order(partial: Partial<KitchenOrder> = {}): KitchenOrder {
    return {
        id: 1,
        uuid: 'prep-1',
        prep_display_id: 2,
        pos_order_id: 55123,
        tracking_number: '412',
        table_label: 'T1',
        guest_count: 4,
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

describe('sortStages', () => {
    it('orders by sequence then id, without mutating the input', () => {
        const shuffled = [STAGES[3]!, STAGES[1]!, STAGES[0]!, STAGES[2]!];
        expect(sortStages(shuffled).map((s) => s.id)).toEqual([1, 2, 3, 4]);
        expect(shuffled[0]!.id).toBe(4);
    });

    it('breaks sequence ties deterministically', () => {
        const tied: KitchenStage[] = [
            { ...STAGES[0]!, id: 9, sequence: 10 },
            { ...STAGES[0]!, id: 3, sequence: 10 },
        ];
        expect(sortStages(tied).map((s) => s.id)).toEqual([3, 9]);
    });
});

describe('effectiveStageId', () => {
    it('places a card in the column of its least-advanced remaining line', () => {
        const card = order({
            lines: [
                line({ prep_stage_id: 3, state: 'ready' }),
                line({ prep_stage_id: 1, state: 'todo' }),
                line({ prep_stage_id: 3, state: 'ready' }),
            ],
        });
        expect(effectiveStageId(card, STAGES)).toBe(1);
    });

    it('uses the most advanced line once everything is finished', () => {
        const card = order({
            lines: [
                line({ prep_stage_id: 3, state: 'served' }),
                line({ prep_stage_id: 4, state: 'served' }),
            ],
        });
        expect(effectiveStageId(card, STAGES)).toBe(4);
    });

    it('ignores cancelled lines when deciding the column', () => {
        const card = order({
            lines: [
                line({ prep_stage_id: 1, state: 'cancelled', change_type: 'cancelled' }),
                line({ prep_stage_id: 3, state: 'ready' }),
            ],
        });
        expect(effectiveStageId(card, STAGES)).toBe(3);
    });

    // KDS-016 — the server books a cancellation as a *todo* row sitting in the To-Do stage. Counting
    // it as the least-advanced line parked the whole card in that column however far along the real
    // food was, which is the bug the cook actually sees.
    it('ignores a cancellation row that is still in the todo stage', () => {
        const card = order({
            lines: [
                line({ prep_stage_id: 1, state: 'todo', change_type: 'cancelled' }),
                line({ prep_stage_id: 3, state: 'ready' }),
            ],
        });
        expect(effectiveStageId(card, STAGES)).toBe(3);
    });

    it('uses the most advanced line when a cancellation row is all that is left open', () => {
        const card = order({
            lines: [
                line({ prep_stage_id: 1, state: 'todo', change_type: 'cancelled' }),
                line({ prep_stage_id: 4, state: 'served' }),
            ],
        });
        expect(effectiveStageId(card, STAGES)).toBe(4);
    });

    it('falls back to the line state when the stage belongs to another display', () => {
        const card = order({ lines: [line({ prep_stage_id: 999, state: 'in_progress' })] });
        expect(effectiveStageId(card, STAGES)).toBe(2);
    });

    it('uses the card state for a ticket with no lines', () => {
        expect(effectiveStageId(order({ lines: [], state: 'ready' }), STAGES)).toBe(3);
    });

    it('returns null when the display has no stages at all', () => {
        expect(effectiveStageId(order(), [])).toBeNull();
    });
});

describe('nextStage / previousStage', () => {
    it('walks the ladder', () => {
        expect(nextStage(STAGES, 1)?.id).toBe(2);
        expect(nextStage(STAGES, 4)).toBeNull();
        expect(previousStage(STAGES, 3)?.id).toBe(2);
        expect(previousStage(STAGES, 1)).toBeNull();
    });

    it('starts at the first stage for an unknown current stage', () => {
        expect(nextStage(STAGES, 999)?.id).toBe(1);
    });
});

describe('filterLines', () => {
    const categoryOf = (productId: number | null | undefined): number | null =>
        productId === 100 ? 7 : productId === 200 ? 8 : null;

    it('passes everything through with an empty filter', () => {
        const lines = [line({ product_id: 100 }), line({ product_id: 200 })];
        expect(filterLines(lines, EMPTY_FILTER, categoryOf)).toHaveLength(2);
    });

    it('filters by category, resolving the product when the line carries none', () => {
        const lines = [line({ product_id: 100 }), line({ product_id: 200 })];
        const kept = filterLines(lines, { ...EMPTY_FILTER, categoryIds: [8] }, categoryOf);
        expect(kept.map((l) => l.product_id)).toEqual([200]);
    });

    it('prefers the category the payload carries over the catalog lookup', () => {
        const lines = [line({ product_id: 100, pos_category_id: 8 })];
        expect(filterLines(lines, { ...EMPTY_FILTER, categoryIds: [8] }, categoryOf)).toHaveLength(1);
    });

    it('filters by course', () => {
        const lines = [line({ course_index: 1 }), line({ course_index: 2 }), line({ course_index: null })];
        expect(filterLines(lines, { ...EMPTY_FILTER, courseIndex: 2 }, categoryOf)).toHaveLength(1);
    });
});

describe('buildBoard', () => {
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

    it('splits open cards into stage columns and a flat list', () => {
        const board = build([
            order({ id: 1, lines: [line({ prep_stage_id: 1, state: 'todo' })] }),
            order({ id: 2, state: 'in_progress', lines: [line({ prep_stage_id: 2, state: 'in_progress' })] }),
        ]);

        expect(board.columns.map((c) => c.orders.map((o) => o.id))).toEqual([[1], [2], [], []]);
        expect(board.list.map((o) => o.id)).toEqual([1, 2]);
        expect(board.recallable).toHaveLength(0);
    });

    it('sorts every column oldest-first', () => {
        const board = build([
            order({ id: 1, fired_at: '2026-07-28T11:59:00.000Z' }),
            order({ id: 2, fired_at: '2026-07-28T11:50:00.000Z' }),
            order({ id: 3, fired_at: '2026-07-28T11:55:00.000Z' }),
        ]);
        expect(board.list.map((o) => o.id)).toEqual([2, 3, 1]);
    });

    it('moves served cards to the recall bar, most recent first', () => {
        const board = build([
            order({ id: 1, state: 'served', served_at: '2026-07-28T11:59:00.000Z', fired_at: '2026-07-28T11:58:00.000Z' }),
            order({ id: 2, state: 'served', served_at: '2026-07-28T11:30:00.000Z', fired_at: '2026-07-28T11:20:00.000Z' }),
        ]);
        expect(board.list).toHaveLength(0);
        expect(board.recallable.map((o) => o.id)).toEqual([1, 2]);
    });

    it('drops completed cards past the retention window', () => {
        const board = buildBoard({
            orders: [order({ id: 1, state: 'served', served_at: '2026-07-28T10:00:00.000Z' })],
            stages: STAGES,
            filter: EMPTY_FILTER,
            categoryOf: () => 7,
            thresholds: THRESHOLDS,
            now: NOW,
            doneRetentionMinutes: 60,
        });
        expect(board.recallable).toHaveLength(0);
    });

    it('hides a card whose every line was filtered out', () => {
        const board = buildBoard({
            orders: [order({ id: 1, lines: [line({ product_id: 100 })] })],
            stages: STAGES,
            filter: { ...EMPTY_FILTER, categoryIds: [99] },
            categoryOf: () => 7,
            thresholds: THRESHOLDS,
            now: NOW,
            doneRetentionMinutes: 60,
        });
        expect(board.list).toHaveLength(0);
    });

    it('keeps only late cards under the late-only filter', () => {
        const board = build(
            [
                order({ id: 1, fired_at: '2026-07-28T11:59:00.000Z' }), // 1 min
                order({ id: 2, fired_at: '2026-07-28T11:40:00.000Z' }), // 20 min → late
            ],
            { ...EMPTY_FILTER, lateOnly: true },
        );
        expect(board.list.map((o) => o.id)).toEqual([2]);
    });

    it('never mutates the orders it is given', () => {
        const source = order({ id: 1, lines: [line({ product_id: 100 }), line({ product_id: 200 })] });
        buildBoard({
            orders: [source],
            stages: STAGES,
            filter: { ...EMPTY_FILTER, categoryIds: [7] },
            categoryOf: (id) => (id === 100 ? 7 : 8),
            thresholds: THRESHOLDS,
            now: NOW,
            doneRetentionMinutes: 60,
        });
        expect(source.lines).toHaveLength(2);
    });
});

describe('groupLinesByCourse', () => {
    it('groups by course index with un-coursed lines last', () => {
        const groups = groupLinesByCourse([
            line({ course_index: 2 }),
            line({ course_index: null }),
            line({ course_index: 1 }),
            line({ course_index: 2 }),
        ]);
        expect(groups.map((g) => g.courseIndex)).toEqual([1, 2, null]);
        expect(groups[1]!.lines).toHaveLength(2);
    });
});

describe('aggregateState', () => {
    it('is the least-advanced active line', () => {
        expect(aggregateState({ state: 'ready', lines: [line({ state: 'todo' }), line({ state: 'ready' })] })).toBe('pending');
        expect(
            aggregateState({ state: 'pending', lines: [line({ state: 'in_progress' }), line({ state: 'ready' })] }),
        ).toBe('in_progress');
        expect(aggregateState({ state: 'pending', lines: [line({ state: 'ready' }), line({ state: 'served' })] })).toBe('ready');
        expect(aggregateState({ state: 'pending', lines: [line({ state: 'served' })] })).toBe('served');
    });

    it('is cancelled only when every line is cancelled', () => {
        expect(aggregateState({ state: 'pending', lines: [line({ state: 'cancelled' })] })).toBe('cancelled');
        expect(
            aggregateState({ state: 'pending', lines: [line({ state: 'cancelled' }), line({ state: 'todo' })] }),
        ).toBe('pending');
    });

    // KDS-016 — the server books a cancellation as a *new* prep line with `change_type: 'cancelled'`
    // in state `todo`. That row is an instruction to stop cooking, not something to cook.
    describe('a cancellation row is not open work (KDS-016)', () => {
        const cancellation = (): KitchenLine => line({ state: 'todo', change_type: 'cancelled' });

        it('lets the rest of the card reach served with no cook interaction on it', () => {
            expect(
                aggregateState({ state: 'pending', lines: [line({ state: 'served' }), cancellation()] }),
            ).toBe('served');
        });

        it('does not hold the card at pending', () => {
            expect(
                aggregateState({ state: 'pending', lines: [line({ state: 'ready' }), cancellation()] }),
            ).toBe('ready');
            expect(
                aggregateState({ state: 'pending', lines: [line({ state: 'in_progress' }), cancellation()] }),
            ).toBe('in_progress');
        });

        it('is cancelled when the cancellation row is all that is left', () => {
            expect(aggregateState({ state: 'pending', lines: [cancellation()] })).toBe('cancelled');
        });

        it('still counts a genuine todo line as open work', () => {
            expect(
                aggregateState({ state: 'pending', lines: [line({ state: 'todo' }), cancellation()] }),
            ).toBe('pending');
        });
    });
});

describe('optimistic mutation', () => {
    const nowIso = '2026-07-28T12:00:00.000Z';

    it('bumps every non-cancelled line with the card', () => {
        const card = order({
            lines: [line({ state: 'todo' }), line({ state: 'cancelled', change_type: 'cancelled' })],
        });
        const bumped = applyStageLocally(card, STAGES[2]!, nowIso);
        expect(bumped.state).toBe('ready');
        expect(bumped.lines[0]!.state).toBe('ready');
        expect(bumped.lines[0]!.prep_stage_id).toBe(3);
        expect(bumped.lines[1]!.state).toBe('cancelled');
        expect(bumped.ready_at).toBe(nowIso);
    });

    it('re-derives the card state from a single line change', () => {
        const card = order({ lines: [line({ id: 11, state: 'todo' }), line({ id: 12, state: 'todo' })] });
        const once = applyLineStateLocally(card, 11, 'ready', nowIso);
        expect(once.state).toBe('pending');
        const twice = applyLineStateLocally(once, 12, 'ready', nowIso);
        expect(twice.state).toBe('ready');
    });

    it('recalls a card to the first stage and flags it', () => {
        const card = order({ state: 'served', served_at: nowIso, lines: [line({ state: 'served', prep_stage_id: 4 })] });
        const recalled = applyRecallLocally(card, STAGES);
        expect(recalled.state).toBe('pending');
        expect(recalled.is_recalled).toBe(true);
        expect(recalled.served_at).toBeNull();
        expect(recalled.lines[0]!.prep_stage_id).toBe(1);
        expect(recalled.lines[0]!.state).toBe('todo');
    });

    it('walks the per-line ladder and stops at the end', () => {
        expect(nextLineState('todo')).toBe('in_progress');
        expect(nextLineState('ready')).toBe('served');
        expect(nextLineState('served')).toBe('served');
        expect(nextLineState('cancelled')).toBe('cancelled');
    });
});

describe('applyTicketUpdate', () => {
    it('narrows the lines it mentions and leaves the rest alone', () => {
        const card = order({ lines: [line({ id: 11, state: 'todo' }), line({ id: 12, state: 'todo' })] });
        const updated = applyTicketUpdate(card, {
            v: 1,
            prep_order_id: 1,
            prep_order_uuid: 'prep-1',
            state: 'in_progress',
            lines: [{ id: 11, uuid: card.lines[0]!.uuid, pos_order_line_uuid: 'pol', state: 'ready' }],
            recalled: false,
        });
        expect(updated.lines[0]!.state).toBe('ready');
        expect(updated.lines[1]!.state).toBe('todo');
        expect(updated.state).toBe('in_progress');
    });

    it('matches by uuid when the server sends a different id space', () => {
        const card = order({ lines: [line({ id: 11, uuid: 'known' })] });
        const updated = applyTicketUpdate(card, {
            v: 1,
            prep_order_id: 1,
            prep_order_uuid: 'prep-1',
            state: 'ready',
            lines: [{ id: -1, uuid: 'known', pos_order_line_uuid: 'pol', state: 'ready' }],
            recalled: false,
        });
        expect(updated.lines[0]!.state).toBe('ready');
    });
});

describe('replayQueue', () => {
    const nowIso = '2026-07-28T12:00:00.000Z';

    it('re-applies unacknowledged bumps on top of a fresh server board', () => {
        const server = [order({ id: 1, state: 'pending', lines: [line({ id: 11, state: 'todo' })] })];
        const replayed = replayQueue(server, STAGES, [{ kind: 'stage', prepOrderId: 1, stageId: 2 }], nowIso);
        expect(replayed[0]!.state).toBe('in_progress');
    });

    it('re-applies a queued per-line change by line id', () => {
        const server = [order({ id: 1, lines: [line({ id: 11, state: 'todo' }), line({ id: 12, state: 'todo' })] })];
        const replayed = replayQueue(server, STAGES, [{ kind: 'line', lineId: 12, state: 'ready' }], nowIso);
        expect(replayed[0]!.lines[1]!.state).toBe('ready');
    });

    it('drops queued actions for cards the server no longer knows about', () => {
        const server = [order({ id: 1 })];
        const replayed = replayQueue(server, STAGES, [{ kind: 'stage', prepOrderId: 99, stageId: 2 }], nowIso);
        expect(replayed).toHaveLength(1);
        expect(replayed[0]!.state).toBe('pending');
    });

    it('returns a copy when the queue is empty', () => {
        const server = [order({ id: 1 })];
        const replayed = replayQueue(server, STAGES, [], nowIso);
        expect(replayed).toEqual(server);
        expect(replayed).not.toBe(server);
    });
});

describe('isCardComplete', () => {
    it('is false for an empty card and true when nothing is left to make', () => {
        expect(isCardComplete({ lines: [] })).toBe(false);
        expect(isCardComplete({ lines: [line({ state: 'served' }), line({ state: 'cancelled' })] })).toBe(true);
        expect(isCardComplete({ lines: [line({ state: 'served' }), line({ state: 'ready' })] })).toBe(false);
    });

    // KDS-016 — this gates whether the card can be cleared off the board at all.
    it('lets a card clear when the only unfinished row is a cancellation', () => {
        expect(
            isCardComplete({ lines: [line({ state: 'served' }), line({ state: 'todo', change_type: 'cancelled' })] }),
        ).toBe(true);
    });

    it('still refuses to clear while real food is outstanding', () => {
        expect(
            isCardComplete({ lines: [line({ state: 'ready' }), line({ state: 'todo', change_type: 'cancelled' })] }),
        ).toBe(false);
    });
});

describe('isLineOpen', () => {
    it('is the one answer the card state, the column and the clear check all use (KDS-016)', () => {
        expect(isLineOpen(line({ state: 'todo' }))).toBe(true);
        expect(isLineOpen(line({ state: 'in_progress' }))).toBe(true);
        expect(isLineOpen(line({ state: 'ready' }))).toBe(true);
        expect(isLineOpen(line({ state: 'served' }))).toBe(false);
        expect(isLineOpen(line({ state: 'cancelled' }))).toBe(false);
        // The shape the server actually writes a cancellation in.
        expect(isLineOpen(line({ state: 'todo', change_type: 'cancelled' }))).toBe(false);
    });

    it('keeps "finished" and "cancelled" distinct for the line styling', () => {
        // isLineDone answers a different question on purpose: the cook needs to tell "I cooked
        // that" from "that was called off".
        expect(isLineDone(line({ state: 'todo', change_type: 'cancelled' }))).toBe(false);
        expect(isLineCancelled(line({ state: 'todo', change_type: 'cancelled' }))).toBe(true);
    });
});
