import type { CourseRow, OrderLineRow, OrderRow, PaymentRow } from '@domain/types';
import { createPosStore } from '@shared/store';

/**
 * The mutable working set (spec 03 §3.4.4).
 *
 * Normalised by uuid with relation indexes maintained **on write** — never derived by scanning,
 * because "the lines of the selected order" is read on every render of the order panel and the
 * panel is on screen all day.
 *
 * The store holds state and three primitive operations. Every domain mutation lives in
 * `@register/domain/order-actions`, which is the only module allowed to call `mutate`. That rule is
 * what makes "mutate Dexie + recompute totals + enqueue the outbox" impossible to forget.
 */

export type OrderSlice = {
    orders: Record<string, OrderRow>;
    lines: Record<string, OrderLineRow>;
    payments: Record<string, PaymentRow>;
    courses: Record<string, CourseRow>;

    linesByOrder: Record<string, string[]>;
    paymentsByOrder: Record<string, string[]>;
    coursesByOrder: Record<string, string[]>;
    /** combo parent uuid → child line uuids. */
    childLines: Record<string, string[]>;

    selectedOrderUuid: string | null;
    selectedLineUuid: string | null;

    /** The single write door. Only `order-actions` may call it. */
    mutate: (recipe: (state: OrderSlice) => void) => void;
    selectOrder: (uuid: string | null) => void;
    selectLine: (uuid: string | null) => void;
    resetAll: () => void;
};

const EMPTY: Omit<OrderSlice, 'mutate' | 'selectOrder' | 'selectLine' | 'resetAll'> = {
    orders: {},
    lines: {},
    payments: {},
    courses: {},
    linesByOrder: {},
    paymentsByOrder: {},
    coursesByOrder: {},
    childLines: {},
    selectedOrderUuid: null,
    selectedLineUuid: null,
};

export const useOrderStore = createPosStore<OrderSlice>((set) => ({
    ...EMPTY,

    mutate: (recipe) =>
        set((state) => {
            recipe(state as OrderSlice);
        }),

    selectOrder: (uuid) =>
        set((state) => {
            state.selectedOrderUuid = uuid;
            state.selectedLineUuid = null;
        }),

    selectLine: (uuid) =>
        set((state) => {
            state.selectedLineUuid = uuid;
        }),

    resetAll: () =>
        set((state) => {
            Object.assign(state, structuredCloneSafe(EMPTY));
        }),
}));

/** `structuredClone` is not available in every test environment; the shape is trivial anyway. */
function structuredCloneSafe<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Selectors — pure, so they are equally usable from actions, tests and React
// ─────────────────────────────────────────────────────────────────────────────

export function orderOf(state: OrderSlice, uuid: string | null): OrderRow | null {
    return uuid === null ? null : (state.orders[uuid] ?? null);
}

export function lineUuidsOf(state: OrderSlice, orderUuid: string | null): string[] {
    return orderUuid === null ? [] : (state.linesByOrder[orderUuid] ?? []);
}

export function linesOf(state: OrderSlice, orderUuid: string | null): OrderLineRow[] {
    return lineUuidsOf(state, orderUuid)
        .map((uuid) => state.lines[uuid])
        .filter((line): line is OrderLineRow => line !== undefined);
}

export function paymentsOf(state: OrderSlice, orderUuid: string | null): PaymentRow[] {
    return (orderUuid === null ? [] : (state.paymentsByOrder[orderUuid] ?? []))
        .map((uuid) => state.payments[uuid])
        .filter((payment): payment is PaymentRow => payment !== undefined);
}

export function coursesOf(state: OrderSlice, orderUuid: string | null): CourseRow[] {
    return (orderUuid === null ? [] : (state.coursesByOrder[orderUuid] ?? []))
        .map((uuid) => state.courses[uuid])
        .filter((course): course is CourseRow => course !== undefined)
        .sort((a, b) => a.index - b.index);
}

export function childLinesOf(state: OrderSlice, parentUuid: string): OrderLineRow[] {
    return (state.childLines[parentUuid] ?? [])
        .map((uuid) => state.lines[uuid])
        .filter((line): line is OrderLineRow => line !== undefined);
}

export function draftOrders(state: OrderSlice): OrderRow[] {
    return Object.values(state.orders)
        .filter((order) => order.state === 'draft')
        .sort((a, b) => a.updatedAtLocal - b.updatedAtLocal);
}

/** Floating orders = draft orders with no table (the tab bar, REG-119). */
export function floatingOrders(state: OrderSlice): OrderRow[] {
    return draftOrders(state).filter((order) => order.restaurant_table_id === null);
}

export function orderOnTable(state: OrderSlice, tableId: number): OrderRow | null {
    return draftOrders(state).find((order) => order.restaurant_table_id === tableId) ?? null;
}

export function unsyncedCount(state: OrderSlice): number {
    return Object.values(state.orders).filter(
        (order) => order.syncState !== 'synced' && order.state !== 'cancelled',
    ).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Index maintenance — used by the actions module and by hydration
// ─────────────────────────────────────────────────────────────────────────────

export function indexLine(state: OrderSlice, line: OrderLineRow): void {
    const bucket = (state.linesByOrder[line.order_uuid] ??= []);
    if (!bucket.includes(line.uuid)) bucket.push(line.uuid);
    if (line.combo_parent_uuid) {
        const children = (state.childLines[line.combo_parent_uuid] ??= []);
        if (!children.includes(line.uuid)) children.push(line.uuid);
    }
}

export function unindexLine(state: OrderSlice, line: OrderLineRow): void {
    const bucket = state.linesByOrder[line.order_uuid];
    if (bucket) state.linesByOrder[line.order_uuid] = bucket.filter((uuid) => uuid !== line.uuid);
    if (line.combo_parent_uuid) {
        const children = state.childLines[line.combo_parent_uuid];
        if (children) state.childLines[line.combo_parent_uuid] = children.filter((uuid) => uuid !== line.uuid);
    }
    delete state.childLines[line.uuid];
}

export function indexPayment(state: OrderSlice, payment: PaymentRow): void {
    const bucket = (state.paymentsByOrder[payment.order_uuid] ??= []);
    if (!bucket.includes(payment.uuid)) bucket.push(payment.uuid);
}

export function indexCourse(state: OrderSlice, course: CourseRow): void {
    const bucket = (state.coursesByOrder[course.order_uuid] ??= []);
    if (!bucket.includes(course.uuid)) bucket.push(course.uuid);
}

/** Drop an order and everything hanging off it. */
export function forgetOrder(state: OrderSlice, orderUuid: string): void {
    for (const uuid of state.linesByOrder[orderUuid] ?? []) {
        delete state.lines[uuid];
        delete state.childLines[uuid];
    }
    for (const uuid of state.paymentsByOrder[orderUuid] ?? []) delete state.payments[uuid];
    for (const uuid of state.coursesByOrder[orderUuid] ?? []) delete state.courses[uuid];
    delete state.linesByOrder[orderUuid];
    delete state.paymentsByOrder[orderUuid];
    delete state.coursesByOrder[orderUuid];
    delete state.orders[orderUuid];
    if (state.selectedOrderUuid === orderUuid) {
        state.selectedOrderUuid = null;
        state.selectedLineUuid = null;
    }
}
