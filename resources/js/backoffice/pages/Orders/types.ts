/**
 * `Orders/Index` and `Orders/Show` props — spec 05 §12.
 *
 * `order`, `lines`, `payments` and `courses` are raw `attributesToArray()` payloads, so every
 * column of `pos_orders`, `pos_order_lines`, `pos_payments` and `restaurant_order_courses` is
 * present, with the model casts applied: money as decimal strings, enums as their backed value,
 * timestamps as ISO strings, and the two `AsArrayObject` JSON columns as real arrays.
 *
 * The two `tax_details` shapes are **not** the same and must not be conflated:
 *   - a line's is `[{taxId, base, amount}]` (per tax);
 *   - the order's is `[{taxGroupId, base, amount}]` (per *group*, what the receipt prints).
 */

import type { EnumOption, MoneyString, Paginator } from '../../types/inertia';

export type OrderListRow = {
    id: number;
    uuid: string;
    name: string | null;
    receipt_number: string | null;
    state: string;
    source: string;
    ordered_at: string | null;
    amount_total: MoneyString;
    pos_session_id: number;
    is_refund: boolean;
};

export type OrderFilters = {
    search?: string | null;
    state?: string | null;
    config_id?: number | string | null;
    from?: string | null;
    to?: string | null;
};

export type OrdersIndexProps = {
    orders: Paginator<OrderListRow>;
    filters: OrderFilters;
    states: EnumOption[];
};

/** One entry of a line's `tax_details` JSON. */
export type LineTaxDetail = {
    taxId: number;
    base: MoneyString;
    amount: MoneyString;
};

/** One entry of the order's `tax_details` JSON — grouped, as printed on the ticket. */
export type OrderTaxGroupDetail = {
    taxGroupId: number;
    base: MoneyString;
    amount: MoneyString;
};

/** `pos_order_lines.internal_note` is `[{text, color_index}]`. */
export type InternalNote = {
    text?: string;
    color_index?: number;
};

export type OrderLineRecord = {
    id: number;
    uuid: string;
    pos_order_id: number;
    company_id: number;
    line_number: number | null;
    product_variant_id: number;
    product_id: number;
    pos_category_id: number | null;
    full_product_name: string;
    uom_id: number;
    quantity: string;
    price_unit: MoneyString;
    price_extra: MoneyString;
    price_type: string;
    discount_percent: string;
    discount_amount: MoneyString;
    discount_notice: string | null;
    price_subtotal: MoneyString;
    price_subtotal_incl: MoneyString;
    tax_details: LineTaxDetail[] | null;
    tax_signature: string;
    unit_cost: MoneyString;
    total_cost: MoneyString;
    margin: MoneyString;
    customer_note: string | null;
    internal_note: InternalNote[] | null;
    combo_parent_line_id: number | null;
    combo_id: number | null;
    combo_item_id: number | null;
    restaurant_course_id: number | null;
    refunded_order_line_id: number | null;
    refunded_quantity: string;
    is_reward_line: boolean;
    loyalty_reward_id: number | null;
    loyalty_card_id: number | null;
    reward_identifier_code: string | null;
    points_cost: string;
    is_edited: boolean;
    skip_preparation: boolean;
    created_at: string | null;
    updated_at: string | null;
    deleted_at: string | null;
};

export type OrderPaymentRecord = {
    id: number;
    uuid: string;
    pos_order_id: number;
    pos_session_id: number;
    payment_method_id: number;
    company_id: number;
    currency_id: number;
    amount: MoneyString;
    amount_company_currency: MoneyString;
    is_change: boolean;
    is_refund: boolean;
    label: string | null;
    paid_at: string | null;
    customer_id: number | null;
    employee_id: number | null;
    pos_device_id: number | null;
    payment_status: string;
    card_type: string | null;
    card_brand: string | null;
    card_last4: string | null;
    cardholder_name: string | null;
    auth_code: string | null;
    transaction_reference: string | null;
    issuer_bank: string | null;
    entry_mode: string | null;
    terminal_ticket: string | null;
    payment_transaction_id: number | null;
    created_at: string | null;
    updated_at: string | null;
};

export type OrderCourseRecord = {
    id: number;
    uuid: string;
    pos_order_id: number;
    course_index: number;
    name: string | null;
    fired: boolean;
    fired_at: string | null;
    line_count: number;
    created_at: string | null;
    updated_at: string | null;
};

export type OrderRecord = {
    id: number;
    uuid: string;
    pos_session_id: number;
    pos_config_id: number;
    company_id: number;
    pos_device_id: number | null;
    name: string | null;
    receipt_number: string | null;
    tracking_number: string | null;
    sequence_number: number | null;
    access_token: string;
    ticket_code: string | null;
    source: string;

    state: string;
    ordered_at: string | null;
    paid_at: string | null;
    closed_at: string | null;
    cancelled_at: string | null;
    cancel_reason: string | null;
    customer_id: number | null;
    employee_id: number | null;
    user_id: number | null;
    pricelist_id: number | null;
    fiscal_position_id: number | null;
    pos_preset_id: number | null;
    preset_time: string | null;
    currency_id: number;
    currency_rate: string;
    floating_order_name: string | null;

    amount_untaxed: MoneyString;
    amount_tax: MoneyString;
    amount_total: MoneyString;
    amount_rounding: MoneyString;
    amount_paid: MoneyString;
    amount_change: MoneyString;
    amount_due: MoneyString;
    amount_discount: MoneyString;
    total_cost: MoneyString;
    margin: MoneyString;
    margin_percent: string;
    tax_details: OrderTaxGroupDetail[] | null;

    restaurant_table_id: number | null;
    guest_count: number;
    is_tipped: boolean;
    tip_amount: MoneyString;
    split_from_order_id: number | null;
    split_letter: string | null;
    merged_into_order_id: number | null;

    is_refund: boolean;
    refunded_order_id: number | null;
    refund_count: number;
    has_refundable_lines: boolean;
    to_invoice: boolean;
    pos_invoice_id: number | null;

    general_customer_note: string | null;
    internal_note: string | null;
    prep_state: string;
    unsent_change_count: number;
    last_prep_sent_at: string | null;

    self_order_table_id: number | null;
    table_stand_number: string | null;
    customer_email: string | null;
    customer_phone: string | null;
    use_self_online_payment: boolean;

    print_count: number;
    is_edited: boolean;
    has_deleted_line: boolean;
    client_created_at: string | null;
    synced_at: string | null;
    created_at: string | null;
    updated_at: string | null;
    deleted_at: string | null;
};

export type OrderShowProps = {
    order: OrderRecord;
    lines: OrderLineRecord[];
    payments: OrderPaymentRecord[];
    courses: OrderCourseRecord[];
    can: {
        void: boolean;
        refund: boolean;
    };
};

/** Badge colour per order state, shared by the list and the detail header. */
export const ORDER_STATE_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral' | 'info'> = {
    draft: 'warn',
    paid: 'ok',
    done: 'info',
    cancelled: 'danger',
};

export const ORDER_SOURCE_LABEL: Record<string, string> = {
    pos: 'Caisse',
    mobile: 'Mobile',
    kiosk: 'Borne',
    backoffice: 'Back-office',
    api: 'API',
};
