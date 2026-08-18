import { splitOrder, setTable } from './order-actions';
import type { SplitSelection } from './split';
import { TableActionError, transferOrder } from './table-transfer';

/**
 * Splitting a bill *onto* another table (RST-106, BAN-521).
 *
 * `splitOrder` always leaves the new bill floating, because a split shares its parent's table and
 * the one-draft-per-table rule forbids two drafts there. That is right for the common case — two
 * people at one table paying separately — and it makes the other one impossible: four guests moving
 * to the bar while the rest of the table carries on eating. The waiter could split the lines off and
 * then had no way to seat the result.
 *
 * The destination is applied **after** the split rather than threaded through it, for two reasons.
 * The split is local and offline-capable, and seating is not always; and a destination that already
 * holds a bill is a *merge*, which only the server can do correctly — it records the merge so it can
 * be undone and carries the kitchen's already-sent snapshot across so nothing is re-fired (BAN-437).
 * Reusing `transferOrder` for that is what keeps this from becoming a second merge implementation.
 *
 * A free table is seated locally instead, so the common move still works with no connection. If
 * another till seated it in the meantime the server reconciles the collision on ingest and reports
 * the survivor (BAN-471) — the local judgement degrades into a merge rather than into two drafts.
 */

/** What seating the split bill on `tableId` would mean, given the drafts currently on the floor. */
export type SplitDestination =
    /** No destination chosen — the bill stays floating, exactly as it does today. */
    | { kind: 'floating' }
    /** The table is free: seat it locally, no round trip. */
    | { kind: 'seat'; tableId: number }
    /** The table already has a bill: this is a merge, and merges belong to the server. */
    | { kind: 'merge'; tableId: number; intoUuid: string };

export function destinationFor(
    tableId: number | null,
    drafts: readonly { uuid: string; restaurant_table_id: number | null }[],
    splitUuid: string,
): SplitDestination {
    if (tableId === null) return { kind: 'floating' };

    const occupant = drafts.find(
        (order) => order.uuid !== splitUuid && order.restaurant_table_id === tableId,
    );

    return occupant ? { kind: 'merge', tableId, intoUuid: occupant.uuid } : { kind: 'seat', tableId };
}

export type SplitOutcome = {
    /** The bill the waiter should now be looking at — the survivor if a merge happened. */
    orderUuid: string;
    /** Null when the bill was left floating. */
    tableId: number | null;
    merged: boolean;
    /**
     * The split succeeded but the seating did not.
     *
     * Reported rather than thrown, because by this point the money has already moved: the lines are
     * on a new bill and the parent has been decremented. Failing the whole action would describe a
     * split that definitely happened as one that did not, and the waiter would split again.
     */
    seatingError: string | null;
};

/**
 * Split, then put the new bill where the waiter said.
 *
 * Returns null only when there was nothing to split — the same contract `splitOrder` has, so the
 * caller's empty-selection handling does not change.
 */
export async function splitOntoTable(
    orderUuid: string,
    selection: SplitSelection,
    tableId: number | null,
    drafts: readonly { uuid: string; restaurant_table_id: number | null }[],
): Promise<SplitOutcome | null> {
    const splitUuid = await splitOrder(orderUuid, selection);
    if (!splitUuid) return null;

    const destination = destinationFor(tableId, drafts, splitUuid);

    if (destination.kind === 'floating') {
        return { orderUuid: splitUuid, tableId: null, merged: false, seatingError: null };
    }

    if (destination.kind === 'seat') {
        setTable(splitUuid, destination.tableId);
        return { orderUuid: splitUuid, tableId: destination.tableId, merged: false, seatingError: null };
    }

    try {
        const result = await transferOrder(splitUuid, destination.tableId);

        return {
            orderUuid: result.orderUuid,
            tableId: destination.tableId,
            merged: result.merged,
            seatingError: null,
        };
    } catch (error) {
        // The split stands and the bill is floating; say so, rather than reporting the split as
        // failed or silently leaving the waiter to discover it.
        return {
            orderUuid: splitUuid,
            tableId: null,
            merged: false,
            seatingError: error instanceof TableActionError ? error.code : 'failed',
        };
    }
}
