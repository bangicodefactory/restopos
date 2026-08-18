/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getCatalog } from '../data/catalog';
import { clearRuntime, setRuntime } from '../data/runtime';
import { installCatalog, makeFloor, makeTable, resetRegisterState } from './__fixtures__/catalog';
import { bookTable, bookedMinutes, isBooked, unbookTable } from './table-booking';
import { TableActionError } from './table-transfer';

/**
 * RST-059 (BAN-523) — holding a table, from the till's side.
 *
 * The hold is server-side because it is a claim on a shared resource: two tills holding the same
 * table from their own caches is the state this exists to prevent. So the interesting parts here are
 * that it refuses to guess when there is no connection, and that the catalog is rebuilt from the
 * server's answer — the timestamp every till reads has to be one clock, not each device's idea of
 * "now".
 */

const T1 = 1;

function api(row: Record<string, unknown>) {
    const post = vi.fn(async (path: string, _body?: unknown) => ({ data: { table: row }, path }));

    setRuntime({
        api: { post },
        db: { restaurantTables: { put: vi.fn(async () => undefined) } },
    } as never);

    return post;
}

/** The shape `attributesToArray()` sends back. */
function serverRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: T1,
        restaurant_floor_id: 1,
        table_number: '1',
        parent_id: null,
        seats: 4,
        shape: 'square',
        color: null,
        position_x: 0,
        position_y: 0,
        width: 80,
        height: 80,
        active: true,
        booked_at: null,
        booked_note: null,
        ...overrides,
    };
}

beforeEach(() => {
    clearRuntime();
    resetRegisterState();
    installCatalog({
        floors: [makeFloor({ id: 1 })],
        tables: [makeTable({ id: T1, floor_id: 1, table_number: '1' })],
    });
});

describe('reading a hold', () => {
    it('says a plain table is free', () => {
        expect(isBooked(makeTable({ id: T1, floor_id: 1, table_number: '1' }))).toBe(false);
    });

    it('says a held table is held', () => {
        const table = { ...makeTable({ id: T1, floor_id: 1, table_number: '1' }), booked_at: '2026-08-18T19:40:00.000Z' };

        expect(isBooked(table)).toBe(true);
    });

    it('reports how long it has been held, which is what decides if a party is late', () => {
        const table = { ...makeTable({ id: T1, floor_id: 1, table_number: '1' }), booked_at: '2026-08-18T19:40:00.000Z' };

        expect(bookedMinutes(table, Date.parse('2026-08-18T20:10:00.000Z'))).toBe(30);
    });

    it('reports nothing for a free table rather than zero', () => {
        // Zero would read as "held, just now" on a table nobody has held.
        expect(bookedMinutes(makeTable({ id: T1, floor_id: 1, table_number: '1' }))).toBeNull();
    });

    it('never reports a negative age when the clocks disagree', () => {
        const table = { ...makeTable({ id: T1, floor_id: 1, table_number: '1' }), booked_at: '2026-08-18T20:10:00.000Z' };

        expect(bookedMinutes(table, Date.parse('2026-08-18T19:40:00.000Z'))).toBe(0);
    });
});

describe('taking a hold', () => {
    it('asks the server and adopts its answer', async () => {
        const post = api(serverRow({ booked_at: '2026-08-18T19:40:00.000Z', booked_note: 'Benali, 4' }));

        await bookTable(getCatalog().tables[0]!, 'Benali, 4');

        expect(String(post.mock.calls[0]?.[0])).toContain(`pos/tables/${T1}/book`);

        // Rebuilt from the response, so the time on screen is the server's clock.
        const table = getCatalog().tablesById.get(T1);
        expect(table?.booked_at).toBe('2026-08-18T19:40:00.000Z');
        expect(table?.booked_note).toBe('Benali, 4');
    });

    it('releases the hold and clears the note', async () => {
        api(serverRow({ booked_at: null, booked_note: null }));

        await unbookTable(getCatalog().tables[0]!);

        expect(getCatalog().tablesById.get(T1)?.booked_at).toBeNull();
    });

    it('refuses when there is no connection rather than holding it locally', async () => {
        // Two tills holding the same table from their own caches is the state this prevents. A hold
        // that cannot be taken now can be taken in a moment.
        clearRuntime();

        await expect(bookTable(getCatalog().tables[0]!)).rejects.toBeInstanceOf(TableActionError);
    });

    it('says the reason is the connection, so the message can be the right one', async () => {
        clearRuntime();

        await expect(bookTable(getCatalog().tables[0]!)).rejects.toMatchObject({ code: 'offline' });
    });
});
