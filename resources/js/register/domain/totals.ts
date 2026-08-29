import { Decimal, ZERO } from '@domain/money/decimal';
import { computeOrderTaxes } from '@domain/tax/engine';
import type { LineInput, LineResult, OrderInput, TaxGroupResult } from '@domain/tax/types';
import type { CourseRow, OrderLineRow, OrderRow, PaymentRow } from '@domain/types';

import { getCatalog, type CatalogIndex } from '../data/catalog';
import { coursesOf, linesOf, paymentsOf, useOrderStore, type OrderSlice } from '../state/order-store';

/**
 * Order totals, memoised on `(order.rev, catalog.version)` — spec 03 §3.4.5.
 *
 * The `rev` counter is the entire derived-value strategy: a 40-line order recomputes its taxes
 * exactly once per mutation instead of once per subscribed component. Line-level display values are
 * selected out of `perLine` rather than recomputed per component, which is the single biggest
 * rendering lever in the app.
 *
 * The tax maths itself is `@domain/tax` — the same engine the server runs, driven by the same
 * fixtures. Nothing here does arithmetic the engine could do.
 */

export type OrderTotalsView = {
    /** Tax-excluded. */
    subtotal: string;
    tax: string;
    /** Tax-included, before cash rounding. */
    total: string;
    roundedTotal: string;
    rounding: string;
    taxGroups: readonly TaxGroupResult[];
    perLine: Record<string, LineResult>;
    discountTotal: string;
    paid: string;
    due: string;
    change: string;
    lineCount: number;
    quantityCount: string;
};

export const EMPTY_TOTALS: OrderTotalsView = {
    subtotal: '0.00',
    tax: '0.00',
    total: '0.00',
    roundedTotal: '0.00',
    rounding: '0.00',
    taxGroups: [],
    perLine: {},
    discountTotal: '0.00',
    paid: '0.00',
    due: '0.00',
    change: '0.00',
    lineCount: 0,
    quantityCount: '0',
};

/** A line's effective unit price: the catalogue/manual price plus any attribute extra. */
export function effectiveUnitPrice(line: OrderLineRow): string {
    return Decimal.of(line.price_unit).add(Decimal.of(line.price_extra)).toString();
}

function toLineInput(line: OrderLineRow): LineInput {
    return {
        id: line.uuid,
        quantity: String(line.quantity),
        priceUnit: effectiveUnitPrice(line),
        discount: line.discount_percent,
        taxIds: line.tax_ids,
    };
}

export function buildOrderInput(
    order: OrderRow,
    lines: readonly OrderLineRow[],
    catalog: CatalogIndex,
): OrderInput {
    const currency = catalog.currency;
    const fiscalPosition =
        order.fiscal_position_id !== null
            ? (catalog.fiscalPositionMappings.get(order.fiscal_position_id) ?? null)
            : null;

    return {
        currency: {
            code: currency?.iso_code ?? 'EUR',
            decimalPlaces: currency?.decimal_places ?? 2,
            rounding: currency?.rounding ?? '0.01',
        },
        roundingMethod: catalog.config?.tax_rounding_method ?? 'round_per_line',
        taxes: [...catalog.taxDefinitions.values()],
        lines: lines.map(toLineInput),
        fiscalPosition,
        cashRounding: catalog.cashRounding,
    };
}

/**
 * Payments that count towards `amount_paid`: the change line never does (REG-204).
 *
 * `reversed` is excluded (BAN-414a). The money went back to the customer, so a reversed card
 * payment that still counted as settled would leave the order reading fully paid with nothing
 * behind it — the till would hand over the goods and the day would balance short.
 *
 * This was latent rather than wrong before: `reversed` is a long-standing `PaymentStatus` case that
 * nothing in the register could produce. The terminal `reverse` verb is what makes it reachable, so
 * it is fixed in the same change that arms it. `OrderSyncService::paymentTotals` excludes it too —
 * the server total wins on sync, so a client-only fix would have been overwritten by the next pull.
 */
export function settledPayments(payments: readonly PaymentRow[]): PaymentRow[] {
    return payments.filter(
        (payment) =>
            !payment.is_change &&
            payment.payment_status !== 'failed' &&
            payment.payment_status !== 'reversed' &&
            payment.payment_status !== 'cancelled',
    );
}

