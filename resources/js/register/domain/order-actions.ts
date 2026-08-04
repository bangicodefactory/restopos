import { Decimal, ZERO } from '@domain/money/decimal';
import { generateReceiptToken, generateUuid } from '@domain/sequence/index';
import type { PriceType } from '@domain/enums';
import type {
    CourseRow,
    OrderLineRow,
    OrderRow,
    PaymentRow,
    PrepSnapshot,
    Uuid,
} from '@domain/types';
import { asUuid } from '@domain/types';

import {
    baseListPrice,
    fullProductName,
    getCatalog,
    primaryCategoryOf,
    taxIdsFor,
    type CatalogIndex,
} from '../data/catalog';
import {
    childLinesOf,
    coursesOf,
    forgetOrder,
    indexCourse,
    indexLine,
    indexPayment,
    linesOf,
    paymentsOf,
    unindexLine,
    useOrderStore,
    type OrderSlice,
} from '../state/order-store';
import { buildPrepSnapshot, computePrepDelta, prepKey } from './kitchen-delta';
import { isZeroQuantity, roundQuantity, trimQuantity } from './precision';
import { clampSelection, nextSplitLetter, splitPrepSnapshot, type SplitSelection } from './split';
import { invalidateTotals, orderTotals } from './totals';

/**
 * **The** order mutation module.
 *
 * Every change to an order — a tapped product, a discount, a payment, a course fire — goes through
 * exactly one of these functions, and each one does the same three things in the same order:
 *
 *   1. mutate the normalised store (which the IndexedDB flusher mirrors),
 *   2. bump `order.rev` so the memoised totals recompute exactly once,
 *   3. enqueue an outbox command for the order.
 *
 * No component ever calls the API. That is not a style preference: the register must behave
 * identically with the network unplugged, and the only way to guarantee that is to make "write
 * locally, queue the push" the sole path. A component that could `fetch` would eventually be a
 * component that only works online.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────

export type ActionContext = {
    configId: number;
    companyId: number;
    currencyId: number;
    sessionId: number;
    deviceId: number | null;
    deviceSeq: number;
    employeeId: number | null;
    /** More than one till on this config → the tracking number gets a device letter (spec 03 §6.1). */
    multiDevice: boolean;
    /** Mints `26D02-1-000412` from the durable Dexie counter. */
    nextReference: () => Promise<{ reference: string; counter: number }>;
};

export type OrderActionDeps = {
    context: () => ActionContext;
    /** Schedule the debounced IndexedDB flush for this order. */
    persist: (orderUuid: string) => void;
    /** Build and enqueue the outbox command for this order. */
    enqueue: (orderUuid: string) => void;
    /** Fires after every mutation — the customer display and the floor plan listen. */
    onChange: (orderUuid: string) => void;
};

let counter = 0;

const defaultDeps: OrderActionDeps = {
    context: () => ({
        configId: 1,
        companyId: 1,
        currencyId: 1,
        sessionId: 1,
        deviceId: null,
        deviceSeq: 1,
        employeeId: null,
        multiDevice: false,
        nextReference: async () => {
            counter += 1;
            return { reference: `LOCAL-${String(counter).padStart(6, '0')}`, counter };
        },
    }),
    persist: () => {},
    enqueue: () => {},
    onChange: () => {},
};

let deps: OrderActionDeps = defaultDeps;

export function configureOrderActions(overrides: Partial<OrderActionDeps>): void {
    deps = { ...defaultDeps, ...overrides };
}

/** Test helper: back to the inert defaults. */
export function resetOrderActions(): void {
    deps = defaultDeps;
    counter = 0;
}

function mutate(recipe: (state: OrderSlice) => void): void {
    useOrderStore.getState().mutate(recipe);
}

function snapshot(): OrderSlice {
    return useOrderStore.getState();
}

/** Bump the order revision, stamp the clock, and mark it dirty for the sync engine. */
function touch(state: OrderSlice, orderUuid: string): void {
    const order = state.orders[orderUuid];
    if (!order) return;
    order.rev += 1;
    order.updatedAtLocal = Date.now();
    if (order.syncState === 'synced' || order.syncState === 'error') order.syncState = 'local';
}

function commit(orderUuid: string, options: { queue?: boolean } = {}): void {
    invalidateTotals(orderUuid);
    deps.persist(orderUuid);
    if (options.queue !== false) deps.enqueue(orderUuid);
    deps.onChange(orderUuid);
}

// ─────────────────────────────────────────────────────────────────────────────
// Factories
// ─────────────────────────────────────────────────────────────────────────────

export type NewOrderInput = {
    tableId?: number | null;
    guestCount?: number;
    presetId?: number | null;
    pricelistId?: number | null;
    fiscalPositionId?: number | null;
    customerId?: number | null;
    floatingOrderName?: string | null;
    isRefund?: boolean;
    refundedOrderUuid?: string | null;
    splitFromOrderUuid?: string | null;
    splitLetter?: string | null;
};

function nowIso(): string {
    return new Date().toISOString();
}

