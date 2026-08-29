import type { PrepStageType } from '@domain/enums';

import type {
    KitchenLine,
    KitchenLineState,
    KitchenOrder,
    KitchenStage,
    KitchenTicketUpdate,
} from '../types';
import { elapsedSeconds, isOpenOrder, urgencyOf, type UrgencyThresholds } from './elapsed';

/**
 * Turning the flat board payload into something a cook can read (KDS-005, KDS-007, KDS-012,
 * KDS-013, KDS-021).
 *
 * Every function here is pure and takes `now` explicitly. The board is the one part of a KDS that
 * absolutely must not have bugs — a card in the wrong column is food that never gets made — so it
 * is separated from React entirely and unit-tested against fixtures.
 */

/** A line is only *work* while it is neither served nor cancelled. */
const DONE_LINE_STATES = new Set<KitchenLineState>(['served', 'cancelled']);

/**
 * Is this line still work the kitchen owes? The single answer, used by everything that asks —
 * the card's state, the column it renders in, and whether it can be cleared (KDS-016).
 *
 * It has to be one function. "Done" is *not* a property of `state` alone: the server books a
 * cancellation as a new prep line carrying `change_type: 'cancelled'` in state `todo`, which is an
 * instruction to stop cooking rather than something to cook. When that rule lived in three places,
 * two of them had it wrong — the card reported "served" while still sitting in the To-Do column and
 * refusing to clear.
 */
export function isLineOpen(line: Pick<KitchenLine, 'state' | 'change_type'>): boolean {
    return !DONE_LINE_STATES.has(line.state) && !isLineCancelled(line);
}

/** How the per-line states map onto the four stage types when a stage id is unusable. */
const STATE_TO_STAGE_TYPE: Record<KitchenLineState, PrepStageType> = {
    todo: 'todo',
    in_progress: 'in_progress',
    ready: 'ready',
    served: 'done',
    cancelled: 'done',
};

export type CategoryResolver = (productId: number | null | undefined) => number | null;

export type BoardFilter = {
    /** Empty = no category filter. Ids are `pos_categories.id`. */
    categoryIds: readonly number[];
    /** Show only cards at or past the late threshold. */
    lateOnly: boolean;
    /** `null` = every course. */
    courseIndex: number | null;
    /**
     * Service modes to show — "just the takeaways" (KDS-012). Empty = all.
     *
     * Matched against `preset_label`, which is a *label* and not an id: the board reads a
     * denormalised snapshot of what the order was taken as, so that renaming a preset later does
     * not retroactively change what a card says it was.
     */
    presets: readonly string[];
};

export const EMPTY_FILTER: BoardFilter = { categoryIds: [], lateOnly: false, courseIndex: null, presets: [] };

export type StageColumn = {
    stage: KitchenStage;
    orders: KitchenOrder[];
};

export type CourseGroup = {
    /** `null` for lines that belong to no course (counter service, or a single-course tab). */
    courseIndex: number | null;
    lines: KitchenLine[];
};

/** Stages in board order. The server sequences them; ties fall back to id for determinism. */
export function sortStages(stages: readonly KitchenStage[]): KitchenStage[] {
    return [...stages].sort((a, b) => a.sequence - b.sequence || a.id - b.id);
}

export function stageById(stages: readonly KitchenStage[], id: number | null): KitchenStage | null {
    if (id === null) return null;
    return stages.find((stage) => stage.id === id) ?? null;
}

/**
 * Which column a card belongs in.
 *
 * A card is not a single state — it is N lines, each with its own stage, and the classic KDS bug is
 * to show a card as "ready" because the last line touched happened to be ready. The rule that
 * matches how a pass actually works: **a card sits in the column of its least-advanced remaining
 * line**. Ten items with nine plated and one still on the grill is not a ready ticket.
 *
 * When every line is finished the card takes the stage of its *most* advanced line, so a completed
 * ticket lands in "served" rather than falling back to "to do".
 */
