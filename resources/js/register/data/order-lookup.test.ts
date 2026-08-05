import { describe, expect, it, vi } from 'vitest';

import {
    fetchOrderGraphs,
    fetchOrderIndex,
    lookupOrders,
    staleUuids,
    toClientRows,
    type LocalReplica,
    type OrderIndexRecord,
} from './order-lookup';

/**
 * BAN-465 — the ticket screen's two-step cache diff.
 *
 * The point of the design is what it does *not* fetch. A cashier paging through yesterday's trade
 * pulls a cheap index and hydrates only the handful of bodies that are missing or stale; fetching
 * every body would also work and would make the ticket screen the most expensive thing on the till.
 * So most of these assert on the absence of requests.
 */

function record(overrides: Partial<OrderIndexRecord> = {}): OrderIndexRecord {
    return {
        id: 1,
        uuid: 'u1',
        name: 'A/0001',
        receipt_number: 'RC-1',
        state: 'paid',
        amount_total: '10.00',
        ordered_at: '2026-08-05T10:00:00Z',
        updated_at: '2026-08-05T10:00:00Z',
        ...overrides,
    };
}

function replica(held: Record<string, string>, dirty: string[] = []): LocalReplica {
    return {
        updatedAtOf: (uuid) => held[uuid],
        isDirty: (uuid) => dirty.includes(uuid),
    };
}

/** A stand-in for ApiClient that records every path it was asked for. */
function fakeApi(responses: Record<string, unknown>): { api: never; paths: string[] } {
    const paths: string[] = [];
    const api = {
        get: (path: string) => {
            paths.push(path);
            if (!(path in responses)) return Promise.reject(new Error(`no stub for ${path}`));
            return Promise.resolve({ data: responses[path], status: 200, etag: null, notModified: false });
        },
    };

    return { api: api as never, paths };
}

describe('staleUuids', () => {
    it('asks for nothing when every record is already held at the same version', () => {
        const records = [record({ uuid: 'a' }), record({ uuid: 'b', id: 2 })];
        const local = replica({ a: records[0]!.updated_at, b: records[1]!.updated_at });

        expect(staleUuids(records, local)).toEqual([]);
    });

    it('asks for an order it has never seen', () => {
        expect(staleUuids([record({ uuid: 'new' })], replica({}))).toEqual(['new']);
    });

    it('asks for an order whose server copy has moved on', () => {
        const records = [record({ uuid: 'a', updated_at: '2026-08-05T12:00:00Z' })];

        expect(staleUuids(records, replica({ a: '2026-08-05T10:00:00Z' }))).toEqual(['a']);
    });

    it('never re-fetches an order with unsent local changes', () => {
        // The local copy is the one holding the cashier's edits. Overwriting it with the server's
        // older truth would discard work the outbox has not pushed yet.
        const records = [record({ uuid: 'dirty', updated_at: '2026-08-05T12:00:00Z' })];
        const local = replica({ dirty: '2026-08-05T10:00:00Z' }, ['dirty']);

        expect(staleUuids(records, local)).toEqual([]);
    });
});

describe('fetchOrderIndex', () => {
    it('sends the filters and defaults the page size', async () => {
        const get = vi.fn().mockResolvedValue({ data: { records: [], next_cursor: null, total: 0 } });

        await fetchOrderIndex({ get } as never, { state: 'paid', search: 'smith', limit: 25 });

        expect(get).toHaveBeenCalledWith('pos/orders', {
            query: { state: 'paid', from: null, to: null, search: 'smith', cursor: null, limit: 25 },
        });
    });

    it('survives a 304 with no body', async () => {
        const get = vi.fn().mockResolvedValue({ data: null, status: 304, etag: null, notModified: true });

        await expect(fetchOrderIndex({ get } as never)).resolves.toEqual({
            records: [],
            next_cursor: null,
            total: 0,
        });
    });
});

describe('fetchOrderGraphs', () => {
    it('keeps the other orders when one of them fails', async () => {
        // An order deleted on the server between the index and the hydrate must not empty the page.
        const { api, paths } = fakeApi({
            'pos/orders/ok': { uuid: 'ok', lines: [], payments: [], courses: [] },
        });

        const graph = await fetchOrderGraphs(api, ['gone', 'ok']);

        expect(paths).toHaveLength(2);
        expect(graph.orders.map((order) => order.uuid)).toEqual(['ok']);
    });

    it('requests nothing for an empty list', async () => {
        const { api, paths } = fakeApi({});

        await fetchOrderGraphs(api, []);

        expect(paths).toEqual([]);
    });
});

