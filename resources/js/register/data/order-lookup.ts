import { WeightSource } from '@domain/enums';
import type { CourseRow, OrderLineRow, OrderRow, PaymentRow, Uuid } from '@domain/types';
import type { ApiClient } from '@shared/sync';

/**
 * The ticket screen's server lookup (REG-293, BAN-465).
 *
 * `GET /api/pos/orders` shipped and had never been called, so the ticket screen could only show
 * orders that happened to be in this browser's memory. After a reload, or from the second till, this
 * morning's order simply did not exist — there was no way to reprint or refund it.
 *
 * The shape is a **two-step cache diff**, which is why the index endpoint returns
 * `{id, uuid, updated_at}` and nothing else:
 *
 *  1. pull the index — cheap, and the whole page of it costs less than one order graph;
 *  2. compare each record against the local replica and fetch **only** the bodies that are missing
 *     or stale.
 *
 * A cashier paging through yesterday's trade re-fetches nothing they already hold. Fetching every
 * body would work and would also make the ticket screen the most expensive thing on the till.
 *
 * Nothing here writes to the store or to Dexie; it returns plain data. The caller decides what to
 * hydrate, which keeps this module testable without a database or a React tree.
 */

/** One row of the index — deliberately not an `OrderRow`; it is a summary, not an order. */
export type OrderIndexRecord = {
    id: number;
    uuid: string;
    name: string | null;
    receipt_number: string;
    state: string;
    amount_total: string;
    ordered_at: string;
    updated_at: string;
};

export type OrderIndexPage = {
    records: OrderIndexRecord[];
    next_cursor: number | null;
    /**
     * How many orders match, or null on a cursor page — the server does not recount something it
     * already answered on page one, so the caller keeps the value it was first given.
     */
    total: number | null;
};

export type OrderGraph = {
    orders: OrderRow[];
    lines: OrderLineRow[];
    payments: PaymentRow[];
    courses: CourseRow[];
};

export type LookupQuery = {
    state?: string | null;
    from?: string | null;
    to?: string | null;
    search?: string | null;
    cursor?: number | null;
    limit?: number | null;
};

/** What the caller already holds, so the diff can decide what is stale. */
export type LocalReplica = {
    /** Server `updated_at` of the copy held locally, or undefined when it is not held at all. */
    updatedAtOf: (uuid: string) => string | undefined;
    /** True when the local copy has unsent changes — it must never be overwritten by a fetch. */
    isDirty: (uuid: string) => boolean;
};

export const DEFAULT_PAGE_SIZE = 50;

export async function fetchOrderIndex(
    api: ApiClient,
    query: LookupQuery = {},
): Promise<OrderIndexPage> {
    const response = await api.get<OrderIndexPage>('pos/orders', {
        query: {
            state: query.state ?? null,
            from: query.from ?? null,
            to: query.to ?? null,
            search: query.search ?? null,
            cursor: query.cursor ?? null,
            limit: query.limit ?? DEFAULT_PAGE_SIZE,
        },
    });

    return response.data ?? { records: [], next_cursor: null, total: 0 };
}

/**
 * Which of the index's uuids need their body fetched.
 *
 * A locally dirty order is never included. The local copy is the one with the cashier's unsent
 * edits in it, and a fetch would overwrite them with the server's older truth — the outbox exists
 * precisely to push those edits up, not to have them replaced on the way past.
 */
export function staleUuids(records: OrderIndexRecord[], replica: LocalReplica): string[] {
    const out: string[] = [];

    for (const record of records) {
        if (replica.isDirty(record.uuid)) continue;

        const local = replica.updatedAtOf(record.uuid);
        if (local === undefined || local !== record.updated_at) out.push(record.uuid);
    }

    return out;
}

/**
 * Fetch the given orders' full graphs, in parallel but bounded.
 *
 * Unbounded, a 50-row page would open 50 sockets at once on a device that also has a payment
 * terminal and a printer on the same network. Failures are dropped rather than thrown: one order
 * that 404s (deleted on the server since the index was built) must not lose the other forty-nine.
 */
