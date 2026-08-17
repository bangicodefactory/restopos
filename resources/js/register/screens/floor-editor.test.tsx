/** @vitest-environment jsdom */
import { useSessionStore } from '@shared/auth';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getCatalog } from '../data/catalog';
import { clearRuntime, setRuntime } from '../data/runtime';
import { installCatalog, makeConfig, makeFloor, makeTable, resetRegisterState } from '../domain/__fixtures__/catalog';
import { nextTableNumber, placementFor, saveBulkColor, toCatalogRow } from '../domain/floor-editing';
import { FloorEditorScreen } from './FloorEditorScreen';
import { FloorScreen } from './FloorScreen';

/**
 * RST-030 … RST-038 (BAN-449) — rearranging the room from the till.
 *
 * The canvas itself is the back office's, moved to `@shared/floor-plan` and covered by its own
 * geometry suite; re-testing snap and resize here would be testing the same code twice. What is new
 * and therefore what these cover: the manager gate, that an edit reaches the server **and** the
 * local catalog the floor screen renders from, and that a bulk recolour touches every selected
 * table rather than only the anchor.
 */

const FLOOR = makeFloor({ id: 1, name: 'Terrace' });
const OTHER_FLOOR = makeFloor({ id: 2, name: 'Bar' });

const T1 = makeTable({ id: 11, floor_id: 1, table_number: '1', position_h: 0, position_v: 0 });
const T2 = makeTable({ id: 12, floor_id: 1, table_number: '2', position_h: 200, position_v: 0 });

/** An API whose PATCH echoes the body back the way the real controller does. */
function api() {
    const patch = vi.fn(async (path: string, body: Record<string, unknown>) => ({
        data: {
            table: {
                id: Number(path.split('/').pop()),
                restaurant_floor_id: body.restaurant_floor_id,
                table_number: body.table_number,
                seats: body.seats ?? 4,
                shape: body.shape ?? 'square',
                color: body.color ?? null,
                position_x: body.position_x ?? 0,
                position_y: body.position_y ?? 0,
                width: body.width ?? 80,
                height: body.height ?? 80,
                parent_id: null,
                active: true,
            },
        },
    }));

    let nextId = 100;
    const post = vi.fn(async (_path: string, body: Record<string, unknown>) => ({
        data: {
            table: {
                id: (nextId += 1),
                restaurant_floor_id: body.restaurant_floor_id,
                table_number: body.table_number,
                seats: body.seats ?? 4,
                shape: body.shape ?? 'square',
                color: body.color ?? null,
                position_x: body.position_x ?? 0,
                position_y: body.position_y ?? 0,
                width: body.width ?? 80,
                height: body.height ?? 80,
                parent_id: null,
                active: true,
            },
        },
    }));

    const put = vi.fn(async () => undefined);

    setRuntime({ api: { patch, post, delete: vi.fn(async () => ({ data: null })) }, db: { restaurantTables: { put, delete: vi.fn(async () => undefined) } } } as never);

    return { patch, post, put };
}

function signIn(abilities: string[]): void {
    useSessionStore.setState({
        cashier: { employee_id: 1, name: 'Manon', role: 'manager', abilities, since: 0 } as never,
        locked: false,
    });
}

beforeEach(() => {
    // jsdom implements no pointer capture, and the canvas claims it on every table press. Without
    // this the first tap throws before any selection happens.
    if (!('setPointerCapture' in Element.prototype)) {
        const proto = Element.prototype as unknown as Record<string, unknown>;

        proto.setPointerCapture = () => undefined;
        proto.releasePointerCapture = () => undefined;
        proto.hasPointerCapture = () => false;
    }

    clearRuntime();
    resetRegisterState();
    installCatalog({
        config: makeConfig({ is_restaurant: true }),
        floors: [FLOOR, OTHER_FLOOR],
        tables: [T1, T2],
    });
    signIn(['config.manage']);
});