export function effectiveStageId(order: KitchenOrder, stages: readonly KitchenStage[]): number | null {
    const ordered = sortStages(stages);
    if (ordered.length === 0) return null;

    const rank = new Map<number, number>(ordered.map((stage, index) => [stage.id, index]));
    const byType = new Map<PrepStageType, KitchenStage>();
    for (const stage of ordered) if (!byType.has(stage.stage_type)) byType.set(stage.stage_type, stage);

    const rankOf = (line: KitchenLine): number | null => {
        const direct = rank.get(line.prep_stage_id);
        if (direct !== undefined) return direct;
        // The line points at a stage this display does not own (reconfigured mid-service).
        // Fall back to the line's own state, which is always meaningful.
        const fallback = byType.get(STATE_TO_STAGE_TYPE[line.state]);
        return fallback ? (rank.get(fallback.id) ?? null) : null;
    };

    let lowestOpen: number | null = null;
    let highestAny: number | null = null;

    for (const line of order.lines) {
        const lineRank = rankOf(line);
        if (lineRank === null) continue;
        if (highestAny === null || lineRank > highestAny) highestAny = lineRank;
        // A cancellation row sits in the To-Do stage but is not open work: counting it here parked
        // the whole card in the To-Do column however far along the real food was (KDS-016).
        if (!isLineOpen(line)) continue;
        if (lowestOpen === null || lineRank < lowestOpen) lowestOpen = lineRank;
    }

    const index = lowestOpen ?? highestAny;
    if (index === null) {
        // No lines at all (a note-only ticket): use the card's own state.
        const stage = byType.get(STATE_TO_STAGE_TYPE[(order.state as KitchenLineState) ?? 'todo']);
        return stage?.id ?? ordered[0]?.id ?? null;
    }
    return ordered[index]?.id ?? null;
}

export function nextStage(stages: readonly KitchenStage[], currentId: number | null): KitchenStage | null {
    const ordered = sortStages(stages);
    const index = ordered.findIndex((stage) => stage.id === currentId);
    if (index === -1) return ordered[0] ?? null;
    return ordered[index + 1] ?? null;
}

export function previousStage(stages: readonly KitchenStage[], currentId: number | null): KitchenStage | null {
    const ordered = sortStages(stages);
    const index = ordered.findIndex((stage) => stage.id === currentId);
    if (index <= 0) return null;
    return ordered[index - 1] ?? null;
}

/**
 * Lines this display should render, after the user's filters.
 *
 * Server-side routing already restricted the *ticket* to this station (KDS-004); this is the cook's
 * own narrowing on top — "just show me the fryer" — plus the course filter.
 */
export function filterLines(
    lines: readonly KitchenLine[],
    filter: BoardFilter,
    categoryOf: CategoryResolver,
): KitchenLine[] {
    const categories = filter.categoryIds;
    return lines.filter((line) => {
        if (filter.courseIndex !== null && (line.course_index ?? null) !== filter.courseIndex) return false;
        if (categories.length === 0) return true;
        const categoryId = line.pos_category_id ?? categoryOf(line.product_id);
        return categoryId !== null && categories.includes(categoryId);
    });
}

export type BoardView = {
    stages: KitchenStage[];
    columns: StageColumn[];
    /** Flat, oldest first — what the `list` layout renders (KDS-013). */
    list: KitchenOrder[];
    /** Cards recently completed, newest first — the recall bar (KDS-021). */
    recallable: KitchenOrder[];
    /**
     * Identical items consolidated across cards — what the `grid` layout renders (KDS-013).
     *
     * Derived from `list`, not from the raw orders, so the roll-up can never disagree with the
     * other two layouts about what is on the board.
     */
    rollUp: RollUpItem[];
};

export type BuildBoardOptions = {
    orders: readonly KitchenOrder[];
    stages: readonly KitchenStage[];
    filter: BoardFilter;
    categoryOf: CategoryResolver;
    thresholds: UrgencyThresholds;
    now: number;
    /** Completed cards older than this drop off the recall bar. */
    doneRetentionMinutes: number;
};

