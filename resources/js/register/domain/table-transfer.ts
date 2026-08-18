import type { RestaurantTableRow } from '@domain/types';
import { ApiError, browserOnline } from '@shared/sync';

import { reloadAllOrders } from '../boot';
import { tryRuntime } from '../data/runtime';
import { useOrderStore } from '../state/order-store';

/**
 * Table transfer / merge / unmerge (RST-052 … RST-056).
 *
 * These route through the server's `TableService` rather than a client-side copy (BAN-437). Only the
 * server can record the merge in `pos_order_merges` (so unmerge is possible), migrate the kitchen's
 * "already sent" snapshot with the moved lines (so nothing is re-fired), and resolve a collision
 * with the one-draft-per-table unique index. A client-side merge did none of that and pushed a
 * mangled order through generic sync. The cost of correctness is that these are **online-only**;
 * offline, the action is refused rather than left to diverge.
 *
 * After a successful call the local order slice is rebuilt from the server via `reloadAllOrders`,
 * so the moved lines and the tombstoned source land exactly as the server left them.
 */

type ServerOrder = { uuid: string; restaurant_table_id: number | null };
type TransferResponse = { order: ServerOrder; merged: boolean; merge_id: number | null };
type MergeResponse = { order: ServerOrder; merge_id: number | null };

/** A transfer/merge/unmerge that could not be applied — carries the server's error code. */
export class TableActionError extends Error {
    constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'TableActionError';
    }
}

// Session memory of the last merge per surviving order, so the till can offer an undo (RST-052)
// without a round-trip to look the id up.
const mergeBySurvivor = new Map<string, number>();

/** The merge id that produced this order, if it was a merge survivor this session. */
export function mergeIdFor(orderUuid: string): number | null {
    return mergeBySurvivor.get(orderUuid) ?? null;
}

function requireOnline(): NonNullable<ReturnType<typeof tryRuntime>> {
    const runtime = tryRuntime();
    if (!runtime || !browserOnline()) {
        throw new TableActionError('offline', 'Transferring or merging a table needs a connection.');
    }
    return runtime;
}

/**
 * Rebuild the local order slice after the server has already applied the change. The server op is
 * the source of truth and has committed, so a failed refresh here is not a failed action — swallow
 * it and let the next sync reconcile, rather than reporting a move that actually happened as a
 * failure.
 */
async function refreshAfterServerAction(): Promise<void> {
    try {
        await reloadAllOrders();
    } catch {
        // Already applied server-side; the next delta pull will bring the local replica in line.
    }
}

/** Turn an ApiClient failure into a typed TableActionError carrying the server's `error.code`. */
function fail(error: unknown): never {
    if (error instanceof ApiError) {
        if (error.sync.kind === 'offline') {
            throw new TableActionError('offline', 'Transferring or merging a table needs a connection.');
        }
        const code = (error.body as { error?: { code?: string } } | null)?.error?.code;
        throw new TableActionError(code ?? 'failed', error.message);
    }
    throw error;
}

/**
 * Move an order onto another table (RST-054). If a draft already sits there the server merges into
 * it — the target survives — and returns the merge id so the move can be undone. Returns the
 * surviving order's uuid so the caller can open it.
 */
export async function transferOrder(
    orderUuid: string,
    tableId: number,
): Promise<{ merged: boolean; orderUuid: string; mergeId: number | null }> {
    const order = useOrderStore.getState().orders[orderUuid];
    if (!order) return { merged: false, orderUuid, mergeId: null };
    if (order.restaurant_table_id === tableId) return { merged: false, orderUuid, mergeId: null };

    const runtime = requireOnline();

    // Push any pending local edits first so the server transfers the *current* order, not a stale
    // copy it would then echo back over those edits when we reload.
    await runtime.syncer.drain();

    let response: TransferResponse | null;
    try {
        response = (
            await runtime.api.post<TransferResponse>(`pos/orders/${orderUuid}/transfer`, {
                table_id: tableId,
                employee_id: null,
            })
        ).data;
    } catch (error) {
        fail(error);
    }

    if (!response) throw new TableActionError('failed', 'The transfer returned no order.');

    if (response.merged && response.merge_id !== null) {
        mergeBySurvivor.set(response.order.uuid, response.merge_id);
    }
    await refreshAfterServerAction();

    return { merged: response.merged, orderUuid: response.order.uuid, mergeId: response.merge_id };
}

