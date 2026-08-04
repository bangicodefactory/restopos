/**
 * `Sessions/Index` and `Sessions/Show` props — spec 05 §12.
 *
 * The detail page reads the **frozen** summary tables (`session_payment_totals`,
 * `session_sales_summaries`, `session_tax_summaries`) rather than the live orders, so a closed
 * session renders identically forever. Those three plus `cash_movements` are
 * `Inertia::defer()`ed: they are genuinely absent from the first response, hence `Deferred<T>`.
 *
 * `closingData` is the live projection used by the closing popup and is `null` once the session
 * is closed — at that point the frozen tables are the truth and recomputing would be wrong.
 */

import type { Deferred, EnumOption, MoneyString, Paginator } from '../../types/inertia';

export type SessionListRow = {
    id: number;
    uuid: string;
    name: string;
    pos_config_id: number;
    state: string;
    business_date: string | null;
    opened_at: string | null;
    closed_at: string | null;
    order_count: number;
    order_amount_total: MoneyString;
    cash_difference: MoneyString;
    is_rescue: boolean;
    closing_forced: boolean;
};

export type SessionFilters = {
    config_id?: number | string | null;
    state?: string | null;
    rescue_only?: string | boolean | null;
};

export type SessionsIndexProps = {
    sessions: Paginator<SessionListRow>;
    filters: SessionFilters;
    states: EnumOption[];
};

export type SessionRecord = {
    id: number;
    uuid: string;
    pos_config_id: number;
    company_id: number;
    currency_id: number;
    name: string;
    state: string;
    opened_by_user_id: number | null;
    opened_by_employee_id: number | null;
    closed_by_user_id: number | null;
    closed_by_employee_id: number | null;
    opened_at: string | null;
    closed_at: string | null;
    business_date: string | null;
    opening_notes: string | null;
    closing_notes: string | null;
    has_cash_control: boolean;
    cash_balance_opening: MoneyString;
    cash_balance_opening_expected: MoneyString;
    cash_balance_closing_counted: MoneyString | null;
    cash_balance_closing_expected: MoneyString;
    cash_difference: MoneyString;
    cash_in_total: MoneyString;
    cash_out_total: MoneyString;
    order_count: number;
    order_amount_total: MoneyString;
    refund_amount_total: MoneyString;
    payments_total: MoneyString;
    is_rescue: boolean;
    rescued_from_session_id: number | null;
    closing_forced: boolean;
    closing_force_reason: string | null;
    accounting_exported_at: string | null;
    created_at: string | null;
    updated_at: string | null;
};

/** `session_payment_totals` rows, as the raw query builder returns them. */
export type SessionPaymentTotal = {
    id: number;
    pos_session_id: number;
    payment_method_id: number;
    currency_id: number;
    expected_amount: MoneyString;
    counted_amount: MoneyString | null;
    difference_amount: MoneyString;
    payment_count: number;
    refund_amount: MoneyString;
    change_amount: MoneyString;
    ledger_code: string | null;
};

export type SessionSalesSummary = {
    id: number;
    pos_session_id: number;
    pos_category_id: number | null;
    product_id: number | null;
    tax_signature: string;
    is_refund: boolean | number;
    quantity: string;
    base_amount: MoneyString;
    discount_amount: MoneyString;
    tax_amount: MoneyString;
    total_amount: MoneyString;
    cost_amount: MoneyString;
    ledger_code: string | null;
};

export type SessionTaxSummary = {
    id: number;
    pos_session_id: number;
    tax_id: number;
    tax_group_id: number;
    is_refund: boolean | number;
    base_amount: MoneyString;
    tax_amount: MoneyString;
    tax_rate: string;
};

export type CashMovementRow = {
    id: number;
    uuid: string;
    pos_session_id: number;
    company_id: number;
    movement_type: string;
    amount: MoneyString;
    reason: string | null;
    customer_id: number | null;
    employee_id: number | null;
    user_id: number | null;
    pos_device_id: number | null;
    moved_at: string | null;
};

/** `App\Services\Pos\Dto\SessionClosingData::toArray()`. */
export type SessionClosingData = {
    session_id: number;
    opening_balance: MoneyString;
    cash_in: MoneyString;
    cash_out: MoneyString;
    expected_cash: MoneyString;
    payment_totals: {
        payment_method_id: number;
        name: string;
        is_cash_count: boolean;
        expected_amount: MoneyString;
        payment_count: number;
        refund_amount: MoneyString;
        change_amount: MoneyString;
    }[];
    order_count: number;
    draft_order_count: number;
    amount_authorized_diff: MoneyString;
    enforces_maximum_difference: boolean;
};

export type SessionShowProps = {
    session: SessionRecord;
    paymentTotals: SessionPaymentTotal[];
    salesSummaries: Deferred<SessionSalesSummary[]>;
    taxSummaries: Deferred<SessionTaxSummary[]>;
    cashMovements: Deferred<CashMovementRow[]>;
    closingData: SessionClosingData | null;
    can: { close: boolean };
};

export const SESSION_STATE_TONE: Record<string, 'ok' | 'warn' | 'neutral' | 'info'> = {
    opening_control: 'warn',
    opened: 'ok',
    closing_control: 'warn',
    closed: 'neutral',
};

/**
 * Cash movements are signed in the schema (in = +, out = −), so the sign carries the meaning and
 * the type is only a label. Kept as a map so an unknown type still renders its raw value.
 */
export const MOVEMENT_LABEL: Record<string, string> = {
    cash_in: 'Entrée d’espèces',
    cash_out: 'Sortie d’espèces',
    opening_float: 'Fond de caisse',
    closing_lift: 'Prélèvement de clôture',
    difference: 'Écart',
};
