import type { EscPosDoc } from '@domain/escpos/index';
import { Decimal } from '@domain/money/decimal';
import {
    DEFAULT_LABELS,
    buildBillDoc,
    buildCashMoveDoc,
    buildPrepTicketDoc,
    buildReceiptDoc,
    buildSessionReportDoc,
    type PrepTicketView,
    type ReceiptConfigView,
    type ReceiptLabels,
    type ReceiptLineView,
    type ReceiptOrderView,
    type SessionReportView,
} from '@domain/receipt/index';
import type { OrderRow } from '@domain/types';

import { getCatalog, type CatalogIndex } from '../data/catalog';
import { coursesOf, linesOf, paymentsOf, type OrderSlice } from '../state/order-store';
import type { PrepChange } from './kitchen-delta';
import { effectiveUnitPrice, orderTotals } from './totals';

/**
 * Store rows → the receipt view model `@domain/receipt` takes.
 *
 * The domain package never reads storage, so resolving product names, tax labels and payment-method
 * labels is this module's job. The pay-off is that the very same descriptor renders on screen,
 * prints to ESC/POS and could be re-rendered server-side for an emailed copy — one layout, three
 * outputs, no second template to drift.
 */

/** French receipt labels — the receipt is printed in the *customer's* language (spec, §7.1). */
export const FR_LABELS: ReceiptLabels = {
    ...DEFAULT_LABELS,
    subtotal: 'Sous-total',
    tax: 'TVA',
    total: 'TOTAL',
    discount: 'Remise',
    rounding: 'Arrondi',
    change: 'Rendu',
    paid: 'Payé',
    due: 'Reste',
    order: 'Commande',
    table: 'Table',
    guests: 'Couverts',
    cashier: 'Servi par',
    customer: 'Client',
    vat: 'TVA',
    refund: 'REMBOURSEMENT',
    refundOf: 'Remboursement de',
    duplicate: 'DUPLICATA',
    taxBreakdown: 'Détail TVA',
    base: 'Base',
    rate: 'Taux',
    amount: 'Montant',
    scanForReceipt: 'Scannez pour votre facture',
    bill: 'ADDITION',
    kitchen: 'CUISINE',
    course: 'Service',
    note: 'Note',
    cancelled: 'ANNULÉ',
    quantity: 'Qté',
    price: 'Prix',
};

export function receiptConfig(catalog: CatalogIndex = getCatalog()): ReceiptConfigView {
    const config = catalog.config;
    const company = catalog.company;

    return {
        width: 42,
        codepage: 'cp858',
        currency: catalog.currencyFormat,
        taxIncluded: config?.iface_tax_included === 'total',
        companyName: company?.name ?? 'RestoPOS',
        companyAddress: [company?.street, [company?.zip, company?.city].filter(Boolean).join(' ')].filter(
            (line): line is string => typeof line === 'string' && line !== '',
        ),
        companyVat: company?.vat ?? null,
        companyPhone: company?.phone ?? null,
        header: config?.receipt_header ?? null,
        footer: config?.receipt_footer ?? null,
        logoKey: config?.receipt_logo_media_id !== null && config?.receipt_logo_media_id !== undefined
            ? `logo:${config.receipt_logo_media_id}`
            : null,
        portalUrl: null,
        portalDisplay: 'none',
        openDrawer: false,
        labels: FR_LABELS,
    };
}

/**
 * A tax's own name, for a slip that groups by tax rather than by group.
 *
 * Falls back to the rate the *server* sent rather than to the local catalogue: a till whose replica
 * is a day stale would otherwise print `#7` beside a real amount of money.
 */
export function taxLabelFor(taxId: number, rate: string): string {
    const tax = getCatalog().taxes.get(taxId);

    if (tax) return tax.label ?? tax.name;

    return `${Decimal.of(rate).withScale(2).toString()} %`;
}

function taxGroupLabel(catalog: CatalogIndex, taxGroupId: number): string {
    for (const tax of catalog.taxes.values()) {
        if (tax.tax_group_id === taxGroupId) return tax.label ?? tax.name;
    }
    return `#${taxGroupId}`;
}

function taxRateLabel(catalog: CatalogIndex, taxGroupId: number): string {
    for (const tax of catalog.taxes.values()) {
        if (tax.tax_group_id === taxGroupId && tax.amount_type === 'percent') {
            return `${Decimal.of(tax.amount).withScale(2).toString()} %`;
        }
    }
    return '';
}

export type ReceiptContext = {
    cashierName: string | null;
    customerName?: string | null;
    customerVat?: string | null;
    tableName?: string | null;
    presetName?: string | null;
    copy?: number;
    refundedOrderName?: string | null;
};