/** Fold `sourceUuid` into `targetUuid` (RST-055); the target survives. Returns the merge id. */
export async function mergeOrders(sourceUuid: string, targetUuid: string): Promise<number | null> {
    if (sourceUuid === targetUuid) return null;

    const runtime = requireOnline();

    // Push pending local edits on both orders so the server merges their current state.
    await runtime.syncer.drain();

    let response: MergeResponse | null;
    try {
        response = (
            await runtime.api.post<MergeResponse>(`pos/orders/${sourceUuid}/merge`, {
                target_order_uuid: targetUuid,
                employee_id: null,
            })
        ).data;
    } catch (error) {
        fail(error);
    }

    if (!response) throw new TableActionError('failed', 'The merge returned no order.');

    if (response.merge_id !== null) mergeBySurvivor.set(response.order.uuid, response.merge_id);
    await refreshAfterServerAction();

    return response.merge_id;
}

/** Reverse a merge (RST-052): the source order, its lines, courses and prep snapshot are restored. */
export async function unmergeOrder(mergeId: number): Promise<string> {
    const runtime = requireOnline();

    let restoredUuid: string | null;
    try {
        restoredUuid =
            (await runtime.api.post<{ order: ServerOrder }>(`pos/order-merges/${mergeId}/unmerge`, { employee_id: null }))
                .data?.order.uuid ?? null;
    } catch (error) {
        fail(error);
    }

    if (!restoredUuid) throw new TableActionError('failed', 'The unmerge returned no order.');

    await refreshAfterServerAction();
    return restoredUuid;
}

/** A place a floating order can be sent (RST-057). */
export type TransferTarget = {
    tableId: number;
    label: string;
    /** The draft already on that table, if any — sending there is a merge, not a move. */
    occupiedByUuid: string | null;
};

/**
 * Where an order can go, from the order list rather than the floor plan (RST-057).
 *
 * The only way to move an order was the arm-and-tap gesture on the floor plan, which cannot help
 * with the case that needs it most: an order that is not on a table yet. A takeaway the customer
 * decides to eat in, a bill started at the counter — both are floating, and the floor plan has
 * nothing to arm.
 *
 * Free tables and occupied ones come back in one list, because the waiter's question is "where is
 * this going" and not "am I about to transfer or merge". Which of the two it becomes is a
 * consequence of the destination, and the caller reads `occupiedByUuid` to decide — the same rule
 * the floor plan already applies on tap.
 *
 * The order's own table is excluded: sending a bill where it already is has no meaning, and offering
 * it invites a self-transfer the server refuses.
 */
export function transferTargets(
    tables: readonly RestaurantTableRow[],
    drafts: readonly { uuid: string; restaurant_table_id: number | null }[],
    sourceUuid: string,
): TransferTarget[] {
    const source = drafts.find((order) => order.uuid === sourceUuid) ?? null;

    const occupant = new Map<number, string>();

    for (const order of drafts) {
        if (order.uuid === sourceUuid || order.restaurant_table_id === null) continue;
        // First draft wins, matching the server's own "oldest bill survives" rule.
        if (!occupant.has(order.restaurant_table_id)) occupant.set(order.restaurant_table_id, order.uuid);
    }

    return tables
        .filter((table) => table.active && table.id !== source?.restaurant_table_id)
        .sort((a, b) => Number(a.table_number) - Number(b.table_number))
        .map((table) => ({
            tableId: table.id,
            label: `T ${table.table_number}`,
            occupiedByUuid: occupant.get(table.id) ?? null,
        }));
}
