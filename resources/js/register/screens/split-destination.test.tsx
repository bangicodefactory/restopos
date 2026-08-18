/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRuntime, setRuntime } from '../data/runtime';
import { installCatalog, makeConfig, makeFloor, makeProduct, makeTable, makeVariant, resetRegisterState } from '../domain/__fixtures__/catalog';
import { addLine, configureOrderActions, createOrder, setTable } from '../domain/order-actions';
import { linesOf, useOrderStore } from '../state/order-store';
import { useUiStore } from '../state/ui-store';
import { SplitScreen } from './SplitScreen';

/**
 * RST-106 (BAN-521) — the destination picker, and what happens when seating fails.
 *
 * The split and the seating are two steps, and only the second can fail. Everything here is about
 * the gap between them: by the time seating is attempted the money has already moved, so the screen
 * has to say the bill is floating **and** make sure the waiter cannot answer that message by
 * splitting again.
 */

const PIZZA = 101;
const T1 = 1;
const T2 = 2;

function install(): void {
    installCatalog({
        config: makeConfig({ is_restaurant: true }),
        products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00' })],
        variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
        floors: [makeFloor({ id: 1 })],
        tables: [
            makeTable({ id: T1, floor_id: 1, table_number: '1' }),
            makeTable({ id: T2, floor_id: 1, table_number: '2' }),
        ],
    });
}

beforeEach(() => {
    clearRuntime();
    resetRegisterState();
    install();
    configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });
});

/** A table order with one line of three, and the split selection primed to move one unit. */
async function seatedOrder(): Promise<{ orderUuid: string; lineUuid: string }> {
    const orderUuid = await createOrder({ tableId: T1, guestCount: 4 });
    const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 3 });

    useUiStore.getState().setSplitQuantity(lineUuid, 1);

    return { orderUuid, lineUuid };
}

describe('the destination picker', () => {
    it('offers the other tables and never the one the bill is already on', async () => {
        const { orderUuid } = await seatedOrder();
        render(<SplitScreen orderUuid={orderUuid} onDone={vi.fn()} onCancel={vi.fn()} />);

        const options = Array.from(screen.getByTestId('split-destination').querySelectorAll('option'));

        // "Leave it floating" plus table 2. Table 1 is where the parent is sitting.
        expect(options).toHaveLength(2);
        expect(options[1]?.textContent).toContain('2');
    });

    it('is absent on a counter sale, which has no table to move away from', async () => {
        const orderUuid = await createOrder({});
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 2 });
        useUiStore.getState().setSplitQuantity(lineUuid, 1);

        render(<SplitScreen orderUuid={orderUuid} onDone={vi.fn()} onCancel={vi.fn()} />);

        expect(screen.queryByTestId('split-destination')).toBeNull();
    });

    it('says so when the chosen table already has a bill', async () => {
        const { orderUuid } = await seatedOrder();

        const other = await createOrder({ tableId: T2, guestCount: 2 });
        setTable(other, T2);

        render(<SplitScreen orderUuid={orderUuid} onDone={vi.fn()} onCancel={vi.fn()} />);

        const options = Array.from(screen.getByTestId('split-destination').querySelectorAll('option'));

        // The waiter is told it is a merge before confirming, not after.
        expect(options[1]?.textContent).toContain('merges');
    });
});

describe('seating a free table', () => {
    it('places the new bill there and hands it to the caller', async () => {
        const { orderUuid } = await seatedOrder();
        const onDone = vi.fn();

        render(<SplitScreen orderUuid={orderUuid} onDone={onDone} onCancel={vi.fn()} />);

        fireEvent.change(screen.getByTestId('split-destination'), { target: { value: String(T2) } });
        fireEvent.click(screen.getByText('Create the bill'));

        await waitFor(() => expect(onDone).toHaveBeenCalled());

        const splitUuid = onDone.mock.calls[0]?.[0] as string;
        expect(useOrderStore.getState().orders[splitUuid]?.restaurant_table_id).toBe(T2);
    });
});

