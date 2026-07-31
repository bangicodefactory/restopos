import { ApiError } from '@shared/sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRuntime, setRuntime, type RegisterRuntime } from '../data/runtime';
import { useOrderStore } from '../state/order-store';
import { installCatalog, makeProduct, makeVariant, resetRegisterState } from './__fixtures__/catalog';
import {
    currentDelta,
    knownSnapshotVersion,
    rememberSnapshotVersion,
    sendToKitchen,
    unsentChangeCount,
} from './kitchen-send';
import { addLine, createOrder, setQuantity } from './order-actions';

/**
 * Unit coverage for KDS-056 … KDS-058 — the send, and in particular KDS-057: when another till has
 * fired past our snapshot the server's answer wins and **nothing prints**.
 */

const PIZZA = 101;

let post: ReturnType<typeof vi.fn>;
let enqueueCommand: ReturnType<typeof vi.fn>;

function installRuntime(): void {
    post = vi.fn(async () => ({ data: { snapshot_version: 7 }, status: 200, etag: null, notModified: false }));
    enqueueCommand = vi.fn(async () => undefined);

    setRuntime({
        api: { post, get: vi.fn() },
        syncer: { enqueueCommand },
        // No prep printers bound: printing is covered by the printing tests, the send is not.
        printer: { getBindings: () => [] },
    } as unknown as RegisterRuntime);
}

function conflict(body: unknown): ApiError {
    return new ApiError(409, { kind: 'conflict', reason: 'stale_write', serverState: null }, body);
}

beforeEach(() => {
    resetRegisterState();
    rememberSnapshotVersion('reset', 0);
    installCatalog({
        products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00' })],
        variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
    });
    installRuntime();
});

afterEach(() => {
    clearRuntime();
    vi.unstubAllGlobals();
});

describe('currentDelta / unsentChangeCount', () => {
    it('counts everything on a never-sent order', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 3 });

        expect(unsentChangeCount(orderUuid)).toBe(3);
        expect(currentDelta(orderUuid).changes).toHaveLength(1);
    });

    it('is empty for an unknown order', () => {
        expect(currentDelta('nope').changes).toEqual([]);
        expect(unsentChangeCount('nope')).toBe(0);
    });
});

describe('sendToKitchen', () => {
    it('does nothing when the kitchen is already up to date', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA });
        await sendToKitchen(orderUuid);

        const second = await sendToKitchen(orderUuid);
        expect(second.status).toBe('nothing');
        expect(post).toHaveBeenCalledOnce();
    });

    it('advances the local snapshot and remembers the server version', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 2 });

        const outcome = await sendToKitchen(orderUuid, { courseIndex: 1 });

        expect(outcome).toMatchObject({ status: 'sent', online: true, printed: 0 });
        expect(knownSnapshotVersion(orderUuid)).toBe(7);

        const order = useOrderStore.getState().orders[orderUuid];
        expect(order?.prep_state).toBe('sent');
        expect(order?.last_prep_snapshot?.lines).toEqual({ [`${lineUuid}::|[]`]: 2 });
        expect(unsentChangeCount(orderUuid)).toBe(0);
    });

    it('sends only the difference on the second pass', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 2 });
        await sendToKitchen(orderUuid);

        setQuantity(lineUuid, 5);
        const outcome = await sendToKitchen(orderUuid);

        expect(outcome.status).toBe('sent');
        expect(outcome.delta.changes).toEqual([
            expect.objectContaining({ lineUuid, quantity: 3, changeType: 'new' }),
        ]);
    });

    /** KDS-057 — another till fired first: adopt the server's snapshot and print nothing. */
    it('reports outdated on a conflict and adopts the server snapshot', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 2 });

        post.mockRejectedValueOnce(
            conflict({
                delta: {
                    order_uuid: orderUuid,
                    nbr_of_changes: 2,
                    count: '2',
                    snapshot_version: 42,
                    snapshot_at: '2026-07-28T13:00:00.000Z',
                },
            }),
        );

        const outcome = await sendToKitchen(orderUuid);

        expect(outcome.status).toBe('outdated');
        expect(knownSnapshotVersion(orderUuid)).toBe(42);

        const order = useOrderStore.getState().orders[orderUuid];
        expect(order?.last_prep_sent_at).toBe('2026-07-28T13:00:00.000Z');
        // Nothing was marked as sent locally — the till must not believe it fired.
        expect(order?.prep_state).toBe('none');
    });

    it('survives a conflict whose body carries no delta', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA });
        post.mockRejectedValueOnce(conflict(null));

        expect((await sendToKitchen(orderUuid)).status).toBe('outdated');
        expect(knownSnapshotVersion(orderUuid)).toBe(0);
    });

    it('falls back to an offline send when the request cannot leave the device', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 2 });
        post.mockRejectedValueOnce(new ApiError(undefined, { kind: 'offline' }, null));

        const outcome = await sendToKitchen(orderUuid);

        expect(outcome).toMatchObject({ status: 'sent', online: false });
        expect(useOrderStore.getState().orders[orderUuid]?.prep_state).toBe('sent');
    });

    it('prints and queues a prep.sent command while the browser reports offline', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 2 });
        vi.stubGlobal('navigator', { onLine: false });

        const outcome = await sendToKitchen(orderUuid, { courseIndex: 2 });

        expect(outcome).toMatchObject({ status: 'sent', online: false });
        expect(post).not.toHaveBeenCalled();
        expect(enqueueCommand).toHaveBeenCalledWith('prep.sent', {
            order_uuid: orderUuid,
            snapshot_version: 0,
            course_index: 2,
        });
        expect(useOrderStore.getState().orders[orderUuid]?.prep_state).toBe('sent');
    });

    it('reports a genuine server failure without pretending the kitchen was told', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA });
        post.mockRejectedValueOnce(new ApiError(500, { kind: 'server_unreachable', status: 500 }, null));

        const outcome = await sendToKitchen(orderUuid);

        expect(outcome.status).toBe('failed');
        expect(useOrderStore.getState().orders[orderUuid]?.prep_state).toBe('none');
        expect(unsentChangeCount(orderUuid)).toBe(1);
    });
});
