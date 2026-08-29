import type { EscPosDoc } from '@domain/escpos/index';
import { ApiError, browserOnline } from '@shared/sync';

import { getCatalog, type CatalogIndex } from '../data/catalog';
import { getRuntime, tryRuntime } from '../data/runtime';
import { coursesOf, linesOf, useOrderStore } from '../state/order-store';
import {
    changeCountsByCategory,
    computePrepDelta,
    filterChangesByCategories,
    type PrepDelta,
} from './kitchen-delta';
import { needsOrderName } from './order-naming';
import { adoptPrepSnapshot, fireCourse, markCoursePrepSent, markPrepSent } from './order-actions';
import { print } from './printing';
import { FR_LABELS, buildPrepTicket } from './receipt';

/**
 * Send-to-kitchen (KDS-056 … KDS-058, RST-143).
 *
 * The rule that matters is KDS-057: **the server's snapshot is the arbiter.** The local delta is
 * what the badge shows and what gets printed offline, but before printing online we hand the server
 * the `snapshot_version` we rendered. If another till has fired past it, we get `409 order_outdated`
 * with the server's current delta — we adopt it and print **nothing**. That is the whole mechanism
 * that stops two waiters double-firing a table, and it is why this cannot be a fire-and-forget POST.
 *
 * Offline the send still happens: tickets print, the snapshot advances locally, and a `prep.sent`
 * command queues so the server rebuilds the same snapshot when the link returns. A kitchen that
 * stops receiving orders because the Wi-Fi blinked is worse than one that occasionally sees a
 * duplicate.
 */

/**
 * "2 Boissons · 1 Plats" — what a send actually despatched, per category (KDS-061, RST-144).
 *
 * `changeCountsByCategory()` has existed in `kitchen-delta.ts` since RST-144, documented and unit
 * tested, with **no production caller**: the send outcome carried a `printed` count of *documents*
 * and the toast said nothing but "Sent". A waiter who fires a table has no way to check the kitchen
 * was told about the drink, which is precisely the thing that goes missing.
 */
export type SendCategoryCount = {
    /** `null` for changes on products in no category at all. */
    categoryId: number | null;
    /** Empty when the category is unknown to this till's catalog — the caller localises a fallback. */
    name: string;
    count: number;
};

export type SendOutcome =
    | { status: 'nothing'; delta: PrepDelta }
    | { status: 'sent'; delta: PrepDelta; printed: number; online: boolean; summary: SendCategoryCount[] }
    | { status: 'outdated'; delta: PrepDelta }
    /** The preset wants a cover count and the order has none yet (RST-072). */
    | { status: 'needs_guests'; delta: PrepDelta }
    /** The service mode has no table, so the order needs a name to be called by (RST-141). */
    | { status: 'needs_name'; delta: PrepDelta }
    | { status: 'failed'; delta: PrepDelta; reason: string };

type ServerDelta = {
    order_uuid: string;
    nbr_of_changes: number;
    count: string;
    snapshot_version: number;
    snapshot_at: string;
};

/** `snapshot_version` per order, as last told by the server. Reset by a bootstrap. */
const snapshotVersions = new Map<string, number>();

export function knownSnapshotVersion(orderUuid: string): number {
    return snapshotVersions.get(orderUuid) ?? 0;
}

export function rememberSnapshotVersion(orderUuid: string, version: number): void {
    snapshotVersions.set(orderUuid, version);
}

export function currentDelta(orderUuid: string): PrepDelta {
    const state = useOrderStore.getState();
    const order = state.orders[orderUuid];
    if (!order) return computePrepDelta([], [], null);
    return computePrepDelta(
        linesOf(state, orderUuid),
        coursesOf(state, orderUuid),
        order.last_prep_snapshot,
        order.general_customer_note,
        order.internal_note,
    );
}

/** The badge number on the table tile and the order button (RST-003, RST-009). */
export function unsentChangeCount(orderUuid: string): number {
    return currentDelta(orderUuid).nbrOfChanges;
}

/**
 * The prep documents the last send actually rendered, per order (KDS-059, REG-297).
 *
 * Kept in module memory alongside `snapshotVersions`, and for the same reason: it is a property of
 * this till's session, not of the order, and re-deriving it after a reload would mean recomputing a
 * delta that has since been consumed — which is the one thing a reprint must not do.
 *
 * Retained on **render**, not on a successful print. The reprint exists for the jam, the empty
 * roll and the printer that was switched off: those are exactly the sends where nothing came out,
 * and retaining only successes would leave nothing to reprint in every case that matters.
 */
type RetainedPrints = { at: number; copy: number; docs: Array<{ printerId: string; doc: EscPosDoc }> };

const lastPrints = new Map<string, RetainedPrints>();