/**
 * The single projection every layout renders from.
 *
 * Producing columns, the flat list and the roll-up in one pass keeps the three layouts provably
 * consistent: a ticket hidden by a filter in one is hidden in the others, and the recall bar can
 * never disagree with the board about which cards are finished.
 */
export function buildBoard(options: BuildBoardOptions): BoardView {
    const { orders, filter, categoryOf, thresholds, now, doneRetentionMinutes } = options;
    const stages = sortStages(options.stages);

    const columns: StageColumn[] = stages.map((stage) => ({ stage, orders: [] }));
    const columnByStage = new Map<number, StageColumn>(columns.map((column) => [column.stage.id, column]));

    const list: KitchenOrder[] = [];
    const recallable: KitchenOrder[] = [];
    const retentionMs = Math.max(0, doneRetentionMinutes) * 60_000;

    for (const order of orders) {
        const lines = filterLines(order.lines, filter, categoryOf);
        // A card whose every line was filtered out is not this cook's problem right now.
        if (lines.length === 0 && order.lines.length > 0) continue;

        const projected: KitchenOrder = lines === order.lines ? order : { ...order, lines };
        const open = isOpenOrder(projected);

        if (!open) {
            const finishedAt = Date.parse(projected.served_at ?? projected.ready_at ?? projected.fired_at ?? '');
            const withinRetention = !Number.isFinite(finishedAt) || now - finishedAt <= retentionMs;
            if (withinRetention) recallable.push(projected);
            continue;
        }

        // Order-level, so it belongs here rather than in `filterLines`: the service mode is a
        // property of the whole ticket, and filtering it line by line would leave a card with no
        // lines that the loop above has already decided to keep.
        if (filter.presets.length > 0 && !filter.presets.includes(order.preset_label ?? '')) continue;

        if (filter.lateOnly) {
            const level = urgencyOf(elapsedSeconds(projected, now), thresholds);
            if (level !== 'late' && level !== 'urgent') continue;
        }

        list.push(projected);
        const stageId = effectiveStageId(projected, stages);
        const column = stageId === null ? columns[0] : (columnByStage.get(stageId) ?? columns[0]);
        column?.orders.push(projected);
    }

    // Oldest first everywhere: the thing that has been waiting longest is the thing to cook next.
    const byAge = (a: KitchenOrder, b: KitchenOrder): number =>
        elapsedSeconds(b, now) - elapsedSeconds(a, now) || a.id - b.id;
    for (const column of columns) column.orders.sort(byAge);
    list.sort(byAge);
    // The recall bar is the opposite: most recently bumped first, because that is the mistake
    // somebody is running back to fix.
    recallable.sort((a, b) => elapsedSeconds(a, now) - elapsedSeconds(b, now) || b.id - a.id);

    return { stages, columns, list, recallable, rollUp: rollUp(list, now) };
}

// ─────────────────────────────────────────────────────────────────────────────
// The roll-up (KDS-013)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three board layouts a `prep_displays.layout` can ask for.
 *
 * `grid` was already a valid enum case, allowed by the check constraint, documented in the schema,
 * validated on save, offered in the back-office picker and written by the seeder for the bar
 * screen — and then collapsed to `columns` on the way into the board, so an operator who chose
 * "Grille" silently got the card wall. The value was never the missing part; reading it was.
 */
export type BoardLayout = 'columns' | 'grid' | 'list';

/** Toggle order. Columns is the pass's default, so the cycle starts and returns there. */
export const BOARD_LAYOUTS: readonly BoardLayout[] = ['columns', 'list', 'grid'];

/**
 * Normalise whatever the server — or a preference row written by an older build — hands us.
 *
 * Unknown values fall back to `columns` rather than throwing: the board is a wall screen, and a
 * layout string nobody recognises has to degrade to the card wall, not to a blank pane.
 */
export function boardLayoutOf(value: string | null | undefined): BoardLayout {
    return value === 'grid' || value === 'list' ? value : 'columns';
}

