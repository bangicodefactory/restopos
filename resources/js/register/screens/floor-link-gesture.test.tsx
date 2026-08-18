/** @vitest-environment jsdom */
import { useSessionStore } from '@shared/auth';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCatalog } from '../data/catalog';
import { clearRuntime, setRuntime } from '../data/runtime';
import { installCatalog, makeConfig, makeFloor, makeTable, resetRegisterState } from '../domain/__fixtures__/catalog';
import { useOrderStore } from '../state/order-store';
import { FloorScreen } from './FloorScreen';

/**
 * RST-050 (BAN-463) — dragging one table onto another to push them together.
 *
 * A party of eight arrives at two fours. The waiter's gesture is to shove the tables together, and
 * until now the till had no equivalent: the link existed in `TableService` and was reachable only
 * through a hand-written PATCH.
 *
 * The gesture has to survive a room being worked at speed on a carried screen, which is what most of
 * these are about: a tap still opens the table, a slide still scrolls the room, and a drop with
 * second thoughts still costs nothing.
 */

const FLOOR = makeFloor({ id: 1, name: 'Terrace' });

const T3 = makeTable({ id: 33, floor_id: 1, table_number: '3', position_h: 0, position_v: 0, seats: 4 });
const T4 = makeTable({ id: 44, floor_id: 1, table_number: '4', position_h: 200, position_v: 0, seats: 4 });

function api() {
    // Echoes the request the way the controller does, so the catalog is rebuilt from the "server's"
    // answer rather than from what the screen assumed.
    const patch = vi.fn(async (path: string, body: Record<string, unknown>) => ({
        data: {
            table: {
                id: Number(path.split('/').pop()),
                restaurant_floor_id: body.restaurant_floor_id,
                table_number: body.table_number,
                parent_id: body.parent_id ?? null,
                seats: 4,
                shape: 'square',
                color: null,
                position_x: 0,
                position_y: 0,
                width: 80,
                height: 80,
                active: true,
            },
        },
    }));

    const drain = vi.fn(async () => ({ sent: 0, failed: 0 }));
    const put = vi.fn(async () => undefined);

    setRuntime({
        api: { patch, post: vi.fn(), delete: vi.fn() },
        db: { restaurantTables: { put, delete: vi.fn() } },
        syncer: { drain },
    } as never);

    return { patch, drain };
}

function tile(number: string): HTMLElement {
    const found = screen
        .getAllByTestId('table-tile')
        .find((element) => element.getAttribute('data-table-number') === number);

    if (!found) throw new Error(`No tile for table ${number}`);
    return found;
}

/**
 * jsdom's `PointerEvent` carries no `clientX`/`clientY` — they arrive as `undefined`, which would
 * make every distance NaN and quietly pass the "did the finger move" tests without moving anything.
 * A `MouseEvent` of the same type does carry them, and React dispatches on the type name.
 */
