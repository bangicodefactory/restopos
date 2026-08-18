import { ApiError } from '@shared/sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRuntime, setRuntime, type RegisterRuntime } from '../data/runtime';
import { useOrderStore } from '../state/order-store';
import { installCatalog, makePreset, makeProduct, makeVariant, resetRegisterState } from './__fixtures__/catalog';
import {
    currentDelta,
    fireCourseAndSend,
    knownSnapshotVersion,
    rememberSnapshotVersion,
    sendToKitchen,
    unsentChangeCount,
} from './kitchen-send';
import { addCourse, addLine, createOrder, setLineCourse, setQuantity } from './order-actions';

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

describe('fireCourseAndSend (RST-084 / BAN-408)', () => {
    it('fires only the selected course and leaves the others unsent and fireable', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        const courseA = addCourse(orderUuid, 'Starters');
        const courseB = addCourse(orderUuid, 'Mains');
        const lineA = addLine({ orderUuid, variantId: PIZZA, quantity: 2 });
        const lineB = addLine({ orderUuid, variantId: PIZZA, quantity: 3 });
        setLineCourse(lineA, courseA);
        setLineCourse(lineB, courseB);

        const first = await fireCourseAndSend(orderUuid, courseA);

        expect(first).toMatchObject({ status: 'sent', online: true });
        // One POST, to the fire endpoint of course A — no redundant second send.
        expect(post).toHaveBeenCalledOnce();
        expect(String(post.mock.calls[0]?.[0])).toContain(`courses/${courseA}/fire`);
        expect(first.delta.changes).toHaveLength(1);

        const state = useOrderStore.getState();
        expect(state.courses[courseA]?.fired).toBe(true);
        expect(state.courses[courseB]?.fired).toBe(false);
        // Course B was NOT marked sent — this is the client half of BAN-408.
        expect(unsentChangeCount(orderUuid)).toBe(3);

        // Firing course B afterwards still has its line to send.
        const second = await fireCourseAndSend(orderUuid, courseB);
        expect(second.status).toBe('sent');
        expect(second.delta.changes).toHaveLength(1);
        expect(useOrderStore.getState().courses[courseB]?.fired).toBe(true);
        expect(unsentChangeCount(orderUuid)).toBe(0);
    });

    it('returns outdated when another till fired past our snapshot', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        const course = addCourse(orderUuid, 'Starters');
        const line = addLine({ orderUuid, variantId: PIZZA });
        setLineCourse(line, course);

        post.mockRejectedValueOnce(conflict(null));

        expect((await fireCourseAndSend(orderUuid, course)).status).toBe('outdated');
        // The course must not be marked fired on a conflict.
        expect(useOrderStore.getState().courses[course]?.fired).toBe(false);
    });
});

/**
 * RST-072 (BAN-481) — a preset that plates to a cover count must have one.
 *
 * `pos_presets.use_guest` was read by nothing: the column shipped, `PosPresetRow` did not even
 * declare it, and a dine-in order could reach the pass with no idea how many people were eating.
 *
 * The check lives in `sendToKitchen` rather than in the button's handler on purpose — a guard in one
 * caller is a guard that one caller has, and `fireCourseAndSend` and the offline path both come
 * through here.
 */
