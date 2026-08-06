import type { ApprovalCommand, OrderCommand, RecordCommand } from '@domain/sync/wire';
import type { ApprovalRow, CourseRow, OrderLineRow, OrderRow, PaymentRow, Uuid } from '@domain/types';
import { asUuid } from '@domain/types';
import { withQuotaRescue, type PosDb } from '@shared/db';
import { createFlusher } from '@shared/store';
import type { OutboxSyncer } from '@shared/sync';

import {
    coursesOf,
    linesOf,
    paymentsOf,
    useOrderStore,
    type OrderSlice,
} from '../state/order-store';
import { orderTotals } from '../domain/totals';

/**
 * The bridge between the in-memory order store and durable storage (spec 03 §3.4.6, §3.6.4).
 *
 * `persist()` marks an order dirty and schedules a 250 ms debounced IndexedDB write. Two overrides
 * are mandatory and both come from Odoo's incident history: flush immediately on payment
 * validation, and flush immediately on `pagehide` / `visibilitychange → hidden`. A crash between
 * "paid" and "flushed" loses money.
 *
 * `enqueue()` turns an order into the ORM-style command the sync endpoint takes. Commands, not
 * documents: appending a line to a 60-line restaurant tab is a 400-byte push rather than a 40 kB
 * one, and the outbox coalesces repeated pushes for the same order into one pending entry.
 */

export type Persistence = {
    persist: (orderUuid: string) => void;
    enqueue: (orderUuid: string) => void;
    /** Force the pending debounced write out immediately. Resolves `false` if a write failed. */
    flushNow: () => Promise<boolean>;
    attachLifecycle: () => () => void;
};

function lineCommand(line: OrderLineRow): RecordCommand<OrderLineRow> {
    return {
        op: line.id === null ? 'create' : 'update',
        uuid: line.uuid,
        product_variant_id: line.product_variant_id,
        product_id: line.product_id,
        pos_category_id: line.pos_category_id,
        full_product_name: line.full_product_name,
        uom_id: line.uom_id,
        quantity: line.quantity,
        price_unit: line.price_unit,
        price_extra: line.price_extra,
        price_type: line.price_type,
        discount_percent: line.discount_percent,
        attribute_line_value_ids: line.attribute_line_value_ids,
        custom_attribute_values: line.custom_attribute_values,
        customer_note: line.customer_note,
        internal_note: line.internal_note,
        combo_parent_uuid: line.combo_parent_uuid,
        combo_id: line.combo_id,
        combo_item_id: line.combo_item_id,
        course_uuid: line.course_uuid,
        refunded_line_uuid: line.refunded_line_uuid,
        refunded_line_id: line.refunded_line_id,
        skip_preparation: line.skip_preparation,
    };
}

function paymentCommand(payment: PaymentRow): RecordCommand<PaymentRow> {
    return {
        op: payment.id === null ? 'create' : 'update',
        uuid: payment.uuid,
        payment_method_id: payment.payment_method_id,
        amount: payment.amount,
        is_change: payment.is_change,
        is_refund: payment.is_refund,
        label: payment.label,
        paid_at: payment.paid_at,
        payment_status: payment.payment_status,
        card_brand: payment.card_brand,
        card_last4: payment.card_last4,
        auth_code: payment.auth_code,
        transaction_reference: payment.transaction_reference,
    };
}

function approvalCommand(approval: ApprovalRow): ApprovalCommand {
    return {
        uuid: approval.uuid,
        ability: approval.ability,
        manager_employee_id: approval.manager_employee_id,
        verified: approval.verified,
        at: approval.at,
        context: approval.context ?? {},
    };
}

function courseCommand(course: CourseRow): RecordCommand<CourseRow> {
    return {
        op: course.id === null ? 'create' : 'update',
        uuid: course.uuid,
        index: course.index,
        name: course.name,
        fired: course.fired,
        fired_at: course.fired_at,
    };
}

/**
 * Build the push command for one order. Exported for the sync tests.
 *
 * `approvals` is passed in rather than read here because it lives in Dexie, not in the order store,
 * and this function is deliberately synchronous and pure.
 */
export function buildOrderCommand(
    state: OrderSlice,
    orderUuid: string,
    approvals: ApprovalCommand[] = [],
): OrderCommand | null {
    const order = state.orders[orderUuid];
    if (!order) return null;

    const totals = orderTotals(orderUuid, state);
    const lines = linesOf(state, orderUuid).map(lineCommand);

    for (const uuid of order.baseline?.deletedLineUuids ?? []) {
        lines.push({ op: 'delete', uuid: asUuid(uuid) });
    }

    return {
        uuid: order.uuid,
        op: order.state === 'cancelled' ? 'cancel' : 'upsert',
        base_rev: order.baseline?.serverRev ?? null,
        order: {
            pos_session_id: order.pos_session_id,
            state: order.state,
            source: order.source,
            access_token: order.access_token,
            receipt_number: order.receipt_number,
            tracking_number: order.tracking_number,
            ticket_code: order.ticket_code,
            customer_id: order.customer_id,
            employee_id: order.employee_id,
            pricelist_id: order.pricelist_id,
            fiscal_position_id: order.fiscal_position_id,
            pos_preset_id: order.pos_preset_id,
            preset_time: order.preset_time,
            restaurant_table_id: order.restaurant_table_id,
            guest_count: order.guest_count,
            floating_order_name: order.floating_order_name,
            general_customer_note: order.general_customer_note,
            internal_note: order.internal_note,
            to_invoice: order.to_invoice,
            is_refund: order.is_refund,
            refunded_order_uuid: order.refunded_order_uuid,
            customer_email: order.customer_email,
            customer_phone: order.customer_phone,
            ordered_at: order.ordered_at,
            client_created_at: order.client_created_at,
            cancel_reason: order.cancel_reason,
            is_tipped: order.is_tipped,
            tip_amount: order.tip_amount,
            // Proposals only — the server recomputes and never trusts these (spec 05 §4).
            amount_total_client: totals.roundedTotal,
            amount_tax_client: totals.tax,
        },
        lines,
        payments: paymentsOf(state, orderUuid).map(paymentCommand),
        courses: coursesOf(state, orderUuid).map(courseCommand),
        approvals,
    };
}

