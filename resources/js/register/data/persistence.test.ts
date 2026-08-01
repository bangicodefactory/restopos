import 'fake-indexeddb/auto';

import { PosDb, dbNameFor } from '@shared/db';
import type { OutboxSyncer } from '@shared/sync';
import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { installCatalog, makeProduct, makeVariant, resetRegisterState } from '../domain/__fixtures__/catalog';
import { addLine, configureOrderActions, createOrder } from '../domain/order-actions';
import { useOrderStore } from '../state/order-store';
import { createPersistence } from './persistence';

/**
 * REG-217 / BAN-423 — validating a payment must force the order to disk, not leave it in the 250 ms
 * write debounce where a crash loses a completed sale. This pins the mechanism the fix relies on:
 * `flushNow()` writes the order immediately, with no debounce window.
 */

const PIZZA = 101;

let configId = 9600;
let db: PosDb;

beforeEach(() => {
    configId += 1;
    resetRegisterState();
    db = new PosDb(configId);
    installCatalog({
        products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00' })],
        variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
    });
});

afterEach(async () => {
    vi.restoreAllMocks();
    db.close();
    await Dexie.delete(dbNameFor(configId));
});

it('flushNow writes the order to IndexedDB immediately, with no debounce window', async () => {
    const syncer = { enqueueOrder: vi.fn(async () => undefined) } as unknown as OutboxSyncer;
    const persistence = createPersistence(db, syncer);
    configureOrderActions({ persist: persistence.persist, enqueue: persistence.enqueue, onChange: () => {} });

    const orderUuid = await createOrder({ tableId: 1 });
    const lineUuid = addLine({ orderUuid, variantId: PIZZA, quantity: 2 });

    // The write is debounced (250 ms) — nothing is on disk yet. This is the crash window the
    // payment-validate flow must not leave open.
    expect(await db.orders.count()).toBe(0);

    // flushNow forces the whole order graph out immediately, no waiting on the debounce, and
    // reports success.
    expect(await persistence.flushNow()).toBe(true);
    expect(await db.orders.count()).toBe(1);
    expect((await db.orders.get(orderUuid))?.uuid).toBe(orderUuid);
    expect((await db.lines.get(lineUuid))?.order_uuid).toBe(orderUuid);
});

it('reports false and keeps the order dirty when the local write fails', async () => {
    const syncer = { enqueueOrder: vi.fn(async () => undefined) } as unknown as OutboxSyncer;
    const persistence = createPersistence(db, syncer);
    configureOrderActions({ persist: persistence.persist, enqueue: persistence.enqueue, onChange: () => {} });

    const orderUuid = await createOrder({ tableId: 1 });
    addLine({ orderUuid, variantId: PIZZA, quantity: 1 });

    // Simulate a durable-store failure (e.g. a corrupt DB the quota rescue can't recover).
    vi.spyOn(db.orders, 'put').mockRejectedValue(new Error('disk full'));

    // The write is reported as failed rather than swallowed — the payment screen warns the cashier.
    expect(await persistence.flushNow()).toBe(false);
    expect(await db.orders.count()).toBe(0);

    // The order stays dirty, so once writes work again a later flush recovers it.
    vi.restoreAllMocks();
    expect(await persistence.flushNow()).toBe(true);
    expect(await db.orders.count()).toBe(1);
});

it('is a no-op when nothing is dirty', async () => {
    const syncer = { enqueueOrder: vi.fn(async () => undefined) } as unknown as OutboxSyncer;
    const persistence = createPersistence(db, syncer);

    await persistence.flushNow();
    expect(await db.orders.count()).toBe(0);
    expect(useOrderStore.getState().orders).toEqual({});
});