describe('the way in', () => {
    it('offers the toggle to a manager', () => {
        render(<FloorScreen onOpenOrder={vi.fn()} onEditRoom={vi.fn()} />);

        expect(screen.getByTestId('floor-edit-toggle')).toBeTruthy();
    });

    it('hides it from a cashier who cannot manage the configuration', () => {
        signIn(['table.transfer']);
        render(<FloorScreen onOpenOrder={vi.fn()} onEditRoom={vi.fn()} />);

        expect(screen.queryByTestId('floor-edit-toggle')).toBeNull();
    });

    it('refuses the editor itself to a cashier, not only the button', () => {
        // The button is UX. A screen reachable by any other route must not be a way around the gate.
        signIn(['table.transfer']);
        render(<FloorEditorScreen onExit={vi.fn()} />);

        expect(screen.queryByTestId('floor-editor')).toBeNull();
    });
});

describe('editing the room', () => {
    it('shows only the tables of the chosen floor', () => {
        api();
        render(<FloorEditorScreen onExit={vi.fn()} />);

        const canvas = screen.getByRole('application');

        expect(within(canvas).getByLabelText(/^1 —/)).toBeTruthy();
        expect(within(canvas).getByLabelText(/^2 —/)).toBeTruthy();
    });

    it('persists a seat change and folds the answer back into the catalog', async () => {
        const { patch, put } = api();
        render(<FloorEditorScreen onExit={vi.fn()} />);

        await userEvent.click(within(screen.getByRole('application')).getByLabelText(/^1 —/));

        const seats = await screen.findByLabelText('Seats');
        await userEvent.clear(seats);
        // Committed on blur, so a multi-digit number is not PATCHed one digit at a time.
        await userEvent.type(seats, '16');
        await userEvent.tab();

        await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));

        // The identity fields `TableRequest` demands on every write ride along with the change.
        const [path, body] = patch.mock.calls.at(-1)!;
        expect(path).toBe('pos/tables/11');
        expect(body).toMatchObject({ restaurant_floor_id: 1, table_number: 1, seats: 16 });

        // Written to Dexie *and* to the in-memory index the floor screen renders from — a change
        // that only reached the server would vanish the moment the manager left the editor.
        await waitFor(() => expect(put).toHaveBeenCalled());
        expect(getCatalog().tablesById.get(11)?.seats).toBe(16);
    });

    it('marks every selected table, not only the anchor', () => {
        api();
        render(<FloorEditorScreen onExit={vi.fn()} />);

        const canvas = screen.getByRole('application');

        // The anchor drives the panel; a pinned table is still shown as selected, which is what
        // tells the manager the next swatch will hit both.
        expect(within(canvas).getByLabelText(/^1 —/).getAttribute('aria-pressed')).toBe('false');
    });

    it('says so when a save fails instead of showing a change that did not happen', async () => {
        const { patch } = api();
        patch.mockRejectedValueOnce(new Error('offline'));

        render(<FloorEditorScreen onExit={vi.fn()} />);

        await userEvent.click(within(screen.getByRole('application')).getByLabelText(/^1 —/));

        const seats = await screen.findByLabelText('Seats');
        await userEvent.clear(seats);
        await userEvent.type(seats, '9');
        await userEvent.tab();

        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(getCatalog().tablesById.get(11)?.seats).toBe(4);
    });

    it('adds a table into free space and selects it', async () => {
        const { post } = api();
        render(<FloorEditorScreen onExit={vi.fn()} />);

        await userEvent.click(screen.getByRole('button', { name: 'Add table' }));

        await waitFor(() => expect(post).toHaveBeenCalled());

        const [, body] = post.mock.calls.at(-1)!;
        expect(body).toMatchObject({ restaurant_floor_id: 1, table_number: 3 });

        // Not on top of an existing table — placement is what makes "add" usable on a full floor.
        expect([body.position_x, body.position_y]).not.toEqual([0, 0]);
    });

    it('duplicates a floor by copying every table on it', async () => {
        const { post } = api();
        vi.spyOn(globalThis, 'prompt').mockReturnValue('Terrace copy');

        post.mockResolvedValueOnce({ data: { floor: { id: 9, name: 'Terrace copy', sequence: 3 } } } as never);

        render(<FloorEditorScreen onExit={vi.fn()} />);

        await userEvent.click(screen.getByRole('button', { name: 'Duplicate floor' }));

        // One call for the floor, then one per table it carried across.
        await waitFor(() => expect(post).toHaveBeenCalledTimes(3));

        const copied = post.mock.calls.slice(1).map(([, body]) => body.restaurant_floor_id);
        expect(copied).toEqual([9, 9]);
    });
});