export async function fetchOrderGraphs(
    api: ApiClient,
    uuids: string[],
    concurrency = 4,
): Promise<OrderGraph> {
    const merged: OrderGraph = { orders: [], lines: [], payments: [], courses: [] };
    const queue = [...uuids];

    const worker = async (): Promise<void> => {
        for (let uuid = queue.shift(); uuid !== undefined; uuid = queue.shift()) {
            try {
                const response = await api.get<ServerOrder>(`pos/orders/${uuid}`);
                if (!response.data) continue;
                const graph = toClientRows(response.data);
                merged.orders.push(...graph.orders);
                merged.lines.push(...graph.lines);
                merged.payments.push(...graph.payments);
                merged.courses.push(...graph.courses);
            } catch {
                // Offline or gone. The index row stays visible from the local replica if we have it.
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, uuids.length) }, worker));

    return merged;
}

/** The whole lookup: index, diff, hydrate the difference. */
export async function lookupOrders(
    api: ApiClient,
    replica: LocalReplica,
    query: LookupQuery = {},
): Promise<{ page: OrderIndexPage; fetched: OrderGraph }> {
    const page = await fetchOrderIndex(api, query);
    const stale = staleUuids(page.records, replica);
    const fetched = await fetchOrderGraphs(api, stale);

    return { page, fetched };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire → client rows
// ─────────────────────────────────────────────────────────────────────────────

type ServerLine = Record<string, unknown> & { id: number; uuid: string };
type ServerPayment = Record<string, unknown> & { id: number; uuid: string };
type ServerCourse = Record<string, unknown> & { id: number; uuid: string };
type ServerOrder = Record<string, unknown> & {
    uuid: string;
    lines?: ServerLine[];
    payments?: ServerPayment[];
    courses?: ServerCourse[];
};

/**
 * Map one server order graph onto the client's row types.
 *
 * Two things make this more than a rename:
 *
 *  - the server speaks in **ids** for intra-order links (`combo_parent_line_id`,
 *    `restaurant_course_id`) while the client speaks in **uuids**, so those are resolved through a
 *    map built from the same payload rather than by a second round trip;
 *  - the client row carries fields the server never sends because they are local bookkeeping
 *    (`syncState`, `updatedAtLocal`, `rev`). A fetched order is by definition synced, and marking it
 *    so is what keeps it out of the outbox — hydrating an order as dirty would push the server's own
 *    data back at it.
 */
export function toClientRows(payload: ServerOrder): OrderGraph {
    const orderUuid = payload.uuid as Uuid;
    const lines = payload.lines ?? [];
    const courses = payload.courses ?? [];

    const lineUuidById = new Map<number, string>(lines.map((line) => [line.id, line.uuid]));
    const courseUuidById = new Map<number, string>(courses.map((course) => [course.id, course.uuid]));

    const serverUpdatedAt = str(payload.updated_at, '');

    const order = {
        uuid: orderUuid,
        id: num(payload.id, 0) || null,
        pos_session_id: num(payload.pos_session_id, 0),
        pos_config_id: num(payload.pos_config_id, 0),
        company_id: num(payload.company_id, 0),
        pos_device_id: numOrNull(payload.pos_device_id),

        name: strOrNull(payload.name),
        receipt_number: str(payload.receipt_number, ''),
        tracking_number: str(payload.tracking_number, ''),
        sequence_number: numOrNull(payload.sequence_number),
        access_token: str(payload.access_token, ''),
        ticket_code: strOrNull(payload.ticket_code),
        source: str(payload.source, 'pos'),

        state: str(payload.state, 'draft'),
        ordered_at: str(payload.ordered_at, serverUpdatedAt),
        paid_at: strOrNull(payload.paid_at),
        closed_at: strOrNull(payload.closed_at),
        cancelled_at: strOrNull(payload.cancelled_at),
        cancel_reason: strOrNull(payload.cancel_reason),

        customer_id: numOrNull(payload.customer_id),
        employee_id: numOrNull(payload.employee_id),
        pricelist_id: numOrNull(payload.pricelist_id),
        fiscal_position_id: numOrNull(payload.fiscal_position_id),
        pos_preset_id: numOrNull(payload.pos_preset_id),
        preset_time: strOrNull(payload.preset_time),
        currency_id: num(payload.currency_id, 0),
        currency_rate: str(payload.currency_rate, '1'),
        floating_order_name: strOrNull(payload.floating_order_name),

        // Read from the payload, never defaulted. `is_tipped`, `tip_amount` and
        // `refunded_order_uuid` all travel back up in the outbox command, so a default here is not
        // a display gap — it is the client overwriting the server's own record the first time
        // anything touches the order, and a reprint counts as touching it (BAN-465).
        amount_untaxed: str(payload.amount_untaxed, '0'),
        amount_tax: str(payload.amount_tax, '0'),
        amount_total: str(payload.amount_total, '0'),
        amount_rounding: str(payload.amount_rounding, '0'),
        amount_paid: str(payload.amount_paid, '0'),
        amount_change: str(payload.amount_change, '0'),
        amount_due: str(payload.amount_due, '0'),
        amount_discount: str(payload.amount_discount, '0'),

        restaurant_table_id: numOrNull(payload.restaurant_table_id),
        guest_count: num(payload.guest_count, 0),
        is_tipped: bool(payload.is_tipped),
        tip_amount: str(payload.tip_amount, '0'),
        split_from_order_uuid: strOrNull(payload.split_from_order_uuid),
        split_letter: strOrNull(payload.split_letter),

        is_refund: bool(payload.is_refund),
        refunded_order_uuid: strOrNull(payload.refunded_order_uuid),
        to_invoice: bool(payload.to_invoice),

        general_customer_note: strOrNull(payload.general_customer_note),
        internal_note: strOrNull(payload.internal_note),
        prep_state: str(payload.prep_state, 'none'),
        unsent_change_count: num(payload.unsent_change_count, 0),
        last_prep_sent_at: strOrNull(payload.last_prep_sent_at),
        last_prep_snapshot: null,

        self_order_table_id: numOrNull(payload.self_order_table_id),
        table_stand_number: strOrNull(payload.table_stand_number),
        customer_email: strOrNull(payload.customer_email),
        customer_phone: strOrNull(payload.customer_phone),

        print_count: num(payload.print_count, 0),
        is_edited: bool(payload.is_edited),
        client_created_at: str(payload.ordered_at, serverUpdatedAt),

        updatedAtLocal: Date.parse(serverUpdatedAt) || 0,
        syncState: 'synced',
        syncError: null,
        rev: 0,
        orderScreen: null,
        /** The server timestamp this copy was built from — the cache diff compares against it. */
        serverUpdatedAt,
    } as unknown as OrderRow;

    return {
        orders: [order],
        lines: lines.map((line) => toLineRow(line, orderUuid, lineUuidById, courseUuidById)),
        payments: (payload.payments ?? []).map((payment) => toPaymentRow(payment, orderUuid, order)),
        courses: courses.map((course) => toCourseRow(course, orderUuid)),
    };
}

function toLineRow(
    line: ServerLine,
    orderUuid: Uuid,
    lineUuidById: Map<number, string>,
    courseUuidById: Map<number, string>,
): OrderLineRow {
    const parentId = numOrNull(line.combo_parent_line_id);
    const courseId = numOrNull(line.restaurant_course_id);

    return {
        uuid: line.uuid as Uuid,
        id: line.id,
        order_uuid: orderUuid,
        line_number: num(line.line_number, 0),

        product_variant_id: num(line.product_variant_id, 0),
        product_id: num(line.product_id, 0),
        pos_category_id: numOrNull(line.pos_category_id),
        full_product_name: str(line.full_product_name, ''),
        uom_id: num(line.uom_id, 0),

        quantity: Number.parseFloat(str(line.quantity, '0')),
        price_unit: str(line.price_unit, '0'),
        price_extra: str(line.price_extra, '0'),
        price_type: str(line.price_type, 'fixed'),
        discount_percent: str(line.discount_percent, '0'),
        discount_notice: strOrNull(line.discount_notice),

        price_subtotal: str(line.price_subtotal, '0'),
        price_subtotal_incl: str(line.price_subtotal_incl, '0'),

        tax_ids: [],
        attribute_line_value_ids: intArray(line.attribute_line_value_ids),
        custom_attribute_values: [],

        customer_note: strOrNull(line.customer_note),
        internal_note: (line.internal_note ?? null) as OrderLineRow['internal_note'],

        combo_parent_uuid: (parentId === null ? null : (lineUuidById.get(parentId) ?? null)) as Uuid | null,
        combo_id: numOrNull(line.combo_id),
        combo_item_id: numOrNull(line.combo_item_id),
        course_uuid: (courseId === null ? null : (courseUuidById.get(courseId) ?? null)) as Uuid | null,

        refunded_line_uuid: null,
        refunded_line_id: numOrNull(line.refunded_order_line_id),
        refunded_quantity: Number.parseFloat(str(line.refunded_quantity, '0')),

        skip_preparation: bool(line.skip_preparation),
        is_edited: bool(line.is_edited),
        // XCT-058 — a line fetched back from the server keeps its provenance, so a refund taken
        // from the ticket screen still knows the original weight was read rather than typed.
        weight_source: weightSourceOf(line.weight_source),
        rev: 0,
    } as unknown as OrderLineRow;
}

function toPaymentRow(payment: ServerPayment, orderUuid: Uuid, order: OrderRow): PaymentRow {
    return {
        uuid: payment.uuid as Uuid,
        id: payment.id,
        order_uuid: orderUuid,
        pos_session_id: num(payment.pos_session_id, order.pos_session_id),
        payment_method_id: num(payment.payment_method_id, 0),
        currency_id: num(payment.currency_id, order.currency_id),
        amount: str(payment.amount, '0'),
        is_change: bool(payment.is_change),
        is_refund: bool(payment.is_refund),
        label: strOrNull(payment.label),
        paid_at: str(payment.paid_at, order.ordered_at),
        customer_id: numOrNull(payment.customer_id),
        employee_id: numOrNull(payment.employee_id),
        payment_status: str(payment.payment_status, 'done'),

        card_brand: strOrNull(payment.card_brand),
        card_last4: strOrNull(payment.card_last4),
        auth_code: strOrNull(payment.auth_code),
        transaction_reference: strOrNull(payment.transaction_reference),
        terminal_ticket: strOrNull(payment.terminal_ticket),
        rev: 0,
    } as unknown as PaymentRow;
}

function toCourseRow(course: ServerCourse, orderUuid: Uuid): CourseRow {
    return {
        uuid: course.uuid as Uuid,
        id: course.id,
        order_uuid: orderUuid,
        index: num(course.course_index, 0),
        name: strOrNull(course.name),
        fired: bool(course.fired),
        fired_at: strOrNull(course.fired_at),
        rev: 0,
    } as unknown as CourseRow;
}

// ── coercion ─────────────────────────────────────────────────────────────────
// The wire is JSON from a PHP resource: numbers arrive as numbers, money as strings, and anything
// nullable can be null. These keep the mapper above readable rather than a wall of casts.

function str(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;
}

function strOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
}

function num(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function numOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = num(value, Number.NaN);
    return Number.isFinite(parsed) ? parsed : null;
}

function bool(value: unknown): boolean {
    return value === true || value === 1 || value === '1';
}

/**
 * XCT-058 — an unrecognised provenance becomes null, never a guess.
 *
 * "We do not know where this weight came from" is a true statement about an old row written before
 * the column existed. Defaulting to `manual` would be a claim about a cashier, and defaulting to
 * `scale` would be a claim about an instrument; both are worse than the honest gap.
 */
function weightSourceOf(value: unknown): WeightSource | null {
    return value === WeightSource.Scale || value === WeightSource.Manual ? value : null;
}

function intArray(value: unknown): number[] {
    return Array.isArray(value)
        ? value.map((entry) => num(entry, Number.NaN)).filter((entry) => Number.isFinite(entry))
        : [];
}
