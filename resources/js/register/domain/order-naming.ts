import type { RestaurantTableRow } from '@domain/types';

/**
 * What an order is called (RST-140, RST-141).
 *
 * The name existed only as a rendered string: `OrderPanel` worked out "Table 5" or "Direct sale" at
 * paint time and `floating_order_name` stayed null. So the ticket screen, the receipt, the kitchen
 * and a second till each saw whatever they could derive on their own — usually the raw reference —
 * and the one place that got it right was the panel the waiter happened to be looking at.
 *
 * Derived here and **stored**, so every surface reads the same string instead of four surfaces
 * re-deriving it from different data.
 *
 * The linked form is `T 3 & 4`, matching what a waiter says out loud when two tables are pushed
 * together. Children are sorted numerically rather than by id, because "T 4 & 3" is the same table
 * pair described backwards and reads as a different one.
 */

export type NamingContext = {
    /** The table this order sits on, if any. */
    table: RestaurantTableRow | null;
    /** Tables linked *into* that table — the children of a merge. */
    linked: readonly RestaurantTableRow[];
    /** A name the cashier typed. Always wins. */
    manual?: string | null;
};

/** How a table number renders on its own: `T 3`. */
function label(table: RestaurantTableRow): string {
    return `T ${table.table_number}`;
}

/**
 * The name to store on an order.
 *
 * A manual name wins outright — somebody looked at this order and decided what to call it, and no
 * amount of table movement should overwrite that. Everything else is derived.
 */
export function orderName(context: NamingContext): string {
    const manual = context.manual?.trim();

    if (manual !== undefined && manual !== '') return manual;

    if (context.table === null) return 'Direct Sale';

    if (context.linked.length === 0) return label(context.table);

    const numbers = [context.table, ...context.linked]
        .map((table) => Number(table.table_number))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);

    return `T ${numbers.join(' & ')}`;
}

/**
 * Does this order still owe a name? (RST-141)
 *
 * A preset with no table is a takeaway or a collection: there is no table number to call it by, so
 * without a typed name the pass has nothing to shout and the order is "Direct Sale" alongside every
 * other one taken that hour. Asked before the first send, which is the last moment the customer is
 * still standing there.
 */
export function needsOrderName(input: {
    hasTable: boolean;
    hasPreset: boolean;
    name: string | null | undefined;
}): boolean {
    if (input.hasTable || !input.hasPreset) return false;

    return (input.name ?? '').trim() === '';
}
