import type { RestaurantTableRow } from '@domain/types';
import { ApiError, browserOnline } from '@shared/sync';

import { reloadAllOrders } from '../boot';
import { getRuntime, tryRuntime } from '../data/runtime';
import { orderOnTable, useOrderStore } from '../state/order-store';
import { applyTableToCatalog, toCatalogRow } from './floor-editing';
import { refreshOrderName } from './order-actions';
import { TableActionError } from './table-transfer';

/**
 * Physically linking two tables (RST-050, BAN-463).
 *
 * A party of eight arrives at two fours; the waiter pushes the tables together and expects the till
 * to follow. The server side has existed since the floor plan landed — `TableService::link()` sets
 * `parent_id` and moves the child's draft onto the parent, merging it into the parent's bill if
 * there already is one — reachable only by a hand-written PATCH. What was missing is the gesture,
 * and everything the gesture needs to decide *before* it fires.
 *
 * That decision lives here, pure; the calls below are the thin part. Which tables you may drop onto
 * is the interesting question, because a linked pair is a tree: a drop that closes a cycle, or lands
 * on the table already being dragged, is exactly what a waiter produces by accident at speed.
 *
 * **Online only**, for the same reason as transfer and merge (see `table-transfer`): only the server
 * can record the merge so it can be undone, and carry the kitchen's already-sent snapshot across so
 * nothing is re-fired.
 */

/** Every table that would still be a legal parent for `child`. */
export function linkTargets(
    child: RestaurantTableRow,
    tables: readonly RestaurantTableRow[],
): RestaurantTableRow[] {
    return tables.filter((candidate) => canLink(child, candidate));
}

/**
 * May `child` be dropped onto `parent`?
 *
 * Mirrors the server's rule rather than trusting the drop, so a target the server would refuse never
 * lights up as a drop zone. The server keeps its own copy of this check — this one is the
 * affordance, that one is the control.
 */
export function canLink(child: RestaurantTableRow, parent: RestaurantTableRow): boolean {
    if (child.id === parent.id) return false;

    // A table already hanging off something else is not a parent — its own parent is. Offering it
    // would silently re-home the whole group under a table the waiter never touched.
    //
    // This is also what keeps a group exactly one level deep, and therefore what makes a cycle
    // impossible from this gesture: closing a loop needs a root linked onto one of its own
    // children, and a child is never a legal parent. A walk up the chain was here to catch that
    // case and could not reach it — sabotaging it changed no behaviour, which is how it was found.
    // The server keeps its own walk, because the raw PATCH can still build any shape it likes.
    if (parent.parent_id !== null) return false;

    // Different rooms are a different gesture; you cannot push two tables together through a wall.
    return child.floor_id === parent.floor_id;
}

/** The children of `table`, in table-number order — the rest of the pushed-together group. */
export function linkedChildren(
    table: RestaurantTableRow,
    tables: readonly RestaurantTableRow[],
): RestaurantTableRow[] {
    return tables
        .filter((candidate) => candidate.parent_id === table.id)
        .sort((a, b) => Number(a.table_number) - Number(b.table_number));
}

/**
 * The table whose bill a tap should open (RST-050).
 *
 * A child of a linked group has no bill of its own — the link moved it onto the parent — so tapping
 * the child has to land on the parent's order, or the waiter opens an empty screen while standing
 * next to a table with eight covers on it.
 */
export function billTableFor(
    table: RestaurantTableRow,
    tables: readonly RestaurantTableRow[],
): RestaurantTableRow {
    const byId = new Map(tables.map((row) => [row.id, row]));

    let cursor = table;
    let depth = 0;

    while (cursor.parent_id !== null && depth++ < 16) {
        const parent = byId.get(cursor.parent_id);
        if (!parent) break;
        cursor = parent;
    }

    return cursor;
}

function requireOnline(): void {
    if (!tryRuntime() || !browserOnline()) {
        throw new TableActionError('offline', 'Linking tables needs a connection.');
    }
}

function fail(error: unknown): never {
    if (error instanceof ApiError) {
        if (error.sync.kind === 'offline') {
            throw new TableActionError('offline', 'Linking tables needs a connection.');
        }
        const code = (error.body as { error?: { code?: string } } | null)?.error?.code;
        throw new TableActionError(code ?? 'failed', error.message);
    }
    throw error;
}

async function patchParent(table: RestaurantTableRow, parentId: number | null): Promise<RestaurantTableRow> {
    const runtime = getRuntime();

    let body: { table: Record<string, unknown> } | null;
    try {
        body = (
            await runtime.api.patch<{ table: Record<string, unknown> }>(`pos/tables/${table.id}`, {
                restaurant_floor_id: table.floor_id,
                table_number: Number(table.table_number),
                parent_id: parentId,
            })
        ).data;
    } catch (error) {
        fail(error);
    }

    if (!body) throw new TableActionError('failed', 'The link returned no table.');

    const next = toCatalogRow(body.table, table);
    await runtime.db.restaurantTables.put(next);
    applyTableToCatalog(next);

    return next;
}

/**
 * Rebuild the orders after the server has linked or unlinked, and re-derive both bills' names.
 *
 * The names matter more here than anywhere else: linking is precisely what turns `T 3` into
 * `T 3 & 4`, and unlinking is what turns it back. A reload alone leaves the group showing the name
 * it had before the tables were pushed together (RST-140).
 */
async function refreshAfterLink(tableIds: readonly number[]): Promise<void> {
    try {
        await reloadAllOrders();
    } catch {
        // The server has committed; the next delta pull reconciles the replica.
    }

    const state = useOrderStore.getState();

    for (const tableId of tableIds) {
        const order = orderOnTable(state, tableId);
        if (order) refreshOrderName(order.uuid);
    }
}

/**
 * Push `child` onto `parent`: the tables become one group and the child's bill moves onto the
 * parent's, merging into it if the parent is already open. Returns the order the waiter should now
 * be looking at, which is the parent's.
 */
export async function linkTable(child: RestaurantTableRow, parent: RestaurantTableRow): Promise<string | null> {
    requireOnline();

    if (!canLink(child, parent)) {
        throw new TableActionError('invalid_link', 'Those two tables cannot be linked.');
    }

    // Push pending local edits first so the server merges the *current* bills rather than echoing a
    // stale copy back over them — the ordering transfer relies on for the same reason.
    await getRuntime().syncer.drain();

    await patchParent(child, parent.id);
    await refreshAfterLink([parent.id, child.id]);

    return orderOnTable(useOrderStore.getState(), parent.id)?.uuid ?? null;
}

/**
 * Break the link. The bill stays on the parent — unlinking separates the furniture, it does not
 * split the money, which is what an unmerge is for.
 */
export async function unlinkTable(child: RestaurantTableRow): Promise<void> {
    requireOnline();

    const parentId = child.parent_id;

    await patchParent(child, null);
    await refreshAfterLink(parentId === null ? [child.id] : [parentId, child.id]);
}
