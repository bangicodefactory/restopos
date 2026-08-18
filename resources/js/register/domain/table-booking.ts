import type { RestaurantTableRow } from '@domain/types';
import { ApiError, browserOnline } from '@shared/sync';

import { getRuntime, tryRuntime } from '../data/runtime';
import { applyTableToCatalog, toCatalogRow } from './floor-editing';
import { TableActionError } from './table-transfer';

/**
 * Holding a table for a booking (RST-059, BAN-523).
 *
 * Until now a booked table looked exactly like a free one on every screen, so the only place a
 * reservation existed was the paper book by the door — and whoever was not standing next to it
 * seated the 20:30 party's table at 20:00.
 *
 * **Online only**, like transfer and merge, and for a plainer reason: a booking is a claim on a
 * shared resource. Two tills holding the same table from their own caches is precisely the state
 * this exists to prevent, and there is no sale at stake to justify queueing it — a hold that cannot
 * be taken now can be taken in a moment.
 */

/** Is this table being held? */
export function isBooked(table: RestaurantTableRow): boolean {
    return (table.booked_at ?? null) !== null;
}

/**
 * How long it has been held, in whole minutes.
 *
 * Null when the table is free. This is the number that decides whether a party is late, which is why
 * the column is a timestamp rather than a flag.
 */
export function bookedMinutes(table: RestaurantTableRow, now: number = Date.now()): number | null {
    const at = table.booked_at ?? null;
    if (at === null) return null;

    return Math.max(0, Math.floor((now - new Date(at).getTime()) / 60_000));
}

function requireOnline(): void {
    if (!tryRuntime() || !browserOnline()) {
        throw new TableActionError('offline', 'Booking a table needs a connection.');
    }
}

function fail(error: unknown): never {
    if (error instanceof ApiError) {
        if (error.sync.kind === 'offline') {
            throw new TableActionError('offline', 'Booking a table needs a connection.');
        }
        const code = (error.body as { error?: { code?: string } } | null)?.error?.code;
        throw new TableActionError(code ?? 'failed', error.message);
    }
    throw error;
}

async function post(table: RestaurantTableRow, action: 'book' | 'unbook', note?: string | null): Promise<void> {
    const runtime = getRuntime();

    let body: { table: Record<string, unknown> } | null;
    try {
        body = (
            await runtime.api.post<{ table: Record<string, unknown> }>(
                `pos/tables/${table.id}/${action}`,
                action === 'book' ? { note: note ?? null } : {},
            )
        ).data;
    } catch (error) {
        fail(error);
    }

    if (!body) throw new TableActionError('failed', 'The booking returned no table.');

    // Rebuilt from the server's answer, so the timestamp every till reads is the server's one clock
    // rather than each device's idea of "now".
    const next = toCatalogRow(body.table, table);
    await runtime.db.restaurantTables.put(next);
    applyTableToCatalog(next);
}

/** Hold the table. `note` is a name off the booking sheet, not a customer record. */
export async function bookTable(table: RestaurantTableRow, note?: string | null): Promise<void> {
    requireOnline();
    await post(table, 'book', note);
}

/** Release the hold. Any bill on the table is untouched. */
export async function unbookTable(table: RestaurantTableRow): Promise<void> {
    requireOnline();
    await post(table, 'unbook');
}