export function computeTotals(
    order: OrderRow,
    lines: readonly OrderLineRow[],
    payments: readonly PaymentRow[],
    catalog: CatalogIndex = getCatalog(),
): OrderTotalsView {
    if (lines.length === 0) {
        const paidOnEmpty = settledPayments(payments).reduce(
            (sum, payment) => sum.add(Decimal.of(payment.amount)),
            ZERO,
        );
        return {
            ...EMPTY_TOTALS,
            paid: paidOnEmpty.withScale(2).toString(),
            change: paidOnEmpty.withScale(2).toString(),
        };
    }

    const result = computeOrderTaxes(buildOrderInput(order, lines, catalog));

    const perLine: Record<string, LineResult> = {};
    for (const line of result.lines) perLine[line.id] = line;

    let discount = ZERO;
    let quantity = ZERO;
    for (const line of lines) {
        const gross = Decimal.of(effectiveUnitPrice(line)).mul(String(line.quantity));
        discount = discount.add(gross.mul(Decimal.of(line.discount_percent)).div('100', 4));
        quantity = quantity.add(String(line.quantity));
    }

    const paid = settledPayments(payments).reduce((sum, payment) => sum.add(Decimal.of(payment.amount)), ZERO);
    const rounded = Decimal.of(result.totals.roundedTotal);
    const due = rounded.sub(paid);

    return {
        subtotal: result.totals.totalExcluded,
        tax: result.totals.totalTax,
        total: result.totals.totalIncluded,
        roundedTotal: result.totals.roundedTotal,
        rounding: result.totals.roundingDelta,
        taxGroups: result.totals.taxGroups,
        perLine,
        discountTotal: discount.withScale(2).toString(),
        paid: paid.withScale(2).toString(),
        due: (due.signum() > 0 ? due : ZERO).withScale(2).toString(),
        change: (due.signum() < 0 ? due.negate() : ZERO).withScale(2).toString(),
        lineCount: lines.length,
        quantityCount: quantity.toString(),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Memoisation
// ─────────────────────────────────────────────────────────────────────────────

type CacheEntry = { rev: number; catalogVersion: number; paymentRev: number; value: OrderTotalsView };
const cache = new Map<string, CacheEntry>();

function paymentRevOf(payments: readonly PaymentRow[]): number {
    let sum = payments.length;
    for (const payment of payments) sum += payment.rev;
    return sum;
}

/**
 * Totals for one order, computed at most once per `(rev, catalog version, payment rev)`.
 *
 * Payments carry their own `rev` because a payment edit does not touch the order's line graph and
 * therefore must not be forced through a full order `rev` bump on every keystroke of the numpad.
 */
export function orderTotals(orderUuid: string | null, state?: OrderSlice): OrderTotalsView {
    if (orderUuid === null) return EMPTY_TOTALS;
    const snapshot = state ?? useOrderStore.getState();
    const order = snapshot.orders[orderUuid];
    if (!order) return EMPTY_TOTALS;

    const catalog = getCatalog();
    const payments = paymentsOf(snapshot, orderUuid);
    const paymentRev = paymentRevOf(payments);

    const cached = cache.get(orderUuid);
    if (cached && cached.rev === order.rev && cached.catalogVersion === catalog.version && cached.paymentRev === paymentRev) {
        return cached.value;
    }

    const value = computeTotals(order, linesOf(snapshot, orderUuid), payments, catalog);
    cache.set(orderUuid, { rev: order.rev, catalogVersion: catalog.version, paymentRev, value });
    return value;
}

export function invalidateTotals(orderUuid?: string): void {
    if (orderUuid === undefined) cache.clear();
    else cache.delete(orderUuid);
}

/** Amount per guest, shown on the payment screen when there is more than one (RST-073). */
export function amountPerGuest(total: string, guests: number): string {
    if (guests <= 1) return total;
    return Decimal.of(total).div(String(guests), 2).toString();
}

/** Lines grouped under their course, in course order, ungrouped lines last (RST-083). */
export function groupLinesByCourse(
    state: OrderSlice,
    orderUuid: string,
): Array<{ course: CourseRow | null; lines: OrderLineRow[] }> {
    const courses = coursesOf(state, orderUuid);
    const lines = linesOf(state, orderUuid);
    if (courses.length === 0) return [{ course: null, lines }];

    const groups: Array<{ course: CourseRow | null; lines: OrderLineRow[] }> = courses.map((course) => ({
        course: course as CourseRow | null,
        lines: lines.filter((line) => line.course_uuid === course.uuid),
    }));
    const orphans = lines.filter((line) => line.course_uuid === null);
    if (orphans.length > 0) groups.push({ course: null, lines: orphans });
    return groups;
}