export async function createOrder(input: NewOrderInput = {}): Promise<string> {
    const context = deps.context();
    const catalog = getCatalog();
    const { reference, counter: sequence } = await context.nextReference();
    const uuid = generateUuid();
    const at = nowIso();

    const order: OrderRow = {
        uuid: asUuid(uuid),
        id: null,
        pos_session_id: context.sessionId,
        pos_config_id: context.configId,
        company_id: context.companyId,
        pos_device_id: context.deviceId,

        name: null,
        receipt_number: reference,
        tracking_number: String(((sequence % 1000) + 1000) % 1000).padStart(3, '0'),
        sequence_number: null,
        access_token: generateUuid(),
        ticket_code: generateReceiptToken(),
        source: 'pos',

        state: 'draft',
        ordered_at: at,
        paid_at: null,
        closed_at: null,
        cancelled_at: null,
        cancel_reason: null,

        customer_id: input.customerId ?? null,
        employee_id: context.employeeId,
        // `??` cannot tell "not supplied" from "deliberately cleared": a refund or a split of an
        // order whose pricelist was cleared must not silently re-apply the register default, so
        // the key's presence — not its value — decides whether the config default applies.
        pricelist_id: 'pricelistId' in input ? (input.pricelistId ?? null) : (catalog.config?.pricelist_id ?? null),
        fiscal_position_id:
            'fiscalPositionId' in input
                ? (input.fiscalPositionId ?? null)
                : (catalog.config?.default_fiscal_position_id ?? null),
        pos_preset_id: input.presetId ?? catalog.config?.default_preset_id ?? null,
        preset_time: null,
        currency_id: context.currencyId,
        currency_rate: '1',
        floating_order_name: input.floatingOrderName ?? null,

        amount_untaxed: '0',
        amount_tax: '0',
        amount_total: '0',
        amount_rounding: '0',
        amount_paid: '0',
        amount_change: '0',
        amount_due: '0',
        amount_discount: '0',

        restaurant_table_id: input.tableId ?? null,
        guest_count: input.guestCount ?? 0,
        is_tipped: false,
        tip_amount: '0',
        split_from_order_uuid: input.splitFromOrderUuid ? asUuid(input.splitFromOrderUuid) : null,
        split_letter: input.splitLetter ?? null,

        is_refund: input.isRefund ?? false,
        refunded_order_uuid: input.refundedOrderUuid ? asUuid(input.refundedOrderUuid) : null,
        to_invoice: false,

        general_customer_note: null,
        internal_note: null,
        prep_state: 'none',
        unsent_change_count: 0,
        last_prep_sent_at: null,
        last_prep_snapshot: null,

        self_order_table_id: null,
        table_stand_number: null,
        customer_email: null,
        customer_phone: null,

        print_count: 0,
        is_edited: false,
        client_created_at: at,

        updatedAtLocal: Date.now(),
        syncState: 'local',
        syncError: null,
        rev: 0,
        baseline: null,
    };

    mutate((state) => {
        state.orders[uuid] = order;
        state.linesByOrder[uuid] = [];
        state.paymentsByOrder[uuid] = [];
        state.coursesByOrder[uuid] = [];
        state.selectedOrderUuid = uuid;
        state.selectedLineUuid = null;
    });

    // A table order must exist server-side as soon as it has a table (RST-142); a bare draft with
    // no lines does not need to burn a sync round trip.
    commit(uuid, { queue: order.restaurant_table_id !== null });
    return uuid;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing
// ─────────────────────────────────────────────────────────────────────────────

/** The catalogue price of a variant for this order, honouring the pricelist (REG-170). */
export function resolveUnitPrice(
    order: OrderRow,
    variantId: number,
    quantity: number,
    catalog: CatalogIndex = getCatalog(),
): string {
    const list = baseListPrice(catalog, variantId);
    const resolver = catalog.pricelistResolver;
    const pricelistId = order.pricelist_id;
    if (!resolver || pricelistId === null) return list;

    const variant = catalog.variantsById.get(variantId);
    const product = variant ? catalog.productsById.get(variant.product_id) : undefined;
    const categoryId = product?.pos_category_ids[0] ?? null;
    const ancestry = categoryId !== null ? (catalog.categoriesById.get(categoryId)?.ancestorIds ?? []) : [];

    return resolver.resolve(pricelistId, {
        variantId,
        productId: variant?.product_id ?? null,
        categoryId,
        categoryAncestry: ancestry,
        listPrice: list,
        standardPrice: variant?.standard_price ?? '0',
        priceExtra: '0',
        quantity: String(quantity),
        date: nowIso(),
        priceType: 'original',
    });
}

/** Sum of the `price_extra` of the chosen attribute values (REG-073). */
export function attributeExtraOf(
    attributeLineValueIds: readonly number[],
    catalog: CatalogIndex = getCatalog(),
): string {
    let extra = ZERO;
    for (const id of attributeLineValueIds) {
        const value = catalog.attributeLineValuesById.get(id);
        if (value) extra = extra.add(Decimal.of(value.price_extra));
    }
    return extra.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Lines
// ─────────────────────────────────────────────────────────────────────────────

export type AddLineInput = {
    orderUuid: string;
    variantId: number;
    quantity?: number;
    priceUnit?: string;
    priceExtra?: string;
    priceType?: PriceType;
    discountPercent?: string;
    attributeLineValueIds?: number[];
    customAttributeValues?: Array<{ uuid: Uuid; value_id: number; custom_value: string }>;
    customerNote?: string | null;
    internalNote?: Array<{ text: string; color_index: number }> | null;
    comboParentUuid?: string | null;
    comboId?: number | null;
    comboItemId?: number | null;
    courseUuid?: string | null;
    refundedLineUuid?: string | null;
    refundedLineId?: number | null;
    /** Refund lines, combos and scale/open-price lines never merge. */
    skipMerge?: boolean;
    fullProductName?: string;
};

function noteKey(line: Pick<OrderLineRow, 'customer_note' | 'internal_note'>): string {
    return `${line.customer_note ?? ''}|${JSON.stringify(line.internal_note ?? [])}`;
}

/** Attribute selections are a set, not a sequence: the order they were picked in is irrelevant. */
function attributeKey(ids: readonly number[] | null | undefined): string {
    return [...(ids ?? [])].sort((a, b) => a - b).join(',');
}

/**
 * REG-101 — the merge predicate.
 *
 * Same product, same attribute selection, same discount, same price, same price type, same notes,
 * groupable UoM, not a refund, not part of a combo, and — in restaurant mode — the same course.
 * Every missing condition here produces a wrong kitchen ticket, which is why it is one function
 * and not an inline `&&`.
 *
 * The attribute comparison is not redundant with the price: two values of the same attribute can
 * carry the same `price_extra` (Ketchup / Mayo), and merging those loses one of the two selections
 * on the kitchen ticket. Odoo's `Orderline.can_be_merged_with` compares `full_product_name` for
 * exactly this reason, so both the ids and the rendered name are compared here.
 */
export function canMergeLines(
    a: OrderLineRow,
    b: Pick<
        OrderLineRow,
        | 'product_variant_id'
        | 'price_unit'
        | 'price_extra'
        | 'price_type'
        | 'discount_percent'
        | 'customer_note'
        | 'internal_note'
        | 'combo_parent_uuid'
        | 'combo_item_id'
        | 'course_uuid'
        | 'refunded_line_uuid'
        | 'uom_id'
        | 'attribute_line_value_ids'
        | 'full_product_name'
    >,
    catalog: CatalogIndex = getCatalog(),
): boolean {
    if (a.product_variant_id !== b.product_variant_id) return false;
    if (attributeKey(a.attribute_line_value_ids) !== attributeKey(b.attribute_line_value_ids)) return false;
    if (a.full_product_name !== b.full_product_name) return false;
    if (a.price_type !== b.price_type) return false;
    if (!Decimal.of(a.price_unit).eq(Decimal.of(b.price_unit))) return false;
    if (!Decimal.of(a.price_extra).eq(Decimal.of(b.price_extra))) return false;
    if (!Decimal.of(a.discount_percent).eq(Decimal.of(b.discount_percent))) return false;
    if (noteKey(a) !== noteKey(b)) return false;
    if (a.combo_parent_uuid !== null || b.combo_parent_uuid !== null) return false;
    if (a.combo_item_id !== null || b.combo_item_id !== null) return false;
    if (a.refunded_line_uuid !== null || b.refunded_line_uuid !== null) return false;
    if ((a.course_uuid ?? null) !== (b.course_uuid ?? null)) return false;
    const uom = catalog.uoms.get(a.uom_id);
    if (uom && !uom.is_pos_groupable) return false;
    return true;
}

export function addLine(input: AddLineInput): string {
    const catalog = getCatalog();
    const state = snapshot();
    const order = state.orders[input.orderUuid];
    if (!order) throw new Error(`unknown order ${input.orderUuid}`);

    const variant = catalog.variantsById.get(input.variantId);
    const quantity = input.quantity ?? 1;
    const attributeIds = input.attributeLineValueIds ?? [];
    const priceUnit = input.priceUnit ?? resolveUnitPrice(order, input.variantId, quantity, catalog);
    const priceExtra = input.priceExtra ?? attributeExtraOf(attributeIds, catalog);

    const candidate = {
        product_variant_id: input.variantId,
        price_unit: priceUnit,
        price_extra: priceExtra,
        price_type: input.priceType ?? ('original' as PriceType),
        discount_percent: input.discountPercent ?? '0',
        customer_note: input.customerNote ?? null,
        internal_note: input.internalNote ?? null,
        combo_parent_uuid: input.comboParentUuid ? asUuid(input.comboParentUuid) : null,
        combo_item_id: input.comboItemId ?? null,
        course_uuid: input.courseUuid ? asUuid(input.courseUuid) : null,
        refunded_line_uuid: input.refundedLineUuid ? asUuid(input.refundedLineUuid) : null,
        uom_id: variant ? (catalog.productsById.get(variant.product_id)?.uom_id ?? 1) : 1,
        attribute_line_value_ids: attributeIds,
        full_product_name:
            input.fullProductName ?? fullProductName(catalog, input.variantId, attributeIds),
    };

    const existing = input.skipMerge
        ? undefined
        : linesOf(state, input.orderUuid).find((line) => canMergeLines(line, candidate, catalog));

    if (existing) {
        setQuantity(existing.uuid, existing.quantity + quantity);
        return existing.uuid;
    }

    const uuid = generateUuid();
    const lineNumber = (state.linesByOrder[input.orderUuid]?.length ?? 0) + 1;

    const line: OrderLineRow = {
        uuid: asUuid(uuid),
        id: null,
        order_uuid: asUuid(input.orderUuid),
        line_number: lineNumber,

        product_variant_id: input.variantId,
        product_id: variant?.product_id ?? 0,
        pos_category_id: primaryCategoryOf(catalog, input.variantId),
        full_product_name: candidate.full_product_name,
        uom_id: candidate.uom_id,

        quantity,
        price_unit: priceUnit,
        price_extra: priceExtra,
        price_type: candidate.price_type,
        discount_percent: candidate.discount_percent,
        discount_notice: null,

        price_subtotal: '0',
        price_subtotal_incl: '0',

        tax_ids: taxIdsFor(catalog, input.variantId),
        attribute_line_value_ids: attributeIds,
        custom_attribute_values: input.customAttributeValues ?? [],

        customer_note: candidate.customer_note,
        internal_note: candidate.internal_note,

        combo_parent_uuid: candidate.combo_parent_uuid,
        combo_id: input.comboId ?? null,
        combo_item_id: candidate.combo_item_id,
        course_uuid: candidate.course_uuid ?? defaultCourseUuid(state, input.orderUuid),

        refunded_line_uuid: candidate.refunded_line_uuid,
        refunded_line_id: input.refundedLineId ?? null,
        refunded_quantity: 0,

        skip_preparation: false,
        is_edited: false,
        rev: 0,
    };

    mutate((state) => {
        state.lines[uuid] = line;
        indexLine(state, line);
        state.selectedLineUuid = uuid;
        touch(state, input.orderUuid);
    });

    commit(input.orderUuid);
    return uuid;
}

/** New lines attach to the last course unless one was passed explicitly (RST-082). */
function defaultCourseUuid(state: OrderSlice, orderUuid: string): Uuid | null {
    const courses = coursesOf(state, orderUuid);
    const last = courses[courses.length - 1];
    return last ? last.uuid : null;
}

export function setQuantity(lineUuid: string, quantity: number): void {
    const state = snapshot();
    const line = state.lines[lineUuid];
    if (!line) return;
    // REG-177 — the line's unit of measure decides what quantities exist, not a hardcoded 3 dp.
    const rounded = roundQuantity(quantity, line.uom_id);

    mutate((draft) => {
        const target = draft.lines[lineUuid];
        if (!target) return;
        const ratio = target.quantity === 0 ? 0 : rounded / target.quantity;
        target.quantity = rounded;
        target.rev += 1;
        // Combo children follow their parent (REG-112).
        for (const childUuid of draft.childLines[lineUuid] ?? []) {
            const child = draft.lines[childUuid];
            if (!child) continue;
            child.quantity = ratio === 0 ? 0 : roundQuantity(child.quantity * ratio, child.uom_id);
            child.rev += 1;
        }
        touch(draft, target.order_uuid);
    });

    commit(line.order_uuid);
}

/**
 * REG-107 — reducing below the quantity the kitchen already has creates a compensating negative
 * line instead of editing the original, so the kitchen gets a "cancel 1×" ticket rather than a
 * silent edit. Returns the uuid of the line that ended up carrying the change.
 */
export function reduceQuantity(lineUuid: string, nextQuantity: number): string {
    const state = snapshot();
    const line = state.lines[lineUuid];
    if (!line) return lineUuid;
    const order = state.orders[line.order_uuid];
    const sent = order?.last_prep_snapshot?.lines[prepKeyOf(line)] ?? 0;

    if (nextQuantity >= sent || sent === 0) {
        setQuantity(lineUuid, nextQuantity);
        return lineUuid;
    }

    // The original line is written back to what the kitchen already has, so the compensating
    // quantity must be measured against `sent` — not against the line's current quantity, which
    // may have grown after the send.
    // Trimmed, not snapped: `sent + delta` must land exactly on `nextQuantity` (see trimQuantity).
    const delta = trimQuantity(nextQuantity - sent);
    setQuantity(lineUuid, sent);
    return addLine({
        orderUuid: line.order_uuid,
        variantId: line.product_variant_id,
        quantity: delta,
        priceUnit: line.price_unit,
        priceExtra: line.price_extra,
        priceType: line.price_type,
        discountPercent: line.discount_percent,
        customerNote: line.customer_note,
        internalNote: line.internal_note,
        courseUuid: line.course_uuid,
        skipMerge: true,
        fullProductName: line.full_product_name,
    });
}

/** The prep-snapshot key: uuid + note, because a note change makes it a different item (KDS-051). */
export function prepKeyOf(line: OrderLineRow): string {
    return prepKey(line);
}

export function setPriceUnit(lineUuid: string, price: string): void {
    updateLine(lineUuid, (line) => {
        line.price_unit = price;
        line.price_type = 'manual';
    });
}

export function setDiscount(lineUuid: string, percent: string): void {
    const clamped = Decimal.of(percent).lt('0') ? '0' : Decimal.of(percent).gt('100') ? '100' : percent;
    updateLine(lineUuid, (line) => {
        line.discount_percent = clamped;
    });
}

export function setCustomerNote(lineUuid: string, note: string | null): void {
    updateLine(lineUuid, (line) => {
        line.customer_note = note === '' ? null : note;
    });
}

export function setInternalNote(
    lineUuid: string,
    notes: Array<{ text: string; color_index: number }> | null,
): void {
    updateLine(lineUuid, (line) => {
        line.internal_note = notes === null || notes.length === 0 ? null : notes;
    });
}

export function setLineCourse(lineUuid: string, courseUuid: string | null): void {
    const state = snapshot();
    const children = state.lines[lineUuid] ? childLinesOf(state, lineUuid).map((child) => child.uuid) : [];
    mutate((draft) => {
        for (const uuid of [lineUuid, ...children]) {
            const line = draft.lines[uuid];
            if (!line) continue;
            line.course_uuid = courseUuid ? asUuid(courseUuid) : null;
            line.rev += 1;
            touch(draft, line.order_uuid);
        }
    });
    const orderUuid = state.lines[lineUuid]?.order_uuid;
    if (orderUuid) commit(orderUuid);
}

function updateLine(lineUuid: string, recipe: (line: OrderLineRow) => void): void {
    const state = snapshot();
    const line = state.lines[lineUuid];
    if (!line) return;
    mutate((draft) => {
        const target = draft.lines[lineUuid];
        if (!target) return;
        recipe(target);
        target.rev += 1;
        target.is_edited = true;
        touch(draft, target.order_uuid);
    });
    commit(line.order_uuid);
}

export function removeLine(lineUuid: string): void {
    const state = snapshot();
    const line = state.lines[lineUuid];
    if (!line) return;
    const victims = [lineUuid, ...childLinesOf(state, lineUuid).map((child) => child.uuid)];

    mutate((draft) => {
        const order = draft.orders[line.order_uuid];
        for (const uuid of victims) {
            const target = draft.lines[uuid];
            if (!target) continue;
            // A line the server has never seen needs no tombstone; one it has does, or the delete
            // is silently lost on the next push (spec 05 §4, create→update rewriting).
            if (order && (target.id !== null || order.baseline !== null)) {
                order.baseline ??= { serverRev: null, order: {}, lines: {}, payments: {}, deletedLineUuids: [] };
                if (!order.baseline.deletedLineUuids.includes(uuid)) {
                    order.baseline.deletedLineUuids.push(uuid);
                }
            }
            unindexLine(draft, target);
            delete draft.lines[uuid];
        }
        if (draft.selectedLineUuid !== null && victims.includes(draft.selectedLineUuid)) {
            draft.selectedLineUuid = null;
        }
        if (order) order.is_edited = true;
        touch(draft, line.order_uuid);
    });

    commit(line.order_uuid);
}

// ─────────────────────────────────────────────────────────────────────────────
// Order-level attributes
// ─────────────────────────────────────────────────────────────────────────────

function updateOrder(orderUuid: string, recipe: (order: OrderRow) => void, queue = true): void {
    mutate((draft) => {
        const order = draft.orders[orderUuid];
        if (!order) return;
        recipe(order);
        touch(draft, orderUuid);
    });
    commit(orderUuid, { queue });
}

/**
 * REG-155 — assign a customer.
 *
 * The pricelist / fiscal-position derivation is the second half and lives in
 * `applyCustomerDefaults`, because the customer row is a Dexie record rather than part of the
 * frozen catalog index: the dialog already has it in hand and passing it in beats a second read.
 */
export function setCustomer(orderUuid: string, customerId: number | null): void {
    updateOrder(orderUuid, (order) => {
        order.customer_id = customerId;
    });
}

/** Second half of REG-155, called with the customer row the dialog already loaded. */
export function applyCustomerDefaults(
    orderUuid: string,
    customer: { pricelist_id: number | null; fiscal_position_id: number | null },
): void {
    const catalog = getCatalog();
    const config = catalog.config;
    const pricelistAllowed =
        customer.pricelist_id !== null && (config?.available_pricelist_ids ?? []).includes(customer.pricelist_id);
    const positionAllowed =
        customer.fiscal_position_id !== null &&
        (config?.available_fiscal_position_ids ?? []).includes(customer.fiscal_position_id);

    if (pricelistAllowed) setPricelist(orderUuid, customer.pricelist_id);
    if (positionAllowed) setFiscalPosition(orderUuid, customer.fiscal_position_id);
}

/** REG-173 — switching the pricelist reprices every line whose price is not manual. */
export function setPricelist(orderUuid: string, pricelistId: number | null): void {
    updateOrder(orderUuid, (order) => {
        order.pricelist_id = pricelistId;
    });

    const state = snapshot();
    const order = state.orders[orderUuid];
    if (!order) return;

    mutate((draft) => {
        for (const uuid of draft.linesByOrder[orderUuid] ?? []) {
            const line = draft.lines[uuid];
            if (!line || line.price_type !== 'original' || line.combo_parent_uuid !== null) continue;
            line.price_unit = resolveUnitPrice(order, line.product_variant_id, line.quantity);
            line.rev += 1;
        }
        touch(draft, orderUuid);
    });
    commit(orderUuid);
}

export function setFiscalPosition(orderUuid: string, fiscalPositionId: number | null): void {
    updateOrder(orderUuid, (order) => {
        order.fiscal_position_id = fiscalPositionId;
    });
}

export function setPreset(orderUuid: string, presetId: number | null): void {
    const catalog = getCatalog();
    const preset = presetId !== null ? catalog.presets.find((p) => p.id === presetId) : null;
    updateOrder(orderUuid, (order) => {
        order.pos_preset_id = presetId;
        // REG-336: the preset overrides the pricelist and the fiscal position.
        if (preset?.pricelist_id) order.pricelist_id = preset.pricelist_id;
        if (preset?.fiscal_position_id) order.fiscal_position_id = preset.fiscal_position_id;
    });
}

export function setGuestCount(orderUuid: string, guests: number): void {
    updateOrder(orderUuid, (order) => {
        order.guest_count = Math.max(0, Math.round(guests));
    });
}

export function setTable(orderUuid: string, tableId: number | null): void {
    updateOrder(orderUuid, (order) => {
        order.restaurant_table_id = tableId;
    });
}

export function setOrderNote(orderUuid: string, note: string | null): void {
    updateOrder(orderUuid, (order) => {
        order.general_customer_note = note === '' ? null : note;
    });
}

export function setOrderInternalNote(orderUuid: string, note: string | null): void {
    updateOrder(orderUuid, (order) => {
        order.internal_note = note === '' ? null : note;
    });
}

export function renameOrder(orderUuid: string, name: string | null): void {
    updateOrder(orderUuid, (order) => {
        order.floating_order_name = name === '' ? null : name;
    });
}

export function setEmployee(orderUuid: string, employeeId: number | null): void {
    const state = snapshot();
    // REG-046: an order that already has lines keeps its original cashier.
    if (linesOf(state, orderUuid).length > 0) return;
    updateOrder(orderUuid, (order) => {
        order.employee_id = employeeId;
    }, false);
}

// ─────────────────────────────────────────────────────────────────────────────
// Courses (restaurant)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RST-081 — the first course absorbs every existing line and an empty course 2 is opened. It looks
 * surprising in the code and is exactly right at the pass: what is already on the ticket is the
 * starter, what comes next is the main.
 */
export function addCourse(orderUuid: string, name: string | null = null): string {
    const state = snapshot();
    const existing = coursesOf(state, orderUuid);
    const created: CourseRow[] = [];

    const makeCourse = (index: number, label: string | null): CourseRow => ({
        uuid: asUuid(generateUuid()),
        id: null,
        order_uuid: asUuid(orderUuid),
        index,
        name: label,
        fired: false,
        fired_at: null,
        rev: 0,
    });

    if (existing.length === 0) {
        created.push(makeCourse(1, name), makeCourse(2, null));
    } else {
        created.push(makeCourse(existing.length + 1, name));
    }

    const first = created[0];
    const target = created[created.length - 1];
    if (!first || !target) return orderUuid;

    mutate((draft) => {
        for (const course of created) {
            draft.courses[course.uuid] = course;
            indexCourse(draft, course);
        }
        if (existing.length === 0) {
            for (const uuid of draft.linesByOrder[orderUuid] ?? []) {
                const line = draft.lines[uuid];
                if (line && line.course_uuid === null) line.course_uuid = first.uuid;
            }
        }
        touch(draft, orderUuid);
    });

    commit(orderUuid);
    return target.uuid;
}

export function fireCourse(orderUuid: string, courseUuid: string): void {
    mutate((draft) => {
        const course = draft.courses[courseUuid];
        if (!course || course.fired) return;
        course.fired = true;
        course.fired_at = nowIso();
        course.rev += 1;
        touch(draft, orderUuid);
    });
    commit(orderUuid);
}

/** RST-087 — drop trailing empty unfired courses and renumber 1..n. */
export function cleanCourses(orderUuid: string): void {
    const state = snapshot();
    const courses = coursesOf(state, orderUuid);
    const lines = linesOf(state, orderUuid);
    const used = new Set(lines.map((line) => line.course_uuid));

    // A whole *run* of trailing empty unfired courses goes in one pass: tapping "course" three
    // times by mistake must not need three cleanups to undo.
    const survivors = [...courses];
    while (survivors.length > 0) {
        const last = survivors[survivors.length - 1];
        if (!last || last.fired || used.has(last.uuid)) break;
        survivors.pop();
    }
    if (survivors.length === courses.length) return;

    mutate((draft) => {
        const keep = new Set<string>(survivors.map((course) => course.uuid as string));
        draft.coursesByOrder[orderUuid] = (draft.coursesByOrder[orderUuid] ?? []).filter((uuid) => {
            if (keep.has(uuid)) return true;
            delete draft.courses[uuid];
            return false;
        });
        survivors.forEach((course, index) => {
            const target = draft.courses[course.uuid];
            if (target) target.index = index + 1;
        });
        touch(draft, orderUuid);
    });
    commit(orderUuid);
}

// ─────────────────────────────────────────────────────────────────────────────
// Payments
// ─────────────────────────────────────────────────────────────────────────────

export function addPayment(orderUuid: string, paymentMethodId: number, amount: string): string {
    const context = deps.context();
    const uuid = generateUuid();
    const payment: PaymentRow = {
        uuid: asUuid(uuid),
        id: null,
        order_uuid: asUuid(orderUuid),
        pos_session_id: context.sessionId,
        payment_method_id: paymentMethodId,
        currency_id: context.currencyId,
        amount,
        is_change: false,
        is_refund: Decimal.of(amount).signum() < 0,
        label: null,
        paid_at: nowIso(),
        customer_id: snapshot().orders[orderUuid]?.customer_id ?? null,
        employee_id: context.employeeId,
        payment_status: 'done',
        card_brand: null,
        card_last4: null,
        auth_code: null,
        transaction_reference: null,
        terminal_ticket: null,
        rev: 0,
    };

    mutate((draft) => {
        draft.payments[uuid] = payment;
        indexPayment(draft, payment);
        touch(draft, orderUuid);
    });
    commit(orderUuid);
    return uuid;
}

export function setPaymentAmount(paymentUuid: string, amount: string): void {
    const state = snapshot();
    const payment = state.payments[paymentUuid];
    if (!payment) return;
    mutate((draft) => {
        const target = draft.payments[paymentUuid];
        if (!target) return;
        target.amount = amount;
        target.rev += 1;
        touch(draft, target.order_uuid);
    });
    commit(payment.order_uuid);
}

export function setPaymentStatus(
    paymentUuid: string,
    status: PaymentRow['payment_status'],
    terminal?: Partial<Pick<PaymentRow, 'card_brand' | 'card_last4' | 'auth_code' | 'transaction_reference' | 'terminal_ticket'>>,
): void {
    const state = snapshot();
    const payment = state.payments[paymentUuid];
    if (!payment) return;
    mutate((draft) => {
        const target = draft.payments[paymentUuid];
        if (!target) return;
        target.payment_status = status;
        if (terminal) Object.assign(target, terminal);
        target.rev += 1;
        touch(draft, target.order_uuid);
    });
    commit(payment.order_uuid);
}

export function removePayment(paymentUuid: string): void {
    const state = snapshot();
    const payment = state.payments[paymentUuid];
    if (!payment) return;
    mutate((draft) => {
        delete draft.payments[paymentUuid];
        const bucket = draft.paymentsByOrder[payment.order_uuid];
        if (bucket) {
            draft.paymentsByOrder[payment.order_uuid] = bucket.filter((uuid) => uuid !== paymentUuid);
        }
        touch(draft, payment.order_uuid);
    });
    commit(payment.order_uuid);
}

/** REG-220 / RST-121 — the tip rides on the configured tip product, never on a bare amount. */
export function setTip(orderUuid: string, amount: string): void {
    const catalog = getCatalog();
    const tipProduct = catalog.products.find((product) => product.special_kind === 'tip');
    const state = snapshot();
    const existing = linesOf(state, orderUuid).find(
        (line) => catalog.productsById.get(line.product_id)?.special_kind === 'tip',
    );

    if (existing) {
        updateLine(existing.uuid, (line) => {
            line.price_unit = amount;
            line.quantity = 1;
        });
    } else if (tipProduct) {
        const variant = catalog.defaultVariantByProduct.get(tipProduct.id);
        if (variant) {
            addLine({
                orderUuid,
                variantId: variant.id,
                quantity: 1,
                priceUnit: amount,
                priceType: 'manual',
                skipMerge: true,
            });
        }
    }

    updateOrder(orderUuid, (order) => {
        order.is_tipped = true;
        order.tip_amount = amount;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * REG-217 — finalise. The amounts written here are the *client's* proposal; the server recomputes
 * and overwrites them on ack. The flush is deliberately synchronous-then-immediate at the call
 * site: a crash between "paid" and "flushed" loses money.
 */
export function validateOrder(orderUuid: string): void {
    const state = snapshot();
    const totals = orderTotals(orderUuid, state);
    const at = nowIso();

    mutate((draft) => {
        const order = draft.orders[orderUuid];
        if (!order) return;
        order.state = 'paid';
        order.paid_at = at;
        order.ordered_at = order.ordered_at || at;
        order.amount_untaxed = totals.subtotal;
        order.amount_tax = totals.tax;
        order.amount_total = totals.roundedTotal;
        order.amount_rounding = totals.rounding;
        order.amount_paid = totals.paid;
        order.amount_change = totals.change;
        order.amount_due = totals.due;
        order.amount_discount = totals.discountTotal;
        touch(draft, orderUuid);
    });

    commit(orderUuid);
}

/**
 * Settle a paid order and force it to durable storage before the caller navigates away (REG-217).
 *
 * The ordering is the whole point: `flushNow()` writes the local IndexedDB replica *now* — the
 * 250 ms debounce would otherwise leave a crash window between "paid" and "flushed" that loses the
 * sale — and only then does `drain()` push to the server best-effort. The drain runs even when the
 * flush failed, so the sale still reaches the server, and the flush result is returned so the caller
 * can warn the cashier instead of silently navigating past a lost local write.
 */
export async function commitPaidOrder(
    orderUuid: string,
    durability: { flushNow: () => Promise<boolean>; drain: () => Promise<unknown> } | null,
): Promise<boolean> {
    validateOrder(orderUuid);
    const flushed = (await durability?.flushNow()) ?? true;
    await durability?.drain();
    return flushed;
}

export function markPrinted(orderUuid: string): void {
    updateOrder(orderUuid, (order) => {
        order.print_count += 1;
    });
}

export function cancelOrder(orderUuid: string, reason: string | null = null): void {
    updateOrder(orderUuid, (order) => {
        order.state = 'cancelled';
        order.cancelled_at = nowIso();
        order.cancel_reason = reason;
    });
}

/** Drop a never-synced draft entirely; a synced one is cancelled instead so the server hears about it. */
export function discardOrder(orderUuid: string): void {
    const state = snapshot();
    const order = state.orders[orderUuid];
    if (!order) return;
    if (order.id !== null || order.syncState === 'synced') {
        cancelOrder(orderUuid);
        return;
    }
    mutate((draft) => {
        forgetOrder(draft, orderUuid);
    });
    deps.persist(orderUuid);
    deps.onChange(orderUuid);
    invalidateTotals(orderUuid);
}

// ─────────────────────────────────────────────────────────────────────────────
// Kitchen
// ─────────────────────────────────────────────────────────────────────────────

/** KDS-058 — record what the kitchen has now been told. */
export function markPrepSent(orderUuid: string, sentAt = nowIso()): PrepSnapshot {
    const state = snapshot();
    const lines = linesOf(state, orderUuid);
    const order = state.orders[orderUuid];
    const nextSnapshot = buildPrepSnapshot(lines, order?.general_customer_note ?? null, order?.internal_note ?? null, sentAt);

    mutate((draft) => {
        const target = draft.orders[orderUuid];
        if (!target) return;
        target.last_prep_snapshot = nextSnapshot;
        target.last_prep_sent_at = sentAt;
        target.prep_state = 'sent';
        target.unsent_change_count = 0;
        touch(draft, orderUuid);
    });

    commit(orderUuid);
    return nextSnapshot;
}

/**
 * RST-084 — advance the local snapshot for a *single* fired course, keeping what the kitchen already
 * knew about the others. This is the client mirror of the BAN-408 server fix: replacing the whole
 * snapshot (as {@link markPrepSent} does) would mark the unfired courses sent and hide them from the
 * next fire, so their delta would be empty and their tickets would never print.
 */
export function markCoursePrepSent(orderUuid: string, courseUuid: string, sentAt = nowIso()): PrepSnapshot {
    const state = snapshot();
    const order = state.orders[orderUuid];
    const allLines = linesOf(state, orderUuid);
    const courseLines = allLines.filter((line) => line.course_uuid === courseUuid);
    const courseSnapshot = buildPrepSnapshot(courseLines, order?.general_customer_note ?? null, order?.internal_note ?? null, sentAt);

    const merged: PrepSnapshot = {
        at: sentAt,
        lines: { ...(order?.last_prep_snapshot?.lines ?? {}), ...courseSnapshot.lines },
        noteHash: courseSnapshot.noteHash,
    };

    const remaining = computePrepDelta(
        allLines,
        coursesOf(state, orderUuid),
        merged,
        order?.general_customer_note ?? null,
        order?.internal_note ?? null,
    ).nbrOfChanges;

    mutate((draft) => {
        const target = draft.orders[orderUuid];
        if (!target) return;
        target.last_prep_snapshot = merged;
        target.last_prep_sent_at = sentAt;
        target.unsent_change_count = remaining;
        if (remaining === 0) target.prep_state = 'sent';
        touch(draft, orderUuid);
    });

    commit(orderUuid);
    return merged;
}

/** KDS-057 — another till fired first: adopt the server's snapshot without printing. */
export function adoptPrepSnapshot(orderUuid: string, serverSnapshot: PrepSnapshot): void {
    const state = snapshot();
    const order = state.orders[orderUuid];
    // The conflict payload carries a version and a timestamp, not the per-line detail (spec 05 §8).
    // Storing its empty `lines` map would make the next local delta re-report every line as new and
    // print a duplicate ticket, so the map is rebuilt from what this till currently holds — which is
    // what the other till just fired.
    const adopted: PrepSnapshot =
        Object.keys(serverSnapshot.lines).length > 0
            ? serverSnapshot
            : buildPrepSnapshot(
                  linesOf(state, orderUuid),
                  order?.general_customer_note ?? null,
                  order?.internal_note ?? null,
                  serverSnapshot.at,
              );

    mutate((draft) => {
        const target = draft.orders[orderUuid];
        if (!target) return;
        target.last_prep_snapshot = adopted;
        target.last_prep_sent_at = adopted.at;
        touch(draft, orderUuid);
    });
    commit(orderUuid, { queue: false });
}

// ─────────────────────────────────────────────────────────────────────────────
// Refunds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * REG-270 / REG-271 — a refund is an ordinary order with **negative quantities** linked back to the
 * original lines. There is no document-level sign flag, on the wire or in the database.
 */
export async function createRefundOrder(
    originalOrderUuid: string,
    selection: Record<string, number>,
): Promise<string | null> {
    const state = snapshot();
    const original = state.orders[originalOrderUuid];
    if (!original) return null;

    const lines = linesOf(state, originalOrderUuid).filter((line) => (selection[line.uuid] ?? 0) > 0);
    if (lines.length === 0) return null;

    const refundUuid = await createOrder({
        isRefund: true,
        refundedOrderUuid: originalOrderUuid,
        customerId: original.customer_id,
        pricelistId: original.pricelist_id,
        fiscalPositionId: original.fiscal_position_id,
        presetId: original.pos_preset_id,
    });

    for (const line of lines) {
        const quantity = Math.min(selection[line.uuid] ?? 0, line.quantity - line.refunded_quantity);
        if (quantity <= 0) continue;
        addLine({
            orderUuid: refundUuid,
            variantId: line.product_variant_id,
            quantity: -quantity,
            priceUnit: line.price_unit,
            priceExtra: line.price_extra,
            priceType: line.price_type,
            discountPercent: line.discount_percent,
            attributeLineValueIds: line.attribute_line_value_ids,
            customerNote: line.customer_note,
            refundedLineUuid: line.uuid,
            refundedLineId: line.id,
            skipMerge: true,
            fullProductName: line.full_product_name,
        });
    }

    // REG-272 — refunded quantities are bookkept on the ORIGINAL order.
    mutate((draft) => {
        for (const line of lines) {
            const target = draft.lines[line.uuid];
            if (!target) continue;
            target.refunded_quantity += Math.min(selection[line.uuid] ?? 0, target.quantity - target.refunded_quantity);
            target.rev += 1;
        }
        touch(draft, originalOrderUuid);
    });
    commit(originalOrderUuid);

    return refundUuid;
}

// ─────────────────────────────────────────────────────────────────────────────
// Restaurant: split, transfer, merge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RST-101 — create the split bill.
 *
 * Copies the preset, pricelist and fiscal position, recreates the selected quantities as new lines,
 * re-links combos, recreates the courses by index, and migrates the kitchen-sent quantities so
 * neither order re-fires what the kitchen already has (RST-102).
 */
export async function splitOrder(orderUuid: string, selection: SplitSelection): Promise<string | null> {
    const state = snapshot();
    const original = state.orders[orderUuid];
    if (!original) return null;

    const lines = linesOf(state, orderUuid);
    const clamped = clampSelection(lines, selection);
    const moved = lines
        .filter((line) => (clamped[line.uuid] ?? 0) !== 0)
        .map((line) => ({ line, quantity: clamped[line.uuid] as number }));
    if (moved.length === 0) return null;

    const siblings = Object.values(state.orders)
        .filter((order) => order.split_from_order_uuid === orderUuid)
        .map((order) => order.split_letter);
    const letter = nextSplitLetter(siblings);

    const splitUuid = await createOrder({
        tableId: original.restaurant_table_id,
        guestCount: 1,
        presetId: original.pos_preset_id,
        pricelistId: original.pricelist_id,
        fiscalPositionId: original.fiscal_position_id,
        customerId: original.customer_id,
        splitFromOrderUuid: orderUuid,
        splitLetter: letter,
    });

    // A split order shares the table with its parent, which the one-draft-per-table rule forbids;
    // the table stays on the original and the split is settled as a floating order.
    setTable(splitUuid, null);
    renameOrder(splitUuid, `${original.floating_order_name ?? original.receipt_number}${letter ?? ''}`);

    // Courses are recreated by index so the kitchen grouping survives (RST-089).
    const courseMap = new Map<string, string>();
    for (const course of coursesOf(state, orderUuid)) {
        const created: CourseRow = {
            uuid: asUuid(generateUuid()),
            id: null,
            order_uuid: asUuid(splitUuid),
            index: course.index,
            name: course.name,
            fired: course.fired,
            fired_at: course.fired_at,
            rev: 0,
        };
        courseMap.set(course.uuid, created.uuid);
        mutate((draft) => {
            draft.courses[created.uuid] = created;
            indexCourse(draft, created);
        });
    }

    const parentMap = new Map<string, string>();
    for (const part of moved) {
        const newUuid = addLine({
            orderUuid: splitUuid,
            variantId: part.line.product_variant_id,
            quantity: part.quantity,
            priceUnit: part.line.price_unit,
            priceExtra: part.line.price_extra,
            priceType: part.line.price_type,
            discountPercent: part.line.discount_percent,
            attributeLineValueIds: part.line.attribute_line_value_ids,
            customerNote: part.line.customer_note,
            internalNote: part.line.internal_note,
            comboId: part.line.combo_id,
            comboItemId: part.line.combo_item_id,
            comboParentUuid: part.line.combo_parent_uuid
                ? (parentMap.get(part.line.combo_parent_uuid) ?? null)
                : null,
            courseUuid: part.line.course_uuid ? (courseMap.get(part.line.course_uuid) ?? null) : null,
            skipMerge: true,
            fullProductName: part.line.full_product_name,
        });
        parentMap.set(part.line.uuid, newUuid);
    }

    const { original: keptSnapshot, split: movedSnapshot } = splitPrepSnapshot(
        original.last_prep_snapshot?.lines ?? {},
        (lineUuid) => {
            const line = state.lines[lineUuid];
            return line ? prepKey(line) : null;
        },
        moved,
    );

    mutate((draft) => {
        // Decrement the original, removing lines that moved entirely.
        for (const part of moved) {
            const target = draft.lines[part.line.uuid];
            if (!target) continue;
            const left = trimQuantity(target.quantity - part.quantity);
            if (isZeroQuantity(left)) {
                unindexLine(draft, target);
                delete draft.lines[part.line.uuid];
            } else {
                target.quantity = left;
                target.rev += 1;
            }
        }
        const source = draft.orders[orderUuid];
        if (source) {
            source.last_prep_snapshot = source.last_prep_snapshot
                ? { ...source.last_prep_snapshot, lines: keptSnapshot }
                : null;
            // RST-103 — the original loses a guest to the new bill.
            source.guest_count = Math.max(0, source.guest_count - 1);
        }
        const created = draft.orders[splitUuid];
        if (created && Object.keys(movedSnapshot).length > 0) {
            created.last_prep_snapshot = {
                at: original.last_prep_snapshot?.at ?? nowIso(),
                lines: movedSnapshot,
                noteHash: original.last_prep_snapshot?.noteHash ?? '',
            };
            created.prep_state = 'sent';
        }
        touch(draft, orderUuid);
        touch(draft, splitUuid);
    });

    commit(orderUuid);
    commit(splitUuid);
    return splitUuid;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hydration (boot / delta)
// ─────────────────────────────────────────────────────────────────────────────

export function hydrateOrders(payload: {
    orders: OrderRow[];
    lines: OrderLineRow[];
    payments: PaymentRow[];
    courses: CourseRow[];
}): void {
    mutate((draft) => {
        for (const order of payload.orders) {
            draft.orders[order.uuid] = order;
            draft.linesByOrder[order.uuid] ??= [];
            draft.paymentsByOrder[order.uuid] ??= [];
            draft.coursesByOrder[order.uuid] ??= [];
        }
        for (const line of payload.lines) {
            draft.lines[line.uuid] = line;
            indexLine(draft, line);
        }
        for (const payment of payload.payments) {
            draft.payments[payment.uuid] = payment;
            indexPayment(draft, payment);
        }
        for (const course of payload.courses) {
            draft.courses[course.uuid] = course;
            indexCourse(draft, course);
        }
    });
    invalidateTotals();
}

/** Apply a server acknowledgement: merge ids, adopt the authoritative amounts, clear the dirt. */
export function applyServerAck(
    orderUuid: string,
    ack: {
        id?: number;
        name?: string | null;
        sequence_number?: number | null;
        state?: string;
        amounts?: Partial<
            Pick<
                OrderRow,
                | 'amount_untaxed'
                | 'amount_tax'
                | 'amount_total'
                | 'amount_paid'
                | 'amount_change'
                | 'amount_due'
            >
        >;
        serverRev?: string | null;
        lineIds?: Record<string, number>;
        paymentIds?: Record<string, number>;
        courseIds?: Record<string, number>;
    },
): void {
    mutate((draft) => {
        const order = draft.orders[orderUuid];
        if (!order) return;
        if (ack.id !== undefined) order.id = ack.id;
        if (ack.name !== undefined) order.name = ack.name;
        if (ack.sequence_number !== undefined) order.sequence_number = ack.sequence_number;
        if (ack.amounts) Object.assign(order, ack.amounts);
        order.syncState = 'synced';
        order.syncError = null;
        order.baseline = {
            serverRev: ack.serverRev ?? null,
            order: { rev: order.rev },
            lines: {},
            payments: {},
            deletedLineUuids: [],
        };
        for (const [uuid, id] of Object.entries(ack.lineIds ?? {})) {
            const line = draft.lines[uuid];
            if (line) line.id = id;
        }
        for (const [uuid, id] of Object.entries(ack.paymentIds ?? {})) {
            const payment = draft.payments[uuid];
            if (payment) payment.id = id;
        }
        for (const [uuid, id] of Object.entries(ack.courseIds ?? {})) {
            const course = draft.courses[uuid];
            if (course) course.id = id;
        }
    });
    deps.persist(orderUuid);
    deps.onChange(orderUuid);
}

export function markSyncState(orderUuid: string, syncState: OrderRow['syncState'], error: OrderRow['syncError'] = null): void {
    mutate((draft) => {
        const order = draft.orders[orderUuid];
        if (!order) return;
        order.syncState = syncState;
        order.syncError = error;
    });
    deps.persist(orderUuid);
}

/** Read-only convenience for screens that need payments without pulling the whole store. */
export function paymentsForOrder(orderUuid: string): PaymentRow[] {
    return paymentsOf(snapshot(), orderUuid);
}
