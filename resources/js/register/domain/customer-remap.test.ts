import 'fake-indexeddb/auto';

import type { CustomerRow } from '@domain/types';
import { PosDb, dbNameFor } from '@shared/db';
import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useOrderStore } from '../state/order-store';
import { remapPlaceholderCustomer } from './customer-remap';
import { installCatalog, makeConfig, resetRegisterState } from './__fixtures__/catalog';
import { configureOrderActions, createOrder } from './order-actions';

/**
 * The client half of REG-153 (issue #7): once `partner.create` returns the real id, the offline
 * customer's negative placeholder must be swapped everywhere so a *later* order syncs linked.
 */

function makeCustomer(id: number, uuid: string): CustomerRow {
    return {
        id,
        uuid,
        name: 'Chez Ahmed',
        account_balance: '0.0000',
        company_name: null,
        email: null,
        phone: null,
        mobile: null,
        vat: null,
        street: null,
        city: null,
        zip: null,
        country_id: null,
        state_id: null,
        barcode: null,
        pricelist_id: null,
        fiscal_position_id: null,
        loyalty_card_ids: [],
        order_count: 0,
        updated_at: '2026-07-31T00:00:00.000Z',
        searchText: 'chez ahmed',
        phoneDigits: '',
    };
}

let configId = 9100;
let db: PosDb;

beforeEach(() => {
    configId += 1;
    resetRegisterState();
    installCatalog({ config: makeConfig({}) });
    db = new PosDb(configId);
});

afterEach(async () => {
    db.close();
    await Dexie.delete(dbNameFor(configId));
});

it('moves the replica row onto the real id and rewrites orders holding the placeholder', async () => {
    const enqueue = vi.fn();
    configureOrderActions({ enqueue, persist: vi.fn(), onChange: vi.fn() });

    const uuid = 'customer-uuid-1';
    const placeholderId = -1712340000;
    await db.customers.put(makeCustomer(placeholderId, uuid));

    // An order built offline references the placeholder (a seated order queues immediately).
    const orderUuid = await createOrder({ customerId: placeholderId, tableId: 3 });
    expect(useOrderStore.getState().orders[orderUuid]?.customer_id).toBe(placeholderId);

    enqueue.mockClear(); // isolate the re-queue the remap triggers

    const result = await remapPlaceholderCustomer(db, { id: 4211, uuid });
    expect(result).toEqual({ oldId: placeholderId, newId: 4211 });

    // (1) the replica row moved onto the real id — no negative id remains.
    expect(await db.customers.get(placeholderId)).toBeUndefined();
    expect((await db.customers.get(4211))?.uuid).toBe(uuid);

    // (2) the order was rewritten and re-queued so it syncs linked.
    expect(useOrderStore.getState().orders[orderUuid]?.customer_id).toBe(4211);
    expect(enqueue).toHaveBeenCalledOnce();
});

it('leaves an order that references a different customer untouched', async () => {
    configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });

    const uuid = 'customer-uuid-2';
    await db.customers.put(makeCustomer(-999, uuid));

    const orderUuid = await createOrder({ customerId: -111, tableId: 1 }); // a different placeholder
    await remapPlaceholderCustomer(db, { id: 5000, uuid });

    expect(useOrderStore.getState().orders[orderUuid]?.customer_id).toBe(-111);
});

it('is a no-op for an unknown uuid or an already-real id (idempotent)', async () => {
    configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });

    await db.customers.put(makeCustomer(50, 'real-uuid'));

    expect(await remapPlaceholderCustomer(db, { id: 4211, uuid: 'missing' })).toBeNull();
    // oldId 50 is already real → nothing to move.
    expect(await remapPlaceholderCustomer(db, { id: 4211, uuid: 'real-uuid' })).toBeNull();
    expect(await db.customers.get(50)).toBeDefined();
});