export function buildReceiptView(
    state: OrderSlice,
    orderUuid: string,
    context: ReceiptContext,
    catalog: CatalogIndex = getCatalog(),
): ReceiptOrderView | null {
    const order = state.orders[orderUuid];
    if (!order) return null;

    const totals = orderTotals(orderUuid, state);
    const taxIncluded = catalog.config?.iface_tax_included === 'total';

    const lines: ReceiptLineView[] = linesOf(state, orderUuid).map((line) => {
        const computed = totals.perLine[line.uuid];
        const uom = catalog.uoms.get(line.uom_id);
        const attributes = line.attribute_line_value_ids
            .map((id) => {
                const value = catalog.attributeLineValuesById.get(id);
                return value ? (catalog.attributeValues.get(value.product_attribute_value_id)?.name ?? null) : null;
            })
            .filter((name): name is string => name !== null);

        return {
            name: line.full_product_name,
            quantity: line.quantity,
            unit: uom && uom.name !== 'Unit' ? uom.name : undefined,
            unitPrice: effectiveUnitPrice(line),
            discountPercent: line.discount_percent,
            discountLabel: line.discount_notice,
            lineTotal: computed ? (taxIncluded ? computed.priceTotal : computed.priceSubtotal) : '0',
            originalUnitPrice: line.price_type === 'manual' ? null : null,
            customerNote: line.customer_note,
            attributes,
            isComboChild: line.combo_parent_uuid !== null,
        };
    });

    return {
        uuid: order.uuid,
        name: order.name ?? order.receipt_number,
        reference: order.receipt_number,
        trackingNumber: order.tracking_number,
        orderedAt: order.paid_at ?? order.ordered_at,
        cashierName: context.cashierName,
        customerName: context.customerName ?? null,
        customerVat: context.customerVat ?? null,
        tableName: context.tableName ?? null,
        guestCount: order.guest_count > 0 ? order.guest_count : null,
        presetName: context.presetName ?? null,
        presetTime: order.preset_time,

        lines,
        taxes: totals.taxGroups.map((group) => ({
            label: taxGroupLabel(catalog, group.taxGroupId),
            rate: taxRateLabel(catalog, group.taxGroupId),
            base: group.base,
            amount: group.amount,
        })),
        payments: paymentsOf(state, orderUuid)
            .filter((payment) => !payment.is_change)
            .map((payment) => ({
                label: catalog.paymentMethods.find((method) => method.id === payment.payment_method_id)?.name ?? '—',
                amount: payment.amount,
                detail: payment.card_last4 ? `${payment.card_brand ?? ''} •••• ${payment.card_last4}` : null,
            })),

        amountUntaxed: totals.subtotal,
        amountTax: totals.tax,
        amountTotal: totals.roundedTotal,
        amountRounding: totals.rounding,
        amountPaid: totals.paid,
        amountChange: totals.change,
        amountDiscount: totals.discountTotal,

        generalNote: order.general_customer_note,
        isRefund: order.is_refund,
        refundedOrderName: context.refundedOrderName ?? null,
        copy: context.copy ?? order.print_count + 1,
    };
}

export function buildReceipt(
    state: OrderSlice,
    orderUuid: string,
    context: ReceiptContext,
    options: { openDrawer?: boolean } = {},
): EscPosDoc | null {
    const view = buildReceiptView(state, orderUuid, context);
    if (!view) return null;
    return buildReceiptDoc(view, { ...receiptConfig(), openDrawer: options.openDrawer ?? false });
}

/** RST-110 — the pro forma bill: identical layout, no payments, `print_count` untouched. */
export function buildBill(
    state: OrderSlice,
    orderUuid: string,
    context: ReceiptContext,
): EscPosDoc | null {
    const view = buildReceiptView(state, orderUuid, context);
    if (!view) return null;
    return buildBillDoc(view, receiptConfig());
}

/**
 * REG-013 — the slip for money taken out of (or put into) the drawer.
 *
 * Built from what the cashier just entered rather than from a round trip, so the paper comes out
 * with the customer or the courier still standing there. The movement itself queues through the
 * outbox and may not have reached the server yet; the slip is a record of what was done at the
 * till, which is exactly what someone is signing.
 */
export function buildCashMoveSlip(move: {
    uuid: string;
    kind: 'cash_in' | 'cash_out';
    amount: string;
    reason: string | null;
    cashierName: string | null;
    movedAt: string;
    sessionName: string | null;
}): EscPosDoc {
    return buildCashMoveDoc(move, receiptConfig());
}

/**
 * REG-020, REG-022 — the session reading, printed without closing.
 *
 * Built from the server's answer rather than from local state, unlike the cash-move slip: a reading
 * has to cover every device on this register, and the till only knows its own orders. That is also
 * why there is no offline path — an X-report the till assembled alone would be confidently wrong on
 * exactly the busy service where somebody bothers to ask for one.
 */
export function buildSessionReport(report: SessionReportView): EscPosDoc {
    return buildSessionReportDoc(report, receiptConfig());
}

/** KDS-055 — one kitchen ticket for one station's slice of the delta. */
export function buildPrepTicket(
    order: OrderRow,
    changes: readonly PrepChange[],
    context: { tableName: string | null; presetName: string | null; cashierName: string | null; courseName: string | null },
    state?: OrderSlice,
): EscPosDoc {
    const courseName =
        context.courseName ??
        (state ? (coursesOf(state, order.uuid).find((course) => !course.fired)?.name ?? null) : null);

    const ticket: PrepTicketView = {
        orderUuid: order.uuid,
        orderName: order.floating_order_name ?? order.name ?? order.receipt_number,
        trackingNumber: order.tracking_number,
        tableName: context.tableName,
        presetName: context.presetName,
        cashierName: context.cashierName,
        firedAt: new Date().toISOString(),
        courseName,
        generalNote: order.general_customer_note,
        lines: changes.map((change) => ({
            name: change.name,
            quantity: Math.abs(change.quantity),
            note: change.internalNote ?? change.customerNote ?? null,
            change:
                change.changeType === 'cancelled'
                    ? 'cancelled'
                    : change.changeType === 'note_update'
                      ? 'increased'
                      : 'new',
        })),
    };

    return buildPrepTicketDoc(ticket, receiptConfig());
}
