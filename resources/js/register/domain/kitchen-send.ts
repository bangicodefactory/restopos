import { ApiError, browserOnline } from '@shared/sync';

import { getCatalog } from '../data/catalog';
import { getRuntime, tryRuntime } from '../data/runtime';
import { coursesOf, linesOf, useOrderStore } from '../state/order-store';
import {
    computePrepDelta,
    filterChangesByCategories,
    type PrepDelta,
} from './kitchen-delta';
import { adoptPrepSnapshot, markPrepSent } from './order-actions';
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

export async function sendToKitchen(
    orderUuid: string,
    options: { courseIndex?: number | null; courseName?: string | null } = {},
): Promise<SendOutcome> {
    const delta = currentDelta(orderUuid);
    if (delta.nbrOfChanges === 0 && !delta.orderNoteChanged) {
        return { status: 'nothing', delta };
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
 * RST-084 — fire a course. The ticket is a *note-update* style change listing the course's
 * products, not a NEW ticket, so quantities are not counted twice at the pass.
 */
export async function fireCourseAndSend(orderUuid: string, courseUuid: string): Promise<SendOutcome> {
    const state = useOrderStore.getState();
    const course = state.courses[courseUuid];
    if (!course) return { status: 'nothing', delta: currentDelta(orderUuid) };

    const runtime = tryRuntime();
    if (runtime && browserOnline()) {
        try {
            await runtime.api.post(`pos/orders/${orderUuid}/courses/${courseUuid}/fire`, {
                snapshot_version: knownSnapshotVersion(orderUuid),
                employee_id: null,
            });
        } catch (error) {
            if (error instanceof ApiError && error.sync.kind === 'conflict') {
                return { status: 'outdated', delta: currentDelta(orderUuid) };
            }
            // Any other failure is tolerated: the local fire and the queued order push carry it.
        }
    }

    return sendToKitchen(orderUuid, {
        courseIndex: course.index,
        courseName: course.name ?? `Service ${course.index}`,
    });
}