export function nextLayout(layout: BoardLayout): BoardLayout {
    const index = BOARD_LAYOUTS.indexOf(layout);
    return BOARD_LAYOUTS[(index + 1) % BOARD_LAYOUTS.length] ?? 'columns';
}

/** One card's contribution to a roll-up row — the ticket a cook ticks off when that portion is up. */
export type RollUpSource = {
    orderId: number;
    lineId: number;
    /** What the pass calls this card: its tracking number, or `#id` when it has none. */
    label: string;
    quantity: number;
    state: KitchenLineState;
    ageSeconds: number;
};

/** "12 × frites" — one line of production work, however many tickets asked for it. */
export type RollUpItem = {
    key: string;
    productId: number | null;
    name: string;
    customerNote: string | null;
    internalNote: string | null;
    /** Total still owed. Only open work is counted, so this is always positive. */
    quantity: number;
    /** Contributing cards, oldest first. */
    sources: RollUpSource[];
    /** Age of the oldest card owing this item — what the row's urgency is judged on. */
    oldestSeconds: number;
};

/**
 * What makes two lines "the same thing to make".
 *
 * Product **and** notes, for the same reason the register's change-delta engine keys on uuid+note:
 * a "no basil" margherita is not a margherita, and folding the two into one row of "3 ×" is how an
 * allergy order gets plated wrong. A line with no product id falls back to its display name, which
 * is all a free-text line has.
 */
function rollUpKey(line: KitchenLine): string {
    // NUL as the separator rather than a space or a pipe: a product called "Pizza Reine" with no
    // note must not key the same as a "Pizza" carrying the note "Reine". Every printable separator
    // is a character a product name is allowed to contain.
    return [
        line.product_id ?? 'x',
        line.display_name,
        line.customer_note ?? '',
        line.internal_note ?? '',
    ].join('\u0000');
}

/** Quantities are decimal strings on the wire; three places is the schema's scale. */
function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}

/**
 * Consolidate identical items across cards (KDS-013).
 *
 * Only *open* lines are counted. A served line is work already done and a cancelled one is work
 * called off — either of them inflating "12 × frites" would send out a batch nobody ordered, which
 * is the exact failure a production view exists to prevent.
 *
 * A card with no open lines therefore contributes no row, so a note-only ticket does not appear
 * here at all. That is deliberate: the roll-up answers "what do I cook next", and the two card
 * layouts remain where a cook reads a ticket in full.
 */
