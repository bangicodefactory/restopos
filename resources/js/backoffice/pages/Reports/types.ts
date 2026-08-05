/**
 * Props for the three report pages — spec 05 §12.
 *
 * Every figure on these pages comes from a raw `selectRaw('sum(...)')` aggregate, and a driver
 * decides what type that is: a string on Postgres, a number on SQLite. That is exactly what
 * `NumericLike` exists for, and it is why every amount on these screens goes through
 * `toDecimal()` / `money()` rather than being formatted directly — the same aggregate must render
 * identically whichever database answered.
 */

import type { MoneyString, NumericLike } from '../../types/inertia';

export type ReportFilters = {
    from: string;
    to: string;
    config_id: number | string | null;
};

// ── Reports/SalesDetails ────────────────────────────────────────────────────

export type SalesByProduct = {
    product_id: number | null;
    product_name: string | null;
    quantity: NumericLike;
    base_amount: NumericLike;
    tax_amount: NumericLike;
    total_amount: NumericLike;
    cost_amount: NumericLike;
};

export type SalesByCategory = {
    pos_category_id: number | null;
    category_name: string | null;
    quantity: NumericLike;
    total_amount: NumericLike;
};

export type SalesByTax = {
    tax_id: number;
    tax_name: string | null;
    base_amount: NumericLike;
    tax_amount: NumericLike;
};

export type SalesByPaymentMethod = {
    payment_method_id: number;
    method_name: string | null;
    expected_amount: NumericLike;
    difference_amount: NumericLike;
};

export type SalesDetailsProps = {
    filters: ReportFilters;
    /**
     * How many of the period's sessions are still trading (BOF-160).
     *
     * Their figures come from live order rows rather than frozen summaries, so the totals are
     * correct but not yet final. A manager reading a mid-service number needs to know which of the
     * two they are looking at.
     */
    openSessionCount: number;
    byProduct: SalesByProduct[];
    byCategory: SalesByCategory[];
    byTax: SalesByTax[];
    byPaymentMethod: SalesByPaymentMethod[];
};

// ── Reports/SessionReport ───────────────────────────────────────────────────

/**
 * `(array) $this->connection->table('pos_sessions')->where('id', …)->first()` — an **empty
 * object** when the id matches nothing, not `null`. Every field is therefore optional and the
 * page checks for the id before rendering anything.
 */
export type SessionReportSession = {
    id?: number;
    uuid?: string;
    pos_config_id?: number;
    name?: string;
    state?: string;
    business_date?: string | null;
    opened_at?: string | null;
    closed_at?: string | null;
    cash_balance_opening?: MoneyString;
    cash_balance_closing_expected?: MoneyString;
    cash_balance_closing_counted?: MoneyString | null;
    cash_difference?: MoneyString;
    cash_in_total?: MoneyString;
    cash_out_total?: MoneyString;
    order_count?: number;
    order_amount_total?: MoneyString;
    refund_amount_total?: MoneyString;
    payments_total?: MoneyString;
    is_rescue?: boolean | number;
    closing_forced?: boolean | number;
    closing_notes?: string | null;
};

export type ReportPaymentTotal = {
    id: number;
    pos_session_id: number;
    payment_method_id: number;
    expected_amount: NumericLike;
    counted_amount: NumericLike;
    difference_amount: NumericLike;
    payment_count: number;
    refund_amount: NumericLike;
    change_amount: NumericLike;
    ledger_code: string | null;
};

export type ReportSalesSummary = {
    id: number;
    pos_category_id: number | null;
    product_id: number | null;
    is_refund: boolean | number;
    quantity: NumericLike;
    base_amount: NumericLike;
    discount_amount: NumericLike;
    tax_amount: NumericLike;
    total_amount: NumericLike;
    cost_amount: NumericLike;
};

export type ReportTaxSummary = {
    id: number;
    tax_id: number;
    tax_group_id: number;
    is_refund: boolean | number;
    base_amount: NumericLike;
    tax_amount: NumericLike;
    tax_rate: NumericLike;
};

export type ReportCashMovement = {
    id: number;
    movement_type: string;
    amount: NumericLike;
    reason: string | null;
    moved_at: string | null;
};

export type SessionReportProps = {
    session: SessionReportSession;
    paymentTotals: ReportPaymentTotal[];
    salesSummaries: ReportSalesSummary[];
    taxSummaries: ReportTaxSummary[];
    cashMovements: ReportCashMovement[];
};

// ── Reports/OrderAnalytics ──────────────────────────────────────────────────

/** `first()` on an aggregate query: present but every column driver-typed. */
export type AnalyticsTotals = {
    order_count?: NumericLike;
    revenue?: NumericLike;
    refund_count?: NumericLike;
    guests?: NumericLike;
};

export type AnalyticsBySource = {
    source: string;
    order_count: NumericLike;
    revenue: NumericLike;
};

export type AnalyticsByDay = {
    day: string;
    order_count: NumericLike;
    revenue: NumericLike;
};

export type OrderAnalyticsProps = {
    filters: ReportFilters;
    totals: AnalyticsTotals;
    bySource: AnalyticsBySource[];
    byDay: AnalyticsByDay[];
};

/** SQLite hands booleans back as 0/1 through the raw query builder; Postgres as real booleans. */
export function truthy(value: boolean | number | null | undefined): boolean {
    return value === true || value === 1;
}

/** An integer out of a driver-typed aggregate, without pretending it was ever money. */
export function count(value: NumericLike | undefined): number {
    if (value === null || value === undefined) return 0;
    const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
}