async function writeOrder(db: PosDb, state: OrderSlice, orderUuid: string): Promise<void> {
    const order = state.orders[orderUuid];

    if (!order) {
        // The order was discarded locally: remove it and its graph.
        await db.transaction('rw', [db.orders, db.lines, db.payments, db.courses], async () => {
            await db.orders.delete(orderUuid);
            await db.lines.where('order_uuid').equals(orderUuid).delete();
            await db.payments.where('order_uuid').equals(orderUuid).delete();
            await db.courses.where('order_uuid').equals(orderUuid).delete();
        });
        return;
    }

    const lines = linesOf(state, orderUuid);
    const payments = paymentsOf(state, orderUuid);
    const courses = coursesOf(state, orderUuid);
    const keptLineUuids = new Set<string>(lines.map((line) => line.uuid as string));

    await db.transaction('rw', [db.orders, db.lines, db.payments, db.courses], async () => {
        await db.orders.put(order as OrderRow);
        const stored = await db.lines.where('order_uuid').equals(orderUuid).primaryKeys();
        const orphans = (stored as string[]).filter((uuid) => !keptLineUuids.has(uuid));
        if (orphans.length > 0) await db.lines.bulkDelete(orphans);
        if (lines.length > 0) await db.lines.bulkPut(lines);
        if (payments.length > 0) await db.payments.bulkPut(payments);
        if (courses.length > 0) await db.courses.bulkPut(courses);
    });
}

export function createPersistence(db: PosDb, syncer: OutboxSyncer): Persistence {
    const dirty = new Set<string>();
    // Whether the most recently completed flush hit a write error. flushNow() reads this after its
    // own flush settles (flushes are serialised by the flusher) so it can tell the payment screen a
    // sale did not reach durable storage instead of navigating past a silent loss.
    let lastFlushFailed = false;

    const flush = async (): Promise<void> => {
        const batch = [...dirty];
        dirty.clear();
        let failed = false;
        for (const orderUuid of batch) {
            const state = useOrderStore.getState();
            try {
                await withQuotaRescue(db, () => writeOrder(db, state, orderUuid));
            } catch {
                // Re-arm: a failed write must not silently drop the order from the dirty set.
                dirty.add(orderUuid);
                failed = true;
            }
        }
        lastFlushFailed = failed;
    };

    const flusher = createFlusher(flush, 250);

    return {
        persist: (orderUuid) => {
            dirty.add(orderUuid);
            flusher.schedule();
        },
        enqueue: (orderUuid) => {
            // Approvals are read from Dexie, so this leg is async where the rest of `enqueue` is
            // not. They used to be sent as a hardcoded `[]`: a manager override was recorded on the
            // granting till and nowhere else, so clearing that device's storage — or simply
            // replacing the tablet — erased the record of who authorised the discount. That is the
            // one fact the PIN exists to capture (BAN-413).
            void (async () => {
                let approvals: ApprovalCommand[] = [];

                try {
                    const rows = await db.approvals.where('order_uuid').equals(orderUuid).toArray();
                    approvals = rows.map(approvalCommand);
                } catch {
                    // A failed read must not hold up the sale; the order still goes.
                }

                const command = buildOrderCommand(useOrderStore.getState(), orderUuid, approvals);
                if (!command) return;
                await syncer.enqueueOrder(command);
            })();
        },
        flushNow: async () => {
            flusher.schedule();
            await flusher.flushNow();
            return !lastFlushFailed;
        },
        attachLifecycle: flusher.attachLifecycle,
    };
}

/** Read the dynamic records back at boot (draft orders + anything not yet acknowledged). */
export async function loadOrdersFromDb(db: PosDb): Promise<{
    orders: OrderRow[];
    lines: OrderLineRow[];
    payments: PaymentRow[];
    courses: CourseRow[];
}> {
    const all = await db.orders.toArray();
    const keep = all.filter(
        (order) => order.state === 'draft' || order.syncState !== 'synced' || order.state === 'paid',
    );
    const uuids = keep.map((order) => order.uuid as string);
    if (uuids.length === 0) return { orders: [], lines: [], payments: [], courses: [] };

    const [lines, payments, courses] = await Promise.all([
        db.lines.where('order_uuid').anyOf(uuids).toArray(),
        db.payments.where('order_uuid').anyOf(uuids).toArray(),
        db.courses.where('order_uuid').anyOf(uuids).toArray(),
    ]);

    // Orders stored before `orderScreen` existed come back without the key, so the row would not
    // match its own type. Normalise at the boundary rather than making the field optional and
    // pushing `undefined` into every reader (REG-125).
    const orders = keep.map((order) => ({
        ...order,
        orderScreen: order.orderScreen ?? null,
        serverUpdatedAt: order.serverUpdatedAt ?? null,
        // Same reason as the two above, and this one crashed the till: `computePrepDelta` guarded
        // with `!== null`, so an `undefined` from an older stored row got past it and threw
        // (BAN-506). Normalising at the boundary is what keeps every reader from needing the guard.
        last_prep_snapshot: order.last_prep_snapshot ?? null,
    }));

    return { orders, lines, payments, courses };
}

/** Uuid helper for callers that hold a plain string. */
export function toUuid(value: string): Uuid {
    return asUuid(value);
}