function pointer(element: HTMLElement, type: string, x: number, y: number): void {
    fireEvent(element, new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
}

/** Press and hold past the 400 ms threshold — the whole gesture's entry condition. */
function hold(element: HTMLElement, ms = 400): void {
    pointer(element, 'pointerdown', 0, 0);
    // The arm happens on a timer, so the state it sets lands outside React's event batching.
    act(() => void vi.advanceTimersByTime(ms));
}

beforeEach(() => {
    vi.useFakeTimers();
    clearRuntime();
    resetRegisterState();
    installCatalog({
        config: makeConfig({ is_restaurant: true }),
        floors: [FLOOR],
        tables: [T3, T4],
    });
    useSessionStore.setState({
        cashier: { employee_id: 1, name: 'Manon', role: 'manager', abilities: ['table.unmerge'], since: 0 } as never,
        locked: false,
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('arming the drag', () => {
    it('arms after a 400 ms hold', () => {
        api();
        render(<FloorScreen onOpenOrder={vi.fn()} />);

        hold(tile('3'));

        expect(tile('3').getAttribute('data-armed')).toBe('true');
        expect(screen.getByTestId('link-armed')).toBeTruthy();
    });

    it('leaves a shorter tap as a tap, which still opens the table', () => {
        // The gesture shares its surface with the one a waiter uses every thirty seconds. If a brisk
        // tap armed a drag, the room would rearrange itself all evening.
        api();
        const onOpenOrder = vi.fn();
        render(<FloorScreen onOpenOrder={onOpenOrder} />);

        pointer(tile('3'), 'pointerdown', 0, 0);
        act(() => void vi.advanceTimersByTime(200));
        fireEvent.pointerUp(tile('3'));

        expect(tile('3').getAttribute('data-armed')).toBe('false');
        expect(screen.queryByTestId('link-armed')).toBeNull();
    });

    it('cancels the hold when the finger slides, because that is a scroll', () => {
        api();
        render(<FloorScreen onOpenOrder={vi.fn()} />);

        pointer(tile('3'), 'pointerdown', 0, 0);
        act(() => void vi.advanceTimersByTime(200));
        pointer(tile('3'), 'pointermove', 0, 60);
        act(() => void vi.advanceTimersByTime(400));

        expect(tile('3').getAttribute('data-armed')).toBe('false');
    });
});

describe('what lights up as a target', () => {
    it('offers the other table and never the one being dragged', () => {
        api();
        render(<FloorScreen onOpenOrder={vi.fn()} />);

        hold(tile('3'));

        expect(tile('4').getAttribute('data-droppable')).toBe('true');
        expect(tile('3').getAttribute('data-droppable')).toBe('false');
    });

    it('offers nothing at all until a drag is armed', () => {
        api();
        render(<FloorScreen onOpenOrder={vi.fn()} />);

        expect(tile('4').getAttribute('data-droppable')).toBe('false');
    });
});

describe('the drop', () => {
    it('links the two tables', async () => {
        const { patch } = api();
        render(<FloorScreen onOpenOrder={vi.fn()} />);

        hold(tile('4'));
        fireEvent.pointerUp(tile('3'));

        await vi.waitFor(() => expect(patch).toHaveBeenCalled());

        expect(patch.mock.calls[0]?.[0]).toBe('pos/tables/44');
        expect(patch.mock.calls[0]?.[1]).toMatchObject({ parent_id: 33 });
    });

    it('pushes pending edits before linking, so the server merges the current bills', async () => {
        // The link merges the child's bill into the parent's. Merging a stale copy would drop
        // whatever the waiter had just added and not yet sent.
        const { patch, drain } = api();
        render(<FloorScreen onOpenOrder={vi.fn()} />);

        hold(tile('4'));
        fireEvent.pointerUp(tile('3'));

        await vi.waitFor(() => expect(patch).toHaveBeenCalled());

        expect(drain).toHaveBeenCalled();
        expect(Number(drain.mock.invocationCallOrder[0])).toBeLessThan(Number(patch.mock.invocationCallOrder[0]));
    });

    it('does nothing when dropped on empty canvas', async () => {
        const { patch } = api();
        render(<FloorScreen onOpenOrder={vi.fn()} />);

        hold(tile('4'));
        fireEvent.pointerUp(screen.getByTestId('floor-canvas'));

        await vi.waitFor(() => expect(screen.queryByTestId('link-armed')).toBeNull());
        expect(patch).not.toHaveBeenCalled();
    });

    it('does nothing when dropped back on itself', async () => {
        const { patch } = api();
        render(<FloorScreen onOpenOrder={vi.fn()} />);

        hold(tile('4'));
        fireEvent.pointerUp(tile('4'));

        await vi.waitFor(() => expect(screen.queryByTestId('link-armed')).toBeNull());
        expect(patch).not.toHaveBeenCalled();
    });

    it('does not also open the table it was dropped on', async () => {
        // The drop and the tap share a pointer-up. Opening the bill on top of the link would bury
        // the room the waiter is still working in.
        const { patch } = api();
        const onOpenOrder = vi.fn();
        render(<FloorScreen onOpenOrder={onOpenOrder} />);

        hold(tile('4'));
        fireEvent.pointerUp(tile('3'));
        fireEvent.click(tile('3'));

        await vi.waitFor(() => expect(patch).toHaveBeenCalled());

        // Only the link's own navigation to the surviving bill, never the tap's.
        expect(onOpenOrder.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('leaves the next ordinary tap working after the drag is cancelled', async () => {
        // The suppression that stops a drop from also opening the table was armed with the drag, and
        // a cancelled drag produces no tap to consume it — so the flag survived and ate the next
        // real tap. In service: change your mind about moving a table, tap one to take an order,
        // nothing happens, tap again (review of #70).
        const onOpenOrder = vi.fn();
        render(<FloorScreen onOpenOrder={onOpenOrder} />);

        hold(tile('4'));
        fireEvent.pointerUp(screen.getByTestId('floor-canvas'));
        await act(async () => {});

        pointer(tile('3'), 'pointerdown', 0, 0);
        fireEvent.pointerUp(tile('3'));
        fireEvent.click(tile('3'));
        await act(async () => {});

        expect(onOpenOrder).toHaveBeenCalled();
    });

    it('reports a refusal instead of leaving the room looking linked', async () => {
        const { patch } = api();
        patch.mockRejectedValueOnce(new Error('boom'));
        render(<FloorScreen onOpenOrder={vi.fn()} />);

        hold(tile('4'));
        fireEvent.pointerUp(tile('3'));

        await vi.waitFor(() => expect(screen.getByTestId('link-error')).toBeTruthy());
    });
});

describe('a linked pair', () => {
    beforeEach(() => {
        installCatalog({
            config: makeConfig({ is_restaurant: true }),
            floors: [FLOOR],
            tables: [T3, { ...T4, parent_id: 33 }],
        });
    });

    it('renders as one unit carrying both numbers and the combined covers', () => {
        api();
        render(<FloorScreen onOpenOrder={vi.fn()} />);

        expect(tile('3').textContent).toContain('3 & 4');
        expect(tile('3').textContent).toContain('8');
    });

    it('offers unlink on the table that was pushed over', () => {
        api();
        render(<FloorScreen onOpenOrder={vi.fn()} />);

        expect(screen.getAllByTestId('table-unlink').length).toBe(1);
    });

    it('breaks the link when unlink is pressed', async () => {
        const { patch } = api();
        render(<FloorScreen onOpenOrder={vi.fn()} />);

        fireEvent.click(screen.getByTestId('table-unlink'));

        await vi.waitFor(() => expect(patch).toHaveBeenCalled());

        expect(patch.mock.calls[0]?.[0]).toBe('pos/tables/44');
        expect(patch.mock.calls[0]?.[1]).toMatchObject({ parent_id: null });
        await vi.waitFor(() => expect(getCatalog().tablesById.get(44)?.parent_id).toBeNull());
    });

    it('hides unlink from a cashier who may not break a link', () => {
        useSessionStore.setState({
            cashier: { employee_id: 2, name: 'Sami', role: 'cashier', abilities: [], since: 0 } as never,
            locked: false,
        });
        api();
        render(<FloorScreen onOpenOrder={vi.fn()} />);

        expect(screen.queryByTestId('table-unlink')).toBeNull();
    });

    it('opens a new bill with the covers of the whole group', async () => {
        // The tile says eight; opening the bill for four would disagree with the screen it was
        // opened from, and the guest count is what per-cover reporting and course pacing are
        // counted against (review of #70).
        api();
        const onOpenOrder = vi.fn();
        render(<FloorScreen onOpenOrder={onOpenOrder} />);

        pointer(tile('4'), 'pointerdown', 0, 0);
        fireEvent.pointerUp(tile('4'));
        fireEvent.click(tile('4'));

        await vi.waitFor(() => expect(onOpenOrder).toHaveBeenCalled());

        const uuid = onOpenOrder.mock.calls[0]?.[0] as string;
        expect(useOrderStore.getState().orders[uuid]?.guest_count).toBe(8);
    });

    it('offers unlink as a control of its own, not one buried inside the tile', () => {
        // Nested in the tile's button it was invalid HTML, and assistive tech reaches it only by
        // walking into a control it has been told is a single button — leaving the one action here
        // that a second tap cannot undo the least reachable thing on the screen.
        api();
        render(<FloorScreen onOpenOrder={vi.fn()} />);

        const unlink = screen.getByTestId('table-unlink');

        expect(unlink.tagName).toBe('BUTTON');
        expect(unlink.closest('button')).toBe(unlink);
    });

    it('never offers the child as a drop target, which would re-home the whole group', () => {
        api();
        render(<FloorScreen onOpenOrder={vi.fn()} />);

        hold(tile('3'));

        expect(tile('4').getAttribute('data-droppable')).toBe('false');
    });
});
