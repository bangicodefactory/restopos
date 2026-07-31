import type { PosDb } from '@shared/db';

import { useOrderStore } from '../state/order-store';
import { setCustomer } from './order-actions';

/**
 * Reconcile a customer created offline once its `partner.create` command has synced — the
 * cross-batch half of REG-153 (issue #7); the server half shipped in BAN-404.
 *
 * Offline the register mints a new customer with a **negative placeholder id** so it cannot collide
 * with a server id. When `partner.create` reaches the server it is created with a real positive id,
 * returned on the sync result as `{ partner: { id, uuid } }`. This swaps the placeholder for the
 * real id everywhere the local replica still points at it:
 *
 *   1. the Dexie `customers` row (so a *later* order selecting this customer gets the real id), and
 *   2. any in-memory order still holding the placeholder — `setCustomer` re-queues it, and the
 *      outbox coalesces the pending entry, so a not-yet-synced order goes up linked.
 *
 * Without this, a later order for the same customer keeps the placeholder id and syncs in a batch
 * with no `partner.create` alongside it, so the server cannot resolve it and drops `customer_id` to
 * null — the customer exists, but the order silently unlinks.
 *
 * Idempotent: a second run (or a positive/absent id) is a no-op.
 */
export async function remapPlaceholderCustomer(
    db: PosDb,
    partner: { id: number; uuid: string },
): Promise<{ oldId: number; newId: number } | null> {
    // `customers` is keyed by id and does not index uuid, so match by scan. `filter().first()`
    // short-circuits and avoids materialising the whole table; partner.create is rare anyway.
    const local = await db.customers.filter((row) => row.uuid === partner.uuid).first();
    if (!local) return null;

    const oldId = local.id;
    const newId = partner.id;

    // Only a negative placeholder needs moving; a real id means we already reconciled (or never had
    // a placeholder), so there is nothing to do.
    if (newId <= 0 || oldId >= 0 || oldId === newId) return null;

    // 1. Move the replica row onto the real id (the table is keyed by id, so re-key by delete+put).
    await db.transaction('rw', db.customers, async () => {
        await db.customers.delete(oldId);
        await db.customers.put({ ...local, id: newId });
    });

    // 2. Rewrite any in-memory order still pointing at the placeholder. `setCustomer` re-queues each
    //    one — necessary, not redundant: a same-batch order the server already reconciled re-syncs
    //    as a no-op, but a cross-batch order that synced *before* this and had its customer_id nulled
    //    is only relinked by this re-queue. (Loaded orders only; a settled order sitting in Dexie but
    //    not in the store keeps whatever link was resolved when it synced — relinking a paid order is
    //    out of scope.)
    for (const [uuid, order] of Object.entries(useOrderStore.getState().orders)) {
        if (order.customer_id === oldId) setCustomer(uuid, newId);
    }

    return { oldId, newId };
}