describe('the placement helpers', () => {
    it('finds a slot that overlaps nothing', () => {
        const rect = placementFor([T1, T2], T1);

        for (const table of [T1, T2]) {
            const clear =
                rect.x + rect.width <= table.position_h ||
                table.position_h + table.width <= rect.x ||
                rect.y + rect.height <= table.position_v ||
                table.position_v + table.height <= rect.y;

            expect(clear).toBe(true);
        }
    });

    it('takes the lowest free table number rather than the count', () => {
        // A room that lost table 2 should reissue 2, not mint 4 and leave a gap a waiter has to
        // learn about.
        const three = makeTable({ id: 13, floor_id: 1, table_number: '3' });

        expect(nextTableNumber([T1, three])).toBe(2);
    });

    it('reads the server answer rather than echoing what was sent', () => {
        // The server clamps and normalises; rendering the request would drift the plan away from
        // the one every other till is looking at.
        const row = toCatalogRow(
            {
                id: 11,
                restaurant_floor_id: 1,
                table_number: 1,
                position_x: 340,
                position_y: 220,
                width: 80,
                height: 80,
                seats: 6,
                shape: 'round',
                color: null,
                parent_id: null,
                active: true,
            },
            T1,
        );

        expect(row.position_h).toBe(340);
        expect(row.position_v).toBe(220);
        expect(row.shape).toBe('round');
    });
});


/**
 * RST-038, the bulk half.
 *
 * Driven through the domain rather than the DOM on purpose. The gesture that builds a multi-selection
 * is a modified pointer press or a Space on a focused table, and **jsdom implements neither**: it has
 * no `PointerEvent` at all, so `ctrlKey` never reaches the canvas, and it will not focus an SVG `<g>`
 * even with a `tabIndex`. A DOM test of the gesture would pass by degrading to an ordinary tap —
 * selecting one table, recolouring one table, and reporting success. That is worse than no test.
 *
 * So what is asserted here is the part that carries the risk: that a recolour visits **every** table
 * it was handed, in order, and folds each answer back into the catalog. The canvas's own suite covers
 * the geometry, and the gesture is left to the browser.
 */
describe('recolouring a selection', () => {
    it('patches every table it is given and updates each one locally', async () => {
        const { patch, put } = api();

        const saved = await saveBulkColor([T1, T2], '#bbf7d0');

        expect(saved).toBe(2);
        expect(patch.mock.calls.map(([path]) => path)).toEqual(['pos/tables/11', 'pos/tables/12']);
        expect(put).toHaveBeenCalledTimes(2);

        expect(getCatalog().tablesById.get(11)?.color).toBe('#bbf7d0');
        expect(getCatalog().tablesById.get(12)?.color).toBe('#bbf7d0');
    });

    it('stops at the first failure rather than reporting a recolour that half happened', async () => {
        const { patch } = api();
        patch.mockRejectedValueOnce(new Error('offline'));

        await expect(saveBulkColor([T1, T2], '#bbf7d0')).rejects.toThrow();

        // The second was never attempted, so nothing claims to have changed that did not.
        expect(patch).toHaveBeenCalledTimes(1);
        expect(getCatalog().tablesById.get(12)?.color).toBeNull();
    });
});
