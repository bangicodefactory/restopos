import { beforeEach, expect, it, vi } from 'vitest';

/**
 * BAN-437 — the register routes table transfer/merge/unmerge through the server's TableService and
 * then rebuilds its order slice from the reconciled replica. These tests pin the wiring: the right
 * endpoint + body, the online guard, error-code propagation, the merge-id memory, and that a
 * success triggers the local reload. The server behaviour itself is covered by RestaurantTest.
 */

const { post, orders, reloadAllOrders } = vi.hoisted(() => ({
    post: vi.fn(),
    orders: {} as Record<string, { restaurant_table_id: number | null }>,
    reloadAllOrders: vi.fn(async () => {}),
}));

vi.mock('../boot', () => ({ reloadAllOrders }));
vi.mock('../data/runtime', () => ({ tryRuntime: () => ({ api: { post } }) }));
vi.mock('../state/order-store', () => ({ useOrderStore: { getState: () => ({ orders }) } }));
vi.mock('@shared/sync', async (importOriginal) => ({
    ...((await importOriginal()) as Record<string, unknown>),
    browserOnline: vi.fn(() => true),
}));

import { ApiError, browserOnline } from '@shared/sync';

import { mergeIdFor, mergeOrders, transferOrder, unmergeOrder } from './table-transfer';

beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(orders)) delete orders[key];
    vi.mocked(browserOnline).mockReturnValue(true);
});

it('routes a transfer to the server and returns the survivor', async () => {
    orders['o1'] = { restaurant_table_id: 1 };
    post.mockResolvedValue({ data: { order: { uuid: 'o1', restaurant_table_id: 2 }, merged: false, merge_id: null } });

    const result = await transferOrder('o1', 2);

    expect(post).toHaveBeenCalledWith('pos/orders/o1/transfer', { table_id: 2, employee_id: null });
    expect(result).toEqual({ merged: false, orderUuid: 'o1', mergeId: null });
    expect(reloadAllOrders).toHaveBeenCalledOnce();
});

it('remembers the merge id when a transfer merges into an occupied table', async () => {
    orders['src'] = { restaurant_table_id: 1 };
    post.mockResolvedValue({ data: { order: { uuid: 'tgt', restaurant_table_id: 2 }, merged: true, merge_id: 42 } });

    const result = await transferOrder('src', 2);

    expect(result).toEqual({ merged: true, orderUuid: 'tgt', mergeId: 42 });
    expect(mergeIdFor('tgt')).toBe(42);
});

it('is a no-op when the order is already on the target table', async () => {
    orders['o1'] = { restaurant_table_id: 5 };

    const result = await transferOrder('o1', 5);

    expect(post).not.toHaveBeenCalled();
    expect(result).toEqual({ merged: false, orderUuid: 'o1', mergeId: null });
});

it('refuses to transfer while offline, without hitting the server', async () => {
    orders['o1'] = { restaurant_table_id: 1 };
    vi.mocked(browserOnline).mockReturnValue(false);

    await expect(transferOrder('o1', 2)).rejects.toMatchObject({ code: 'offline' });
    expect(post).not.toHaveBeenCalled();
    expect(reloadAllOrders).not.toHaveBeenCalled();
});

it('surfaces the server refusal code as a typed error', async () => {
    orders['o1'] = { restaurant_table_id: 1 };
    post.mockRejectedValue(new ApiError(422, { kind: 'rejected' } as never, { error: { code: 'transfer_refused' } }));

    await expect(transferOrder('o1', 2)).rejects.toMatchObject({ code: 'transfer_refused' });
    expect(reloadAllOrders).not.toHaveBeenCalled();
});

it('routes an explicit merge and returns the merge id', async () => {
    post.mockResolvedValue({ data: { order: { uuid: 'tgt', restaurant_table_id: 2 }, merge_id: 7 } });

    const id = await mergeOrders('src', 'tgt');

    expect(post).toHaveBeenCalledWith('pos/orders/src/merge', { target_order_uuid: 'tgt', employee_id: null });
    expect(id).toBe(7);
    expect(mergeIdFor('tgt')).toBe(7);
    expect(reloadAllOrders).toHaveBeenCalledOnce();
});

it('does not merge an order into itself', async () => {
    expect(await mergeOrders('same', 'same')).toBeNull();
    expect(post).not.toHaveBeenCalled();
});

it('routes an unmerge and returns the restored order', async () => {
    post.mockResolvedValue({ data: { order: { uuid: 'restored', restaurant_table_id: 1 } } });

    const uuid = await unmergeOrder(42);

    expect(post).toHaveBeenCalledWith('pos/order-merges/42/unmerge', { employee_id: null });
    expect(uuid).toBe('restored');
    expect(reloadAllOrders).toHaveBeenCalledOnce();
});
