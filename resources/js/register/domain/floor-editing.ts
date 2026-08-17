import type { RestaurantTableRow } from '@domain/types';
import type { Rect } from '@shared/floor-plan/geometry';
import { DEFAULT_BOUNDS, duplicateRect, planBounds } from '@shared/floor-plan/geometry';

import { getCatalog, setCatalog } from '../data/catalog';
import { getRuntime } from '../data/runtime';

/**
 * Rearranging the room from the till (RST-030 … RST-038, BAN-449).
 *
 * The interaction model, the snapping and the geometry are the back office's, moved to
 * `@shared/floor-plan` so both surfaces share one canvas. What is register-specific is *this*: the
 * catalog is a Dexie-backed read model that the boot pipeline owns, and an edit has to land in three
 * places — the server, that local table, and the in-memory index the floor screen renders from.
 *
 * **Online only, deliberately.** Every other register mutation is queued through the outbox because
 * losing a sale is unacceptable; moving a table is not a sale. Queuing floor edits would mean
 * merging concurrent room layouts from several tills after the fact, which is a genuinely hard
 * problem in exchange for a convenience nobody asked for — a manager rearranging the room is
 * standing in the venue, on the venue's network. So the call is made synchronously and a failure is
 * reported rather than absorbed.
 *
 * The API speaks `position_x`/`position_y`; the catalog row speaks `position_h`/`position_v`
 * (`Table::toPosRow()` renames them on the way out). Everything crossing that boundary goes through
 * here so the two names never leak into a component.
 */

/** The identity fields `TableRequest` requires on *every* write, partial update or not. */
type TableIdentity = {
    restaurant_floor_id: number;
    table_number: number;
};

export type TablePatch = Partial<{
    position_x: number;
    position_y: number;
    width: number;
    height: number;
    seats: number;
    shape: 'square' | 'round';
    color: string | null;
}>;

function identityOf(table: RestaurantTableRow): TableIdentity {
    return { restaurant_floor_id: table.floor_id, table_number: Number(table.table_number) };
}

/**
 * A 2xx with no body is a contract breach here, not an empty result.
 *
 * Every one of these endpoints answers with the row it wrote, and the row is what the catalog is
 * rebuilt from. Treating a null body as "nothing changed" would leave the till showing the old
 * position while the server holds the new one — a silent divergence, which is worse than a visible
 * failure the manager can retry.
 */
function unwrap<T>(data: T | null): T {
    if (data === null) {
        throw new Error('floor_edit_empty_response');
    }

    return data;
}

/** Fold one changed row into the shared index, keeping `tablesById` in step. */
export function applyTableToCatalog(next: RestaurantTableRow): void {
    const catalog = getCatalog();
    const tables = catalog.tables.some((table) => table.id === next.id)
        ? catalog.tables.map((table) => (table.id === next.id ? next : table))
        : [...catalog.tables, next];

    setCatalog({
        ...catalog,
        tables,
        tablesById: new Map(tables.map((table) => [table.id, table])),
    });
}

export function removeTableFromCatalog(id: number): void {
    const catalog = getCatalog();
    const tables = catalog.tables.filter((table) => table.id !== id);

    setCatalog({
        ...catalog,
        tables,
        tablesById: new Map(tables.map((table) => [table.id, table])),
    });
}

/**
 * The server's answer, translated back into a catalog row.
 *
 * Built from the response rather than from what was sent, so a value the server clamped or
 * normalised is what the room shows. Sending `340.4` and rendering `340.4` while the database holds
 * `340` is how a plan drifts from the plan everyone else sees.
 */
export function toCatalogRow(response: Record<string, unknown>, previous?: RestaurantTableRow): RestaurantTableRow {
    return {
        id: Number(response.id),
        floor_id: Number(response.restaurant_floor_id),
        parent_id: response.parent_id === null || response.parent_id === undefined ? null : Number(response.parent_id),
        table_number: String(response.table_number),
        identifier: (response.identifier as string | null) ?? previous?.identifier ?? null,
        seats: Number(response.seats ?? previous?.seats ?? 1),
        shape: (response.shape as RestaurantTableRow['shape']) ?? previous?.shape ?? 'square',
        position_h: Number(response.position_x ?? 0),
        position_v: Number(response.position_y ?? 0),
        width: Number(response.width ?? 0),
        height: Number(response.height ?? 0),
        color: (response.color as string | null) ?? null,
        active: response.active === undefined ? (previous?.active ?? true) : Boolean(response.active),
    };
}

async function persist(table: RestaurantTableRow, patch: TablePatch): Promise<RestaurantTableRow> {
    const runtime = getRuntime();
    const body = { ...identityOf(table), ...patch };

    const response = await runtime.api.patch<{ table: Record<string, unknown> }>(`pos/tables/${table.id}`, body);
    const next = toCatalogRow(unwrap(response.data).table, table);

    await runtime.db.restaurantTables.put(next);
    applyTableToCatalog(next);

    return next;
}

/** Move or resize a table. `Rect` is in plan units, which are the stored units. */
export async function saveGeometry(table: RestaurantTableRow, rect: Rect): Promise<RestaurantTableRow> {
    return persist(table, {
        position_x: rect.x,
        position_y: rect.y,
        width: rect.width,
        height: rect.height,
    });
}

/** Seats, shape and colour — the property panel's half. */
export async function saveProperties(
    table: RestaurantTableRow,
    properties: Pick<TablePatch, 'seats' | 'shape' | 'color'>,
): Promise<RestaurantTableRow> {
    return persist(table, properties);
}