describe('lookupOrders', () => {
    it('fetches only the bodies the replica is missing', async () => {
        const { api, paths } = fakeApi({
            'pos/orders': {
                records: [record({ uuid: 'held' }), record({ uuid: 'missing', id: 2 })],
                next_cursor: null,
                total: 2,
            },
            'pos/orders/missing': { uuid: 'missing', lines: [], payments: [], courses: [] },
        });

        const { page, fetched } = await lookupOrders(api, replica({ held: '2026-08-05T10:00:00Z' }));

        expect(page.total).toBe(2);
        expect(fetched.orders.map((order) => order.uuid)).toEqual(['missing']);
        // The whole contract: the index, then exactly one body — not two.
        expect(paths).toEqual(['pos/orders', 'pos/orders/missing']);
    });
});

describe('toClientRows', () => {
    const payload = {
        id: 7,
        uuid: 'order-1',
        state: 'paid',
        amount_total: '24.20',
        updated_at: '2026-08-05T10:00:00Z',
        ordered_at: '2026-08-05T09:55:00Z',
        lines: [
            { id: 11, uuid: 'line-parent', quantity: '1', full_product_name: 'Menu', price_unit: '10.00' },
            {
                id: 12,
                uuid: 'line-child',
                quantity: '1',
                full_product_name: 'Coffee',
                price_unit: '0.00',
                combo_parent_line_id: 11,
                restaurant_course_id: 21,
                attribute_line_value_ids: [5, 6],
            },
        ],
        payments: [{ id: 31, uuid: 'pay-1', amount: '24.20', payment_status: 'done', payment_method_id: 2 }],
        courses: [{ id: 21, uuid: 'course-1', course_index: 1, fired: true }],
    };

    it('resolves intra-order links from ids to uuids', () => {
        const { lines } = toClientRows(payload);
        const child = lines.find((line) => line.uuid === 'line-child');

        // The server speaks ids, the client speaks uuids, and the map comes from this same payload
        // rather than a second round trip.
        expect(child?.combo_parent_uuid).toBe('line-parent');
        expect(child?.course_uuid).toBe('course-1');
    });

    it('carries the chosen attributes so a refund reprices correctly', () => {
        const { lines } = toClientRows(payload);

        // Without these a refund of a "large, oat milk" coffee is created at the plain price.
        expect(lines.find((line) => line.uuid === 'line-child')?.attribute_line_value_ids).toEqual([5, 6]);
    });

    it('marks a fetched order synced and stamps the server version it came from', () => {
        const { orders } = toClientRows(payload);

        // Hydrating as dirty would push the server's own data straight back at it.
        expect(orders[0]?.syncState).toBe('synced');
        expect(orders[0]?.serverUpdatedAt).toBe('2026-08-05T10:00:00Z');
    });

    it('round-trips through the diff without asking for the order again', () => {
        const { orders } = toClientRows(payload);
        const held = replica({ 'order-1': orders[0]!.serverUpdatedAt ?? '' });

        // The stamp above is only worth writing if the next index pass believes it.
        expect(staleUuids([record({ uuid: 'order-1', updated_at: '2026-08-05T10:00:00Z' })], held)).toEqual([]);
    });

    it('carries the fields that travel back up in the outbox command', () => {
        // A hydrated order is not read-only. The first thing that touches it — a reprint, say —
        // pushes the whole row up, and `is_tipped`, `tip_amount` and `refunded_order_uuid` are all
        // writable on ingest. Defaulting them here does not leave a display gap; it overwrites the
        // server's own record with a guess.
        const { orders } = toClientRows({
            ...payload,
            is_tipped: true,
            tip_amount: '3.00',
            print_count: 4,
            currency_id: 7,
            company_id: 2,
            refunded_order_uuid: 'original-order',
        });

        expect(orders[0]?.is_tipped).toBe(true);
        expect(orders[0]?.tip_amount).toBe('3.00');
        expect(orders[0]?.refunded_order_uuid).toBe('original-order');
        expect(orders[0]?.print_count).toBe(4);
        expect(orders[0]?.currency_id).toBe(7);
        expect(orders[0]?.company_id).toBe(2);
    });

    it('tolerates an order with no children at all', () => {
        const graph = toClientRows({ uuid: 'bare', updated_at: '2026-08-05T10:00:00Z' });

        expect(graph.orders).toHaveLength(1);
        expect(graph.lines).toEqual([]);
        expect(graph.payments).toEqual([]);
        expect(graph.courses).toEqual([]);
    });
});
