import { EscPosBuilder } from '../escpos/builder';
import type { EscPosDoc } from '../escpos/doc';
import { Decimal } from '../money/decimal';
import { formatDateTime, formatMoney, formatPercent, formatQuantity } from './format';
import type { PrepTicketView, ReceiptConfigView, ReceiptOrderView } from './types';

/**
 * The receipt templates (spec 03 §7.1).
 *
 * Pure functions: order view + config view → IR. The same IR is printed (`toEscPos`) and previewed
 * (`toDescriptor`), which is the whole point — a receipt that looks right on screen prints right.
 */

function nonZero(amount: string): boolean {
    return !Decimal.of(amount).isZero();
}

function lineLabel(name: string, indent: boolean): string {
    return indent ? `  ${name}` : name;
}

/** The customer receipt. */
export function buildReceiptDoc(order: ReceiptOrderView, config: ReceiptConfigView): EscPosDoc {
    const b = new EscPosBuilder({
        width: config.width,
        codepage: config.codepage,
        kind: 'receipt',
        orderUuid: order.uuid,
        copy: order.copy,
        title: order.name,
    });
    const l = config.labels;
    const money = (v: string): string => formatMoney(v, config.currency);

    // ── header ───────────────────────────────────────────────────────────────
    if (config.logoKey) b.image({ key: config.logoKey, align: 'center' });
    b.title(config.companyName);
    for (const line of config.companyAddress) b.subtitle(line);
    if (config.companyPhone) b.subtitle(config.companyPhone);
    if (config.companyVat) b.subtitle(`${l.vat}: ${config.companyVat}`);
    if (config.header) {
        b.feed(1);
        b.text(config.header, { align: 'center' });
    }

    b.feed(1);
    if (order.isRefund) {
        b.text(l.refund, { align: 'center', bold: true, size: 'lg' });
        if (order.refundedOrderName) b.subtitle(`${l.refundOf} ${order.refundedOrderName}`);
    }
    if (order.copy > 1) b.text(l.duplicate, { align: 'center', bold: true });

    b.rule('=');
    b.row(`${l.order} ${order.name}`, formatDateTime(order.orderedAt));
    if (order.tableName) {
        b.row(
            `${l.table} ${order.tableName}`,
            order.guestCount ? `${l.guests}: ${order.guestCount}` : '',
        );
    }
    if (order.presetName) b.row(order.presetName, order.presetTime ? formatDateTime(order.presetTime, { date: false }) : '');
    if (order.cashierName) b.row(l.cashier, order.cashierName);
    if (order.customerName) b.row(l.customer, order.customerName);
    if (order.customerVat) b.row(l.vat, order.customerVat);
    b.rule('=');

    // ── lines ────────────────────────────────────────────────────────────────
    for (const line of order.lines) {
        b.row(lineLabel(line.name, line.isComboChild === true), money(line.lineTotal));

        const qty = formatQuantity(line.quantity);
        const showQtyLine = line.quantity !== 1 || line.unit !== undefined;
        if (showQtyLine) {
            const unit = line.unit ? ` ${line.unit}` : '';
            b.text(`   ${qty}${unit} x ${money(line.unitPrice)}`, { size: 'sm' });
        }

        if (line.originalUnitPrice && line.originalUnitPrice !== line.unitPrice) {
            b.text(`   (${money(line.originalUnitPrice)})`, { size: 'sm' });
        }
        if (line.discountPercent && nonZero(line.discountPercent)) {
            b.text(`   -${formatPercent(line.discountPercent)}${line.discountLabel ? ' ' + line.discountLabel : ''}`, {
                size: 'sm',
            });
        }
        for (const attr of line.attributes ?? []) b.text(`   + ${attr}`, { size: 'sm' });
        if (line.customerNote) b.text(`   ${line.customerNote}`, { size: 'sm' });
    }

    b.rule();

    // ── totals ───────────────────────────────────────────────────────────────
    if (nonZero(order.amountDiscount)) b.row(l.discount, money(order.amountDiscount));
    if (!config.taxIncluded || order.taxes.length > 0) {
        b.row(l.subtotal, money(order.amountUntaxed));
        b.row(l.tax, money(order.amountTax));
    }
    if (nonZero(order.amountRounding)) b.row(l.rounding, money(order.amountRounding));

    b.total(l.total, money(order.amountTotal));
    b.rule();

    for (const payment of order.payments) {
        b.row(payment.label, money(payment.amount));
        if (payment.detail) b.text(`   ${payment.detail}`, { size: 'sm' });
    }
    if (nonZero(order.amountChange)) b.row(l.change, money(order.amountChange), { bold: true });

    // ── tax breakdown ────────────────────────────────────────────────────────
    if (order.taxes.length > 0) {
        b.feed(1);
        b.text(l.taxBreakdown, { bold: true });
        b.cols(
            [
                { v: l.rate, w: 10 },
                { v: l.base, w: 16, align: 'right' },
                { v: l.amount, w: 16, align: 'right' },
            ],
            { size: 'sm' },
        );
        for (const tax of order.taxes) {
            b.cols(
                [
                    { v: tax.label, w: 10 },
                    { v: formatMoney(tax.base, config.currency, false), w: 16, align: 'right' },
                    { v: formatMoney(tax.amount, config.currency, false), w: 16, align: 'right' },
                ],
                { size: 'sm' },
            );
        }
    }

    // ── footer ───────────────────────────────────────────────────────────────
    if (order.generalNote) {
        b.feed(1);
        b.text(order.generalNote, { align: 'center' });
    }
    if (config.footer) {
        b.feed(1);
        b.text(config.footer, { align: 'center' });
    }

    if (config.portalUrl && config.portalDisplay !== 'none') {
        b.feed(1);
        if (config.portalDisplay !== 'url') {
            b.text(l.scanForReceipt, { align: 'center', size: 'sm' });
            b.qr(config.portalUrl, { size: 5, ec: 'M' });
        }
        if (config.portalDisplay !== 'qr_code') b.text(config.portalUrl, { align: 'center', size: 'sm' });
    }

    if (order.trackingNumber) {
        b.feed(1);
        b.text(order.trackingNumber, { align: 'center', bold: true, size: 'xl' });
    }

    if (config.openDrawer) b.pulse();
    b.cut();

    return b.build();
}