/**
 * Recolour every table in a selection (RST-038).
 *
 * Sequential rather than `Promise.all`: a bulk recolour is a handful of rows, and firing them
 * together means a partial failure leaves the manager unable to say which ones took. In order, the
 * first failure stops the run and everything before it is already saved and visible.
 */
export async function saveBulkColor(tables: readonly RestaurantTableRow[], color: string | null): Promise<number> {
    let saved = 0;

    for (const table of tables) {
        await persist(table, { color });
        saved += 1;
    }

    return saved;
}

/**
 * A new table in a free slot (RST-034).
 *
 * `duplicateRect` is the back office's smart placement: it walks outward from the source until it
 * finds a rectangle that overlaps nothing. Seeded from the selected table when there is one, so
 * "add" lands next to what the manager is looking at rather than at the origin.
 */
export function placementFor(tables: readonly RestaurantTableRow[], seed?: RestaurantTableRow): Rect {
    const occupied: Rect[] = tables.map((table) => ({
        x: table.position_h,
        y: table.position_v,
        width: table.width,
        height: table.height,
    }));

    const from: Rect = seed
        ? { x: seed.position_h, y: seed.position_v, width: seed.width, height: seed.height }
        : { x: 0, y: 0, width: 80, height: 80 };

    return duplicateRect(from, occupied, { bounds: boundsFor(tables) });
}

/** The plan's extent, never smaller than the default canvas. */
export function boundsFor(tables: readonly RestaurantTableRow[]) {
    return planBounds(
        tables.map((table) => ({
            x: table.position_h,
            y: table.position_v,
            width: table.width,
            height: table.height,
        })),
        DEFAULT_BOUNDS,
    );
}

/** The next free table number on a floor — the label a waiter will call it by. */
export function nextTableNumber(tables: readonly RestaurantTableRow[]): number {
    const used = new Set(tables.map((table) => Number(table.table_number)));

    for (let n = 1; n <= 9999; n += 1) {
        if (!used.has(n)) return n;
    }

    return used.size + 1;
}

export async function addTable(floorId: number, seed?: RestaurantTableRow): Promise<RestaurantTableRow> {
    const runtime = getRuntime();
    const onFloor = getCatalog().tables.filter((table) => table.floor_id === floorId);
    const rect = placementFor(onFloor, seed);

    const response = await runtime.api.post<{ table: Record<string, unknown> }>('pos/tables', {
        restaurant_floor_id: floorId,
        table_number: nextTableNumber(onFloor),
        seats: seed?.seats ?? 4,
        shape: seed?.shape ?? 'square',
        color: seed?.color ?? null,
        position_x: rect.x,
        position_y: rect.y,
        width: rect.width,
        height: rect.height,
    });

    const next = toCatalogRow(unwrap(response.data).table);

    await runtime.db.restaurantTables.put(next);
    applyTableToCatalog(next);

    return next;
}

/** Copy a table, geometry and all, into the nearest free slot (RST-035). */
export async function duplicateTable(table: RestaurantTableRow): Promise<RestaurantTableRow> {
    return addTable(table.floor_id, table);
}

export async function deleteTable(table: RestaurantTableRow): Promise<void> {
    const runtime = getRuntime();

    await runtime.api.delete(`pos/tables/${table.id}`);
    await runtime.db.restaurantTables.delete(table.id);
    removeTableFromCatalog(table.id);
}

/**
 * A new floor, and — where asked — every table on the one it was copied from (RST-036, RST-037).
 *
 * The copy is made **from the catalog**, not by asking the server to clone: the register already
 * holds the plan it is looking at, and a server-side clone would need an endpoint that does not
 * exist. Each table is created through the same guarded `POST /api/pos/tables` as any other, so a
 * duplicated floor cannot smuggle geometry past the validator.
 */
export async function createFloor(name: string, copyFromFloorId?: number): Promise<number> {
    const runtime = getRuntime();

    const response = await runtime.api.post<{ floor: Record<string, unknown> }>('pos/floors', { name });
    const floorId = Number(unwrap(response.data).floor.id);

    const catalog = getCatalog();
    const floors = [
        ...catalog.floors,
        {
            id: floorId,
            name: String(unwrap(response.data).floor.name),
            sequence: Number(unwrap(response.data).floor.sequence ?? 0),
            background_color: (unwrap(response.data).floor.background_color as string | null) ?? null,
            active: true,
        } as (typeof catalog.floors)[number],
    ];

    setCatalog({ ...catalog, floors });

    if (copyFromFloorId !== undefined) {
        for (const source of catalog.tables.filter((table) => table.floor_id === copyFromFloorId)) {
            const created = await runtime.api.post<{ table: Record<string, unknown> }>('pos/tables', {
                restaurant_floor_id: floorId,
                table_number: Number(source.table_number),
                seats: source.seats,
                shape: source.shape,
                color: source.color,
                position_x: source.position_h,
                position_y: source.position_v,
                width: source.width,
                height: source.height,
            });

            const next = toCatalogRow(unwrap(created.data).table);

            await runtime.db.restaurantTables.put(next);
            applyTableToCatalog(next);
        }
    }

    return floorId;
}

export async function renameFloor(floorId: number, name: string): Promise<void> {
    const runtime = getRuntime();

    await runtime.api.patch(`pos/floors/${floorId}`, { name });

    const catalog = getCatalog();

    setCatalog({
        ...catalog,
        floors: catalog.floors.map((floor) => (floor.id === floorId ? { ...floor, name } : floor)),
    });
}
