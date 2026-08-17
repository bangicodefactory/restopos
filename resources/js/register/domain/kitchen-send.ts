import { ApiError, browserOnline } from '@shared/sync';

import { getCatalog } from '../data/catalog';
import { getRuntime, tryRuntime } from '../data/runtime';
import { coursesOf, linesOf, useOrderStore } from '../state/order-store';
import {
    computePrepDelta,
    filterChangesByCategories,
    type PrepDelta,
} from './kitchen-delta';
import { adoptPrepSnapshot, fireCourse, markCoursePrepSent, markPrepSent } from './order-actions';
import { print } from './printing';
import { buildPrepTicket } from './receipt';

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

export type SendOutcome =
    | { status: 'nothing'; delta: PrepDelta }
    | { status: 'sent'; delta: PrepDelta; printed: number; online: boolean }
    | { status: 'outdated'; delta: PrepDelta }
    /** The preset wants a cover count and the order has none yet (RST-072). */
    | { status: 'needs_guests'; delta: PrepDelta }
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
        const outcome = await print(runtime.printer, doc, { printerId: binding.id, role: 'prep' });
        if (outcome.ok) printed += 1;
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

    const runtime = tryRuntime();
    const online = browserOnline() && runtime !== null;

    if (!online) {
        const printed = await printTickets(orderUuid, delta, options.courseName ?? null);
        markPrepSent(orderUuid);
        void runtime?.syncer.enqueueCommand('prep.sent', {
            order_uuid: orderUuid,
            snapshot_version: knownSnapshotVersion(orderUuid),
            course_index: options.courseIndex ?? null,
        });
        return { status: 'sent', delta, printed, online: false };
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
            return { status: 'sent', delta, printed, online: false };
        }

        return { status: 'failed', delta, reason: error instanceof Error ? error.message : String(error) };
    }

    const printed = await printTickets(orderUuid, delta, options.courseName ?? null);
    markPrepSent(orderUuid);
    return { status: 'sent', delta, printed, online: true };
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

    return { status: 'sent', delta: courseDelta, printed, online };
}