/** Is there a prep document this till could put on paper again? Drives the reprint button. */
export function hasReprintablePrep(orderUuid: string): boolean {
    return (lastPrints.get(orderUuid)?.docs.length ?? 0) > 0;
}

/** Test seam and bootstrap hook — a fresh session must not offer yesterday's ticket. */
export function forgetLastPrints(orderUuid?: string): void {
    if (orderUuid === undefined) lastPrints.clear();
    else lastPrints.delete(orderUuid);
}

export type ReprintOutcome =
    | { status: 'reprinted'; printed: number; copy: number }
    /** Nothing was ever rendered for this order on this till. */
    | { status: 'nothing' }
    | { status: 'failed'; reason: string };

/**
 * Put the last prep document on paper again (KDS-059) — nothing more.
 *
 * The delta is **not** recomputed, the snapshot is **not** advanced, no course is fired and nothing
 * is posted. That is the entire point: a printer jammed, the kitchen never got the paper, and the
 * waiter needs the same ticket again. Anything that recomputed the delta would find it empty (the
 * send already consumed it) and print a blank ticket; anything that re-ran the send would re-fire
 * the kitchen for food already on the pass.
 *
 * The stored document is replayed verbatim, with a DUPLICATA banner and an incremented `meta.copy`
 * so a cook who receives both copies can tell they are one order and not two.
 */
export async function explicitReprint(orderUuid: string): Promise<ReprintOutcome> {
    const retained = lastPrints.get(orderUuid);
    if (!retained || retained.docs.length === 0) return { status: 'nothing' };

    const runtime = tryRuntime();
    if (!runtime) return { status: 'failed', reason: 'no_runtime' };

    const copy = retained.copy + 1;
    let printed = 0;

    for (const entry of retained.docs) {
        const outcome = await print(runtime.printer, asDuplicate(entry.doc, copy), {
            printerId: entry.printerId,
            role: 'prep',
        });
        if (outcome.ok) printed += 1;
    }

    // Bumped whether or not the paper came out: the copy number counts attempts to hand the kitchen
    // this ticket, and two identical "copy 2" slips is the confusion it exists to prevent.
    lastPrints.set(orderUuid, { ...retained, copy });

    return { status: 'reprinted', printed, copy };
}

function asDuplicate(doc: EscPosDoc, copy: number): EscPosDoc {
    return {
        ...doc,
        nodes: [
            { t: 'text', v: FR_LABELS.duplicate, style: { align: 'center', bold: true, invert: true } },
            ...doc.nodes,
        ],
        meta: { ...doc.meta, copy },
    };
}

/**
 * Fold a delta into per-category counts a cashier can read back (KDS-061).
 *
 * Names are resolved here rather than in the toast so the outcome is testable without React, and a
 * category this till has never heard of yields an empty name for the caller to localise — printing
 * a bare id at a cashier is worse than printing nothing.
 */
export function summariseSend(delta: PrepDelta, catalog: CatalogIndex = getCatalog()): SendCategoryCount[] {
    const out: SendCategoryCount[] = [];

    // No `count === 0` guard. `changeCountsByCategory` sums **absolute** quantities, and
    // `computePrepDelta` — the only producer of a `PrepDelta` — never emits a zero-quantity change
    // (it skips `delta === 0`, `quantity === 0` and empty snapshot entries at all three sites). A
    // zero bucket is therefore unreachable, and a branch no test can reach is a branch that is
    // wrong the first time something makes it reachable.
    for (const [categoryId, count] of changeCountsByCategory(delta)) {
        out.push({
            categoryId,
            name: categoryId === null ? '' : (catalog.categoriesById.get(categoryId)?.name ?? ''),
            count: Math.round(count * 1000) / 1000,
        });
    }

    // Biggest first: "8 Plats · 1 Boissons" puts the number worth checking at the front.
    out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    return out;
}

async function printTickets(orderUuid: string, delta: PrepDelta, courseName: string | null): Promise<number> {
    const runtime = tryRuntime();
    if (!runtime) return 0;

    const state = useOrderStore.getState();
    const order = state.orders[orderUuid];
    if (!order) return 0;

    const catalog = getCatalog();
    const table =
        order.restaurant_table_id !== null ? catalog.tablesById.get(order.restaurant_table_id) : undefined;
    const preset =
        order.pos_preset_id !== null ? catalog.presets.find((p) => p.id === order.pos_preset_id) : undefined;

    const prepPrinters = runtime.printer.getBindings().filter((binding) => binding.role === 'prep');
    const rendered: RetainedPrints['docs'] = [];
    let printed = 0;

    for (const binding of prepPrinters) {
        const slice = filterChangesByCategories(delta, binding.categoryIds);
        if (slice.length === 0) continue;
        const doc = buildPrepTicket(
            order,
            slice,
            {
                tableName: table?.table_number ?? null,
                presetName: preset?.name ?? null,
                cashierName: null,
                courseName,
            },
            state,
        );
        rendered.push({ printerId: binding.id, doc });
        const outcome = await print(runtime.printer, doc, { printerId: binding.id, role: 'prep' });
        if (outcome.ok) printed += 1;
    }

    // Only when this send actually rendered something. A send that produced no document — no prep
    // printer is bound to any of these categories — must leave the previous ticket reprintable
    // rather than clobbering it with an empty set and silently disabling the button.
    if (rendered.length > 0) {
        lastPrints.set(orderUuid, { at: Date.now(), copy: 1, docs: rendered });
    }

    return printed;
}

