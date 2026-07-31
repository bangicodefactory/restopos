import type { EscPosDoc } from '@domain/escpos/index';
import { Decimal } from '@domain/money/decimal';
import {
    DEFAULT_LABELS,
    buildBillDoc,
    buildPrepTicketDoc,
    buildReceiptDoc,
    type PrepTicketView,
    type ReceiptConfigView,
    type ReceiptLabels,
    type ReceiptLineView,
    type ReceiptOrderView,
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