describe('the guest count a preset requires', () => {
    const DINE_IN = 1;
    const TAKEAWAY = 2;

    function installPresets(): void {
        installCatalog({
            products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00' })],
            variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
            presets: [
                makePreset({ id: DINE_IN, name: 'Dine in', use_guest: true }),
                makePreset({ id: TAKEAWAY, name: 'Takeaway', use_guest: false }),
            ],
        });
    }

    it('refuses the send and asks, rather than firing a ticket the kitchen cannot plate', async () => {
        installPresets();

        const orderUuid = await createOrder({ tableId: 1, presetId: DINE_IN });
        addLine({ orderUuid, variantId: PIZZA, quantity: 2 });

        const outcome = await sendToKitchen(orderUuid);

        expect(outcome.status).toBe('needs_guests');
        // Nothing reached the server: the refusal has to happen before the snapshot advances, or
        // the second attempt would find nothing left to send.
        expect(post).not.toHaveBeenCalled();
        expect(unsentChangeCount(orderUuid)).toBe(2);
    });

    it('sends once the count is given', async () => {
        installPresets();

        const orderUuid = await createOrder({ tableId: 1, presetId: DINE_IN, guestCount: 4 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 2 });

        expect((await sendToKitchen(orderUuid)).status).toBe('sent');
    });

    it('does not ask on a preset that does not want it', async () => {
        installPresets();

        const orderUuid = await createOrder({ tableId: 1, presetId: TAKEAWAY });
        addLine({ orderUuid, variantId: PIZZA, quantity: 2 });

        expect((await sendToKitchen(orderUuid)).status).toBe('sent');
    });

    it('does not ask on an order with no preset at all', async () => {
        installPresets();

        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 2 });

        expect((await sendToKitchen(orderUuid)).status).toBe('sent');
    });

    it('refuses a course fire too — it does not go through sendToKitchen (review of #61)', async () => {
        // `fireCourseAndSend` posts to the fire endpoint, prints and marks sent entirely on its own.
        // A guard placed only in `sendToKitchen` let a course reach the pass with no cover count:
        // the same defect through the other door.
        installPresets();

        const orderUuid = await createOrder({ tableId: 1, presetId: DINE_IN });
        const courseUuid = addCourse(orderUuid, 'Starters');
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 2 });
        setLineCourse(lineUuid, courseUuid);

        const outcome = await fireCourseAndSend(orderUuid, courseUuid);

        expect(outcome.status).toBe('needs_guests');
        expect(post).not.toHaveBeenCalled();

        // Refused *before* the course is stamped, so it stays fireable rather than being marked
        // sent for food that never printed.
        expect(useOrderStore.getState().courses[courseUuid]?.fired).toBeFalsy();
    });

    it('fires a course once the count is there', async () => {
        installPresets();

        const orderUuid = await createOrder({ tableId: 1, presetId: DINE_IN, guestCount: 4 });
        const courseUuid = addCourse(orderUuid, 'Starters');
        const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 2 });
        setLineCourse(lineUuid, courseUuid);

        const outcome = await fireCourseAndSend(orderUuid, courseUuid);

        // Asserting the fire endpoint was actually reached, not just that the call returned 'sent':
        // a course with no lines attached returns 'nothing' long before the guard, which is how a
        // mis-wired fixture makes this test pass without exercising anything.
        expect(outcome.status).toBe('sent');
        expect(post).toHaveBeenCalledWith(
            `pos/orders/${orderUuid}/courses/${courseUuid}/fire`,
            expect.anything(),
        );
    });

    it('does not ask again when more is added to an order that already has a count', async () => {
        // The rule is "this order has a cover count", not "this order has been sent". A waiter
        // adding a dessert must not be stopped to re-answer a question the kitchen already has.
        installPresets();

        const orderUuid = await createOrder({ tableId: 1, presetId: DINE_IN, guestCount: 4 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 2 });
        expect((await sendToKitchen(orderUuid)).status).toBe('sent');

        addLine({ orderUuid, variantId: PIZZA, quantity: 1 });

        expect((await sendToKitchen(orderUuid)).status).toBe('sent');
    });
});

/**
 * RST-141 (BAN-467) — a collection order needs something the pass can call out.
 *
 * A preset with no table has no number to be called by. Without a name the pass has nothing to shout
 * and every collection order taken that hour is "Direct Sale".
 */
describe('an order that still needs a name', () => {
    const TAKEAWAY = 3;

    function installTakeaway(): void {
        installCatalog({
            products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00' })],
            variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
            presets: [makePreset({ id: TAKEAWAY, name: 'Takeaway' })],
        });
    }

    it('refuses the send until one is given', async () => {
        installTakeaway();

        const orderUuid = await createOrder({ presetId: TAKEAWAY });
        addLine({ orderUuid, variantId: PIZZA, quantity: 1 });

        expect((await sendToKitchen(orderUuid)).status).toBe('needs_name');
        expect(post).not.toHaveBeenCalled();
    });

    it('sends once it has one', async () => {
        installTakeaway();

        const orderUuid = await createOrder({ presetId: TAKEAWAY, floatingOrderName: 'Amina' });
        addLine({ orderUuid, variantId: PIZZA, quantity: 1 });

        expect((await sendToKitchen(orderUuid)).status).toBe('sent');
    });

    it('never asks for a table order — the table is the name', async () => {
        installTakeaway();

        const orderUuid = await createOrder({ presetId: TAKEAWAY, tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 1 });

        expect((await sendToKitchen(orderUuid)).status).toBe('sent');
    });

    it('never asks on a counter sale with no preset', async () => {
        // A till with no service modes would otherwise prompt on every sale.
        installTakeaway();

        const orderUuid = await createOrder();
        addLine({ orderUuid, variantId: PIZZA, quantity: 1 });

        expect((await sendToKitchen(orderUuid)).status).toBe('sent');
    });
});