describe('when the seating fails', () => {
    it('cannot be answered by splitting again', async () => {
        // The defect this pins. The message reads as something to retry; the button was still live,
        // and the next tap split *again* — another unit off the parent and a third bill on the
        // table. Probed before the fix: 3 → 2 → 1 units, two split bills.
        const { orderUuid } = await seatedOrder();

        // Occupied destination makes it a merge, and a merge needs the server. No runtime: offline.
        const other = await createOrder({ tableId: T2, guestCount: 2 });
        setTable(other, T2);

        render(<SplitScreen orderUuid={orderUuid} onDone={vi.fn()} onCancel={vi.fn()} />);

        fireEvent.change(screen.getByTestId('split-destination'), { target: { value: String(T2) } });

        const confirm = screen.getByText('Create the bill').closest('button')!;
        fireEvent.click(confirm);

        await waitFor(() => expect(screen.getByTestId('split-seat-error')).toBeTruthy());

        // One split happened, and the parent is down to two.
        expect(linesOf(useOrderStore.getState(), orderUuid).map((line) => line.quantity)).toEqual([2]);

        // The only tap the message can lead to is a no-op.
        expect(confirm.hasAttribute('disabled')).toBe(true);

        fireEvent.click(confirm);
        await waitFor(() => expect(screen.getByTestId('split-seat-error')).toBeTruthy());

        expect(linesOf(useOrderStore.getState(), orderUuid).map((line) => line.quantity)).toEqual([2]);
        expect(
            Object.values(useOrderStore.getState().orders).filter((order) => order.split_from_order_uuid === orderUuid),
        ).toHaveLength(1);
    });

    it('keeps the waiter on the screen so they know the bill is floating', async () => {
        const { orderUuid } = await seatedOrder();
        const other = await createOrder({ tableId: T2, guestCount: 2 });
        setTable(other, T2);

        const onDone = vi.fn();
        render(<SplitScreen orderUuid={orderUuid} onDone={onDone} onCancel={vi.fn()} />);

        fireEvent.change(screen.getByTestId('split-destination'), { target: { value: String(T2) } });
        fireEvent.click(screen.getByText('Create the bill'));

        await waitFor(() => expect(screen.getByTestId('split-seat-error')).toBeTruthy());

        // Navigating away would take the message with it.
        expect(onDone).not.toHaveBeenCalled();
    });

    it('names the connection as the reason when that is what it is', async () => {
        const { orderUuid } = await seatedOrder();
        const other = await createOrder({ tableId: T2, guestCount: 2 });
        setTable(other, T2);

        render(<SplitScreen orderUuid={orderUuid} onDone={vi.fn()} onCancel={vi.fn()} />);

        fireEvent.change(screen.getByTestId('split-destination'), { target: { value: String(T2) } });
        fireEvent.click(screen.getByText('Create the bill'));

        await waitFor(() => expect(screen.getByTestId('split-seat-error').textContent).toContain('connection'));
    });

    it('reports a server refusal differently from being offline', async () => {
        const { orderUuid } = await seatedOrder();
        const other = await createOrder({ tableId: T2, guestCount: 2 });
        setTable(other, T2);

        setRuntime({
            api: { post: vi.fn(async () => { throw new Error('server refused'); }) },
            syncer: { drain: vi.fn(async () => ({ sent: 0, failed: 0 })) },
        } as never);

        render(<SplitScreen orderUuid={orderUuid} onDone={vi.fn()} onCancel={vi.fn()} />);

        fireEvent.change(screen.getByTestId('split-destination'), { target: { value: String(T2) } });
        fireEvent.click(screen.getByText('Create the bill'));

        await waitFor(() => expect(screen.getByTestId('split-seat-error').textContent).toContain('floating'));
    });
});

describe('splitting with no destination', () => {
    it('behaves exactly as it always has', async () => {
        const { orderUuid } = await seatedOrder();
        const onDone = vi.fn();

        render(<SplitScreen orderUuid={orderUuid} onDone={onDone} onCancel={vi.fn()} />);
        fireEvent.click(screen.getByText('Create the bill'));

        await waitFor(() => expect(onDone).toHaveBeenCalled());

        const splitUuid = onDone.mock.calls[0]?.[0] as string;
        expect(useOrderStore.getState().orders[splitUuid]?.restaurant_table_id).toBeNull();
        expect(useOrderStore.getState().orders[orderUuid]?.restaurant_table_id).toBe(T1);
    });
});