/**
 * Does this order still owe the kitchen a cover count? (RST-072)
 *
 * `pos_presets.use_guest` marks the service modes where the number matters — a dine-in preset, not a
 * takeaway — and it was read by nothing at all: the column shipped, the client type did not even
 * declare it, and an order could reach the pass with no idea how many people were eating.
 *
 * Only before the **first** send. Asking again on every re-fire would punish the waiter for adding a
 * dessert, and by then the kitchen already has the number.
 */
export function needsGuestCount(orderUuid: string): boolean {
    const order = useOrderStore.getState().orders[orderUuid];
    if (!order) return false;

    // Already told them; a later edit is not a new question.
    if (Number(order.guest_count ?? 0) > 0) return false;

    const presetId = order.pos_preset_id ?? null;
    if (presetId === null) return false;

    return getCatalog().presets.find((preset) => preset.id === presetId)?.use_guest === true;
}

/** Does this order still owe a name? (RST-141) */
export function needsOrderNameFor(orderUuid: string): boolean {
    const order = useOrderStore.getState().orders[orderUuid];

    if (!order) return false;

    return needsOrderName({
        hasTable: order.restaurant_table_id !== null,
        hasPreset: order.pos_preset_id !== null,
        name: order.order_name_manual ? order.floating_order_name : null,
    });
}

/**
 * Stamp the courses a whole-order send just despatched (RST-084, RST-085).
 *
 * `sendToKitchen` sends everything unsent, courses included — but it marked no course fired, so the
 * kitchen was cooking the starters while the till still offered "Fire course 1" and no course tag
 * ever appeared. Pressing fire afterwards found nothing to send and stamped it anyway, which is the
 * same state reached by a longer road.
 *
 * Only courses that actually had lines in this delta are stamped. An empty course further down the
 * order has not been fired by anybody, and marking it would tell the pass a course is on its way
 * when nothing was printed for it.
 */
function fireCoursesInDelta(orderUuid: string, delta: PrepDelta): void {
    const seen = new Set<string>();

    for (const change of delta.changes) {
        if (change.courseUuid) seen.add(change.courseUuid);
    }

    for (const courseUuid of seen) {
        if (useOrderStore.getState().courses[courseUuid]?.fired === false) {
            fireCourse(orderUuid, courseUuid);
        }
    }
}

export async function sendToKitchen(
    orderUuid: string,
    options: { courseIndex?: number | null; courseName?: string | null } = {},
): Promise<SendOutcome> {
    const delta = currentDelta(orderUuid);
    if (delta.nbrOfChanges === 0 && !delta.orderNoteChanged) {
        return { status: 'nothing', delta };
    }

    // Checked here rather than in the button's handler, so the online and offline paths below are
    // both covered by one test. `fireCourseAndSend` does *not* come through here — it has its own
    // complete path and its own copy of this check.
    if (needsGuestCount(orderUuid)) {
        return { status: 'needs_guests', delta };
    }

    // RST-141 — a preset with no table has no number to be called by. Without a name the pass has
    // nothing to shout and every collection order that hour is "Direct Sale". Asked before the first
    // send, which is the last moment the customer is still standing there.
    if (needsOrderNameFor(orderUuid)) {
        return { status: 'needs_name', delta };
    }

    const runtime = tryRuntime();
    const online = browserOnline() && runtime !== null;

    if (!online) {
        const printed = await printTickets(orderUuid, delta, options.courseName ?? null);
        markPrepSent(orderUuid);
        fireCoursesInDelta(orderUuid, delta);
        void runtime?.syncer.enqueueCommand('prep.sent', {
            order_uuid: orderUuid,
            snapshot_version: knownSnapshotVersion(orderUuid),
            course_index: options.courseIndex ?? null,
        });
        return { status: 'sent', delta, printed, online: false, summary: summariseSend(delta) };
    }

    const { api } = getRuntime();

    try {
        const response = await api.post<{ delta: ServerDelta; snapshot_version: number }>(
            `pos/orders/${orderUuid}/preparation`,
            {
                course_index: options.courseIndex ?? null,
                snapshot_version: knownSnapshotVersion(orderUuid),
                employee_id: null,
            },
        );
        if (response.data) rememberSnapshotVersion(orderUuid, response.data.snapshot_version);
    } catch (error) {
        if (error instanceof ApiError && error.sync.kind === 'conflict') {
            // KDS-057 — someone fired first. Adopt and print nothing.
            const body = error.body as { delta?: ServerDelta } | null;
            if (body?.delta) {
                rememberSnapshotVersion(orderUuid, body.delta.snapshot_version);
                adoptPrepSnapshot(orderUuid, {
                    at: body.delta.snapshot_at,
                    lines: {},
                    noteHash: '',
                });
            }
            return { status: 'outdated', delta };
        }

        if (error instanceof ApiError && error.sync.kind === 'offline') {
            const printed = await printTickets(orderUuid, delta, options.courseName ?? null);
            markPrepSent(orderUuid);
            fireCoursesInDelta(orderUuid, delta);
            return { status: 'sent', delta, printed, online: false, summary: summariseSend(delta) };
        }

        return { status: 'failed', delta, reason: error instanceof Error ? error.message : String(error) };
    }

    const printed = await printTickets(orderUuid, delta, options.courseName ?? null);
    markPrepSent(orderUuid);
    fireCoursesInDelta(orderUuid, delta);
    return { status: 'sent', delta, printed, online: true, summary: summariseSend(delta) };
}