export function rollUp(orders: readonly KitchenOrder[], now: number): RollUpItem[] {
    const byKey = new Map<string, RollUpItem>();

    for (const order of orders) {
        const ageSeconds = elapsedSeconds(order, now);
        const label = order.tracking_number ?? `#${order.id}`;

        for (const line of order.lines) {
            if (!isLineOpen(line)) continue;

            const quantity = Number.parseFloat(line.quantity);
            // A zero or negative quantity on an open line is not work to do. Summing it would let a
            // correction row cancel a real one out and drop the item off the pass entirely.
            if (!Number.isFinite(quantity) || quantity <= 0) continue;

            const source: RollUpSource = {
                orderId: order.id,
                lineId: line.id,
                label,
                quantity: round3(quantity),
                state: line.state,
                ageSeconds,
            };

            const key = rollUpKey(line);
            const existing = byKey.get(key);

            if (existing) {
                existing.quantity = round3(existing.quantity + quantity);
                existing.sources.push(source);
                if (ageSeconds > existing.oldestSeconds) existing.oldestSeconds = ageSeconds;
                continue;
            }

            byKey.set(key, {
                key,
                productId: line.product_id ?? null,
                name: line.display_name,
                customerNote: line.customer_note,
                internalNote: line.internal_note,
                quantity: round3(quantity),
                sources: [source],
                oldestSeconds: ageSeconds,
            });
        }
    }

    const items = [...byKey.values()];

    // Oldest first, exactly as the card layouts sort: the batch somebody has been waiting longest
    // for is the batch to start. Size breaks the tie, so the bigger batch of two equally old rows
    // comes first — that is the whole economy of cooking to a roll-up.
    for (const item of items) {
        item.sources.sort((a, b) => b.ageSeconds - a.ageSeconds || a.orderId - b.orderId);
    }
    items.sort(
        (a, b) =>
            b.oldestSeconds - a.oldestSeconds ||
            b.quantity - a.quantity ||
            a.name.localeCompare(b.name) ||
            (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );

    return items;
}

/** Course headers on a card (KDS-007). Courses ascend; un-coursed lines sort last. */
export function groupLinesByCourse(lines: readonly KitchenLine[]): CourseGroup[] {
    const groups = new Map<number | null, KitchenLine[]>();
    for (const line of lines) {
        const key = line.course_index ?? null;
        const bucket = groups.get(key);
        if (bucket) bucket.push(line);
        else groups.set(key, [line]);
    }

    return [...groups.entries()]
        .map(([courseIndex, courseLines]) => ({ courseIndex, lines: courseLines }))
        .sort((a, b) => {
            if (a.courseIndex === b.courseIndex) return 0;
            if (a.courseIndex === null) return 1;
            if (b.courseIndex === null) return -1;
            return a.courseIndex - b.courseIndex;
        });
}

/** True when nothing on the card is still work — drives the "all done" affordance. */
export function isCardComplete(order: Pick<KitchenOrder, 'lines'>): boolean {
    if (order.lines.length === 0) return false;
    return order.lines.every((line) => !isLineOpen(line));
}

/**
 * Is this line *finished*, as opposed to cancelled? Drives the struck-through vs ticked styling, so
 * unlike {@link isLineOpen} it deliberately does not fold the two together — the cook needs to see
 * the difference between "I cooked that" and "that was called off".
 */
export function isLineDone(line: Pick<KitchenLine, 'state'>): boolean {
    return DONE_LINE_STATES.has(line.state);
}

/** A cancelled line is struck through and shouted about, never removed (KDS-016). */
export function isLineCancelled(line: Pick<KitchenLine, 'state' | 'change_type'>): boolean {
    return line.state === 'cancelled' || line.change_type === 'cancelled';
}

export function isLineChanged(line: Pick<KitchenLine, 'change_type'>): boolean {
    return line.change_type === 'note_update';
}

/** The next per-line state when a cook taps a row: todo → in progress → ready → served. */
export function nextLineState(state: KitchenLineState): KitchenLineState {
    switch (state) {
        case 'todo':
            return 'in_progress';
        case 'in_progress':
            return 'ready';
        case 'ready':
            return 'served';
        case 'served':
        case 'cancelled':
            return state;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Optimistic mutation (KDS-020)
// ─────────────────────────────────────────────────────────────────────────────

const STAGE_TYPE_TO_ORDER_STATE: Record<PrepStageType, KitchenOrder['state']> = {
    todo: 'pending',
    in_progress: 'in_progress',
    ready: 'ready',
    done: 'served',
};

const STAGE_TYPE_TO_LINE_STATE: Record<PrepStageType, KitchenLineState> = {
    todo: 'todo',
    in_progress: 'in_progress',
    ready: 'ready',
    done: 'served',
};

/**
 * Move a whole card to a stage locally, exactly as the server will (spec §9: "bump the whole card.
 * Every line follows"). Cancelled lines are left alone — a cancellation is not undone by a bump.
 */
export function applyStageLocally(
    order: KitchenOrder,
    stage: KitchenStage,
    nowIso: string,
): KitchenOrder {
    const lineState = STAGE_TYPE_TO_LINE_STATE[stage.stage_type];
    // Advancing the whole card must not drag a cancellation along with it (KDS-016).
    const lines = order.lines.map((line) =>
        isLineCancelled(line)
            ? line
            : {
                  ...line,
                  prep_stage_id: stage.id,
                  state: lineState,
                  started_at: lineState === 'todo' ? null : (line.started_at ?? nowIso),
                  ready_at: lineState === 'ready' || lineState === 'served' ? (line.ready_at ?? nowIso) : null,
                  served_at: lineState === 'served' ? (line.served_at ?? nowIso) : null,
              },
    );

    const state = STAGE_TYPE_TO_ORDER_STATE[stage.stage_type];
    return {
        ...order,
        state,
        lines,
        first_started_at: state === 'pending' ? null : (order.first_started_at ?? nowIso),
        ready_at: state === 'ready' || state === 'served' ? (order.ready_at ?? nowIso) : null,
        served_at: state === 'served' ? (order.served_at ?? nowIso) : null,
    };
}

/** Per-item done toggle (KDS-010). The card state is re-derived, never set directly. */
export function applyLineStateLocally(
    order: KitchenOrder,
    lineId: number,
    state: KitchenLineState,
    nowIso: string,
): KitchenOrder {
    const lines = order.lines.map((line) =>
        line.id === lineId
            ? {
                  ...line,
                  state,
                  started_at: state === 'todo' ? null : (line.started_at ?? nowIso),
                  ready_at: state === 'ready' || state === 'served' ? (line.ready_at ?? nowIso) : null,
                  served_at: state === 'served' ? (line.served_at ?? nowIso) : null,
              }
            : line,
    );
    return { ...order, lines, state: aggregateState({ ...order, lines }) };
}

/** Recall (KDS-009): back to pending, flagged, so the mistake stays visible. */
export function applyRecallLocally(order: KitchenOrder, stages: readonly KitchenStage[]): KitchenOrder {
    const first = sortStages(stages)[0];
    return {
        ...order,
        state: 'pending',
        is_recalled: true,
        ready_at: null,
        served_at: null,
        first_started_at: null,
        lines: order.lines.map((line) =>
            // Recalling the card must not resurrect a cancellation as work to do (KDS-016).
            isLineCancelled(line)
                ? line
                : {
                      ...line,
                      prep_stage_id: first?.id ?? line.prep_stage_id,
                      state: 'todo' as KitchenLineState,
                      started_at: null,
                      ready_at: null,
                      served_at: null,
                  },
        ),
    };
}

/**
 * The card state is the aggregate of its lines, never a field set by hand.
 *
 * Precedence, least advanced wins: any line still to do ⇒ pending; any in progress ⇒ in progress;
 * all ready ⇒ ready; all served ⇒ served; everything cancelled ⇒ cancelled.
 *
 * The set to aggregate over is "not cancelled" ({@link isLineCancelled}), **not** {@link isLineOpen}
 * — a served line is finished rather than open, but it still has to be counted, because "everything
 * served" is what makes the card served. Only cancellations drop out entirely (KDS-016).
 */
export function aggregateState(order: Pick<KitchenOrder, 'lines' | 'state'>): KitchenOrder['state'] {
    const active = order.lines.filter((line) => !isLineCancelled(line));
    if (order.lines.length > 0 && active.length === 0) return 'cancelled';
    if (active.length === 0) return order.state;
    if (active.some((line) => line.state === 'todo')) return 'pending';
    if (active.some((line) => line.state === 'in_progress')) return 'in_progress';
    if (active.every((line) => line.state === 'served')) return 'served';
    return 'ready';
}

/**
 * Fold a `kitchen.ticket.updated` broadcast into a card.
 *
 * The event is thin (ids + states) by design, so it can only ever *narrow* what we know. Lines the
 * event does not mention are left untouched rather than dropped — a partial payload must never
 * silently empty a ticket.
 */
export function applyTicketUpdate(order: KitchenOrder, update: KitchenTicketUpdate): KitchenOrder {
    const byId = new Map(update.lines.map((line) => [line.id, line.state]));
    const byUuid = new Map(update.lines.map((line) => [line.uuid, line.state]));
    const lines = order.lines.map((line) => {
        const state = byId.get(line.id) ?? byUuid.get(line.uuid);
        return state === undefined || state === line.state ? line : { ...line, state };
    });
    return { ...order, lines, state: update.state, is_recalled: update.recalled };
}

/**
 * Replay the offline queue over a freshly fetched server board (KDS-020).
 *
 * The server is authoritative for state (spec §9), so reconciliation is "adopt the server board,
 * then re-apply the actions it has not acknowledged yet" — not a field-level last-write-wins merge,
 * which is how a bumped ticket resurrects itself two seconds later.
 */
export function replayQueue(
    server: readonly KitchenOrder[],
    stages: readonly KitchenStage[],
    queue: readonly PendingAction[],
    nowIso: string,
): KitchenOrder[] {
    if (queue.length === 0) return [...server];

    const byId = new Map(server.map((order) => [order.id, order]));
    for (const action of queue) {
        if (action.kind === 'line') {
            for (const [id, order] of byId) {
                if (order.lines.some((line) => line.id === action.lineId)) {
                    byId.set(id, applyLineStateLocally(order, action.lineId, action.state, nowIso));
                    break;
                }
            }
            continue;
        }

        const order = byId.get(action.prepOrderId);
        if (!order) continue;
        if (action.kind === 'recall') {
            byId.set(order.id, applyRecallLocally(order, stages));
        } else {
            const stage = stageById(stages, action.stageId);
            if (stage) byId.set(order.id, applyStageLocally(order, stage, nowIso));
        }
    }

    return [...byId.values()];
}

/** The queue entries `replayQueue` understands — the mutation half of `QueuedAction`. */
export type PendingAction =
    | { kind: 'stage'; prepOrderId: number; stageId: number }
    | { kind: 'recall'; prepOrderId: number }
    | { kind: 'line'; lineId: number; state: KitchenLineState };

/** A line as the card renders it: combo children sit under their parent. */
export type GroupedLine = {
    line: KitchenLine;
    /** 0 = top level, 1 = a component of the line above it. */
    depth: number;
};

/**
 * Combo children grouped under their parent (KDS-006).
 *
 * `combo_parent_uuid` has been travelling all the way to the client — populated server-side,
 * carried in the broadcast payload, mapped into the store, declared on the type — and read by
 * nothing. So a set menu arrived at the pass as a flat list of unrelated items, and a cook had no
 * way to tell which drink belonged to which meal.
 *
 * Order is preserved: children follow their own parent, and everything else keeps the position the
 * board gave it. A child whose parent is not on this card is **promoted to top level** rather than
 * dropped — the same rule `register/domain/split.ts` already applies for the same reason, since a
 * transfer or a station filter can legitimately separate the two, and silently hiding an item is
 * how something never gets cooked.
 */
export function groupCombos(lines: readonly KitchenLine[]): GroupedLine[] {
    const present = new Set(lines.map((line) => line.pos_order_line_uuid));

    /**
     * The parent this line actually nests under, or null for top level.
     *
     * A line naming *itself* is treated as having no parent. Only bad data produces that, but the
     * card renders whatever the board hands it, and the honest failure for a self-reference is a
     * line shown flat — not a line silently missing from the pass.
     */
    const parentOf = (line: KitchenLine): string | null => {
        const parent = line.combo_parent_uuid ?? null;
        if (parent === null || parent === line.pos_order_line_uuid) return null;

        return present.has(parent) ? parent : null;
    };

    const childrenOf = new Map<string, KitchenLine[]>();

    for (const line of lines) {
        const parent = parentOf(line);
        if (parent === null) continue;

        const bucket = childrenOf.get(parent);
        if (bucket) bucket.push(line);
        else childrenOf.set(parent, [line]);
    }

    const out: GroupedLine[] = [];

    for (const line of lines) {
        // Children are emitted with their parent below. A line with no *effective* parent — none
        // given, absent from this card, or itself — falls through here as top level.
        if (parentOf(line) !== null) continue;

        out.push({ line, depth: 0 });

        for (const child of childrenOf.get(line.pos_order_line_uuid) ?? []) {
            out.push({ line: child, depth: 1 });
        }
    }

    return out;
}