/** The pre-payment bill handed to the table: same lines, no payments, no drawer, no portal QR. */
export function buildBillDoc(order: ReceiptOrderView, config: ReceiptConfigView): EscPosDoc {
    const billOrder: ReceiptOrderView = { ...order, payments: [], amountPaid: '0', amountChange: '0' };
    const billConfig: ReceiptConfigView = { ...config, openDrawer: false, portalDisplay: 'none' };
    const doc = buildReceiptDoc(billOrder, billConfig);
    return {
        ...doc,
        meta: { ...doc.meta, kind: 'bill' },
        nodes: [
            { t: 'text', v: config.labels.bill, style: { align: 'center', bold: true, size: 'lg' } },
            ...doc.nodes,
        ],
    };
}

/** The kitchen ticket. Big type, no prices, only the delta on a re-fire. */
export function buildPrepTicketDoc(ticket: PrepTicketView, config: ReceiptConfigView): EscPosDoc {
    const b = new EscPosBuilder({
        width: config.width,
        codepage: config.codepage,
        kind: 'prep',
        orderUuid: ticket.orderUuid,
        title: ticket.orderName,
    });
    const l = config.labels;

    b.text(ticket.tableName ? `${l.table} ${ticket.tableName}` : ticket.presetName ?? l.kitchen, {
        align: 'center',
        bold: true,
        size: 'xl',
    });
    if (ticket.trackingNumber) b.text(ticket.trackingNumber, { align: 'center', size: 'lg' });
    b.rule('=');
    b.row(ticket.orderName, formatDateTime(ticket.firedAt, { date: false }));
    if (ticket.cashierName) b.row(l.cashier, ticket.cashierName);
    if (ticket.courseName) b.text(`${l.course}: ${ticket.courseName}`, { bold: true });
    b.rule('=');

    for (const line of ticket.lines) {
        if (line.change === 'unchanged') continue;
        const marker =
            line.change === 'cancelled'
                ? '** '
                : line.change === 'new'
                  ? ''
                  : line.change === 'increased'
                    ? '+ '
                    : '- ';
        const suffix = line.change === 'cancelled' ? ` (${l.cancelled})` : '';
        b.text(`${marker}${formatQuantity(line.quantity)}  ${line.name}${suffix}`, {
            bold: true,
            size: 'lg',
        });
        for (const attr of line.attributes ?? []) b.text(`     ${attr}`, {});
        if (line.note) b.text(`     >> ${line.note}`, { bold: true });
    }

    if (ticket.generalNote) {
        b.rule();
        b.text(`${l.note}: ${ticket.generalNote}`, { bold: true });
    }

    b.cut();
    return b.build();
}
