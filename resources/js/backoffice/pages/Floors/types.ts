/**
 * `Floors/Index` and `Floors/Edit` props — spec 05 §12.
 *
 * `tables[]` on the edit page is `attributesToArray()`, so every `restaurant_tables` column is
 * there. The geometry columns are `decimal(10,2)` and therefore arrive as **strings**; the
 * canvas needs numbers, so the conversion happens once, here, in `toCanvasTable`. It is the only
 * place a coordinate crosses that boundary.
 *
 * Coordinates are not money: turning `"120.00"` into `120` is exactly right for a pixel and
 * exactly wrong for a price, which is why this conversion lives beside the geometry and not in
 * `lib/money`.
 */

import type { Rect } from '../../components/floor-plan/geometry';

export type FloorListRow = {
    id: number;
    uuid: string;
    name: string;
    background_color: string | null;
    sequence: number;
    table_count: number;
    active: boolean;
};

export type FloorsIndexProps = {
    floors: FloorListRow[];
};

export type FloorRecord = {
    id: number;
    uuid: string;
    company_id: number;
    name: string;
    background_color: string | null;
    background_media_id: number | null;
    sequence: number;
    table_count: number;
    active: boolean;
    created_at: string | null;
    updated_at: string | null;
    deleted_at: string | null;
};

export type TableRecord = {
    id: number;
    uuid: string;
    restaurant_floor_id: number;
    company_id: number;
    table_number: number;
    name: string | null;
    identifier: string;
    shape: string;
    position_x: string;
    position_y: string;
    width: string;
    height: string;
    seats: number;
    color: string | null;
    parent_id: number | null;
    active: boolean;
    created_at: string | null;
    updated_at: string | null;
    deleted_at: string | null;
};

export type FloorEditProps = {
    floor: FloorRecord;
    tables: TableRecord[];
};

/** The editor's working copy of a table: geometry as numbers, everything else as stored. */
export type PlanTable = Rect & {
    id: number;
    uuid: string;
    table_number: number;
    name: string | null;
    identifier: string;
    shape: 'square' | 'round';
    seats: number;
    color: string | null;
    parent_id: number | null;
    active: boolean;
};

export function toPlanTable(row: TableRecord): PlanTable {
    return {
        id: row.id,
        uuid: row.uuid,
        table_number: row.table_number,
        name: row.name,
        identifier: row.identifier,
        shape: row.shape === 'round' ? 'round' : 'square',
        seats: row.seats,
        color: row.color,
        parent_id: row.parent_id,
        active: row.active,
        x: numeric(row.position_x),
        y: numeric(row.position_y),
        width: numeric(row.width, 50),
        height: numeric(row.height, 50),
    };
}

/** The label the canvas and the register both show for a table. */
export function tableLabel(table: PlanTable): string {
    return table.name && table.name.trim() !== '' ? table.name : String(table.table_number);
}

/** `decimal(10,2)` string → number, with a sane default rather than a `NaN` on the canvas. */
function numeric(value: string | number | null | undefined, fallback = 0): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/** The payload a table would be saved with, once the contract exposes a write for it. */
export function toTablePayload(table: PlanTable): Record<string, string | number | boolean | null> {
    return {
        id: table.id,
        uuid: table.uuid,
        table_number: table.table_number,
        name: table.name,
        shape: table.shape,
        position_x: table.x.toFixed(2),
        position_y: table.y.toFixed(2),
        width: table.width.toFixed(2),
        height: table.height.toFixed(2),
        seats: table.seats,
        color: table.color,
        parent_id: table.parent_id,
        active: table.active,
    };
}

export const SHAPE_OPTIONS = [
    { value: 'square', label: 'Carrée / rectangulaire' },
    { value: 'round', label: 'Ronde' },
] as const;

/** Table colours offered in the inspector — deliberately few, and legible at a distance. */
export const TABLE_COLORS: readonly string[] = [
    '#ffffff',
    '#fee2e2',
    '#ffedd5',
    '#fef9c3',
    '#dcfce7',
    '#cffafe',
    '#dbeafe',
    '#ede9fe',
    '#fce7f3',
    '#e2e8f0',
];