/**
 * RST-084 — fire one course to the kitchen.
 *
 * A single call to the `.../courses/{course}/fire` endpoint marks the course fired *and* sends its
 * delta server-side (the server is the arbiter of the snapshot, KDS-057). We then print the course's
 * lines locally and advance the local snapshot for *this course only*. The old implementation posted
 * the fire endpoint and then `sendToKitchen`, which sent the same course twice — and, because the
 * fire had already bumped the snapshot version, the second post 409'd. It also had zero callers.
 */
export async function fireCourseAndSend(orderUuid: string, courseUuid: string): Promise<SendOutcome> {
    const course = useOrderStore.getState().courses[courseUuid];
    if (!course) return { status: 'nothing', delta: currentDelta(orderUuid) };

    // Only this course's changes are fired/printed; the whole-order delta stays untouched for the
    // other courses.
    const whole = currentDelta(orderUuid);
    const courseDelta: PrepDelta = { ...whole, changes: whole.changes.filter((change) => change.courseUuid === courseUuid) };

    if (courseDelta.changes.length === 0) {
        // Nothing new to fire, but still stamp the course fired so its tag shows (RST-084).
        fireCourse(orderUuid, courseUuid);
        return { status: 'nothing', delta: courseDelta };
    }

    // RST-072, again — this function does **not** go through `sendToKitchen`. It posts to the fire
    // endpoint, prints and marks sent entirely on its own, so a guard placed only there let a
    // course reach the pass with no cover count: the same defect through the other door, which is
    // exactly what "a guard in one caller is a guard that one caller has" was supposed to mean.
    //
    // Before the course is stamped fired, so a refusal leaves it fireable rather than marking a
    // course sent that never printed.
    if (needsGuestCount(orderUuid)) {
        return { status: 'needs_guests', delta: courseDelta };
    }

    const courseName = course.name ?? `Service ${course.index}`;
    const runtime = tryRuntime();
    let online = browserOnline() && runtime !== null;

    if (online && runtime) {
        try {
            const response = await runtime.api.post<{ snapshot_version: number }>(
                `pos/orders/${orderUuid}/courses/${courseUuid}/fire`,
                { snapshot_version: knownSnapshotVersion(orderUuid), employee_id: null },
            );
            if (response.data) rememberSnapshotVersion(orderUuid, response.data.snapshot_version);
        } catch (error) {
            if (error instanceof ApiError && error.sync.kind === 'conflict') {
                return { status: 'outdated', delta: courseDelta };
            }
            if (error instanceof ApiError && error.sync.kind === 'offline') {
                online = false; // fall through to the offline path
            } else {
                return { status: 'failed', delta: courseDelta, reason: error instanceof Error ? error.message : String(error) };
            }
        }
    }

    const printed = await printTickets(orderUuid, courseDelta, courseName);
    fireCourse(orderUuid, courseUuid);
    markCoursePrepSent(orderUuid, courseUuid);

    if (!online) {
        void runtime?.syncer.enqueueCommand('prep.sent', {
            order_uuid: orderUuid,
            snapshot_version: knownSnapshotVersion(orderUuid),
            course_index: course.index,
        });
    }

    return { status: 'sent', delta: courseDelta, printed, online, summary: summariseSend(courseDelta) };
}
