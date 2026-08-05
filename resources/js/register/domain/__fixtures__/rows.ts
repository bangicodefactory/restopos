import type { CourseRow, OrderLineRow, OrderRow, PaymentRow } from '@domain/types';
import { asUuid } from '@domain/types';

/**
 * Plain row builders for the pure (store-free) domain functions.
 *
 * Everything defaults to the shape `addLine` would have produced, so a test only states the field
 * it is actually about.
 */

let lineSeq = 0;
let orderSeq = 0;
let courseSeq = 0;
let paymentSeq = 0;

export function resetRowSequences(): void {
    lineSeq = 0;
    orderSeq = 0;
    courseSeq = 0;
    paymentSeq = 0;
}

export function makeLine(partial: Partial<OrderLineRow> = {}): OrderLineRow {
    lineSeq += 1;
    return {
        uuid: asUuid(`line-${lineSeq}`),
        id: null,
        order_uuid: asUuid('order-1'),
        line_number: lineSeq,

        product_variant_id: 1,
        product_id: 1,
        pos_category_id: 1,
        full_product_name: 'Margherita',
        uom_id: 1,

        quantity: 1,
        price_unit: '10.00',
        price_extra: '0',
        price_type: 'original',
        discount_percent: '0',
        discount_notice: null,

        price_subtotal: '0',
        price_subtotal_incl: '0',

        tax_ids: [],
        attribute_line_value_ids: [],
        custom_attribute_values: [],

        customer_note: null,
        internal_note: null,

        combo_parent_uuid: null,
        combo_id: null,
        combo_item_id: null,
        course_uuid: null,

        refunded_line_uuid: null,
        refunded_line_id: null,
        refunded_quantity: 0,

        skip_preparation: false,
        is_edited: false,
        rev: 0,
        ...partial,
    };
}

export function makeOrder(partial: Partial<OrderRow> = {}): OrderRow {
    orderSeq += 1;
    return {
        uuid: asUuid(`order-${orderSeq}`),
        id: null,
        pos_session_id: 1,
        pos_config_id: 1,
        company_id: 1,
        pos_device_id: null,

        name: null,
        receipt_number: `26D01-1-${String(orderSeq).padStart(6, '0')}`,
        tracking_number: String(orderSeq).padStart(3, '0'),
        sequence_number: null,
        access_token: `token-${orderSeq}`,
        ticket_code: null,
        source: 'pos',

        state: 'draft',
        ordered_at: '2026-07-28T12:00:00.000Z',
        paid_at: null,
        closed_at: null,
        cancelled_at: null,
        cancel_reason: null,

        customer_id: null,
        employee_id: null,
        pricelist_id: null,
        fiscal_position_id: null,
        pos_preset_id: null,
        preset_time: null,
        currency_id: 1,
        currency_rate: '1',
        floating_order_name: null,

        amount_untaxed: '0',
        amount_tax: '0',
        amount_total: '0',
        amount_rounding: '0',
        amount_paid: '0',
        amount_change: '0',
        amount_due: '0',
        amount_discount: '0',

        restaurant_table_id: null,
        guest_count: 0,
        is_tipped: false,
        tip_amount: '0',
        split_from_order_uuid: null,
        split_letter: null,

        is_refund: false,
        refunded_order_uuid: null,
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
        client_created_at: '2026-07-28T12:00:00.000Z',

        updatedAtLocal: 0,
        syncState: 'local',
        syncError: null,
        rev: 0,
        baseline: null,
        orderScreen: null,
        ...partial,
    };
}

export function makeCourse(partial: Partial<CourseRow> = {}): CourseRow {
    courseSeq += 1;
    return {
        uuid: asUuid(`course-${courseSeq}`),
        id: null,
        order_uuid: asUuid('order-1'),
        index: courseSeq,
        name: null,
        fired: false,
        fired_at: null,
        rev: 0,
        ...partial,
    };
}

export function makePayment(partial: Partial<PaymentRow> = {}): PaymentRow {
    paymentSeq += 1;
    return {
        uuid: asUuid(`payment-${paymentSeq}`),
        id: null,
        order_uuid: asUuid('order-1'),
        pos_session_id: 1,
        payment_method_id: 1,
        currency_id: 1,
        amount: '0',
        is_change: false,
        is_refund: false,
        label: null,
        paid_at: '2026-07-28T12:00:00.000Z',
        customer_id: null,
        employee_id: null,
        payment_status: 'done',
        card_brand: null,
        card_last4: null,
        auth_code: null,
        transaction_reference: null,
        terminal_ticket: null,
        rev: 0,
        ...partial,
    };
}
