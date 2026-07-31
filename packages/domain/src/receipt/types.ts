import type { Codepage, ReceiptWidth } from '../escpos/doc';
import type { Money } from '../types';

/**
 * The receipt builder's input.
 *
 * Deliberately a **view model**, not the raw Dexie rows: `packages/domain` never reads storage, so
 * the caller resolves product names, tax labels and payment-method labels first. That also makes
 * the builder trivially testable and lets the server re-render the identical receipt for the email
 * / portal copy from its own data.
 */

export type CurrencyFormat = {
    symbol: string;
    /** `before` → "€ 12,30", `after` → "12,30 €". */
    position: 'before' | 'after';
    decimalPlaces: number;
    decimalSeparator: string;
    thousandsSeparator: string;
};

export type ReceiptLineView = {
    /** Frozen full product name incl. attributes. */
    name: string;
    quantity: number;
    /** Unit label ("kg", "u"), printed only when the qty is not a plain integer count. */
    unit?: string;
    unitPrice: Money;
    /** Percentage 0..100. */
    discountPercent?: string;
    discountLabel?: string | null;
    /** Tax-included when the config prints tax-inclusive prices, excluded otherwise. */
    lineTotal: Money;
    /** Original price before a pricelist/manual override — printed struck through in the preview. */
    originalUnitPrice?: Money | null;
    customerNote?: string | null;
    attributes?: string[];
    /** Combo children are indented under their parent. */
    isComboChild?: boolean;
    /** Short tax codes ("A", "B") printed after the amount for fiscal receipts. */
    taxCodes?: string[];
};

export type ReceiptTaxLineView = {
    label: string;
    rate: string;
    base: Money;
    amount: Money;
};

export type ReceiptPaymentView = {
    label: string;
    amount: Money;
    /** Terminal slip data, printed verbatim under the payment line. */
    detail?: string | null;
};

export type ReceiptOrderView = {
    uuid: string;
    /** Server display name once known, else the client reference. */
    name: string;
    reference: string;
    trackingNumber: string | null;
    orderedAt: string;
    cashierName: string | null;
    customerName: string | null;
    customerVat: string | null;
    tableName: string | null;
    guestCount: number | null;
    presetName: string | null;
    presetTime: string | null;

    lines: ReceiptLineView[];
    taxes: ReceiptTaxLineView[];
    payments: ReceiptPaymentView[];

    amountUntaxed: Money;
    amountTax: Money;
    amountTotal: Money;
    amountRounding: Money;
    amountPaid: Money;
    amountChange: Money;
    amountDiscount: Money;

    generalNote: string | null;
    isRefund: boolean;
    refundedOrderName: string | null;
    /** Copy number: 2+ prints a "DUPLICATE" banner. */
    copy: number;
};

export type ReceiptConfigView = {
    width: ReceiptWidth;
    codepage: Codepage;
    currency: CurrencyFormat;
    /** Whether displayed line prices already include tax. */
    taxIncluded: boolean;
    companyName: string;
    companyAddress: string[];
    companyVat: string | null;
    companyPhone: string | null;
    header: string | null;
    footer: string | null;
    /** Blob key of the receipt logo; resolved to a raster by the transport. */
    logoKey: string | null;
    /** Customer-facing portal URL for this order, rendered as QR and/or text. */
    portalUrl: string | null;
    portalDisplay: 'qr_code' | 'url' | 'qr_code_and_url' | 'none';
    /** Emit a drawer-kick node with the receipt. */
    openDrawer: boolean;
    /** Localised labels — the receipt is printed in the customer's language, not the cashier's. */
    labels: ReceiptLabels;
};

export type ReceiptLabels = {
    subtotal: string;
    tax: string;
    total: string;
    discount: string;
    rounding: string;
    change: string;
    paid: string;
    due: string;
    order: string;
    table: string;
    guests: string;
    cashier: string;
    customer: string;
    vat: string;
    refund: string;
    refundOf: string;
    duplicate: string;
    taxBreakdown: string;
    base: string;
    rate: string;
    amount: string;
    scanForReceipt: string;
    bill: string;
    kitchen: string;
    course: string;
    note: string;
    cancelled: string;
    quantity: string;
    price: string;
};

export const DEFAULT_LABELS: ReceiptLabels = {
    subtotal: 'Subtotal',
    tax: 'Tax',
    total: 'TOTAL',
    discount: 'Discount',
    rounding: 'Rounding',
    change: 'Change',
    paid: 'Paid',
    due: 'Due',
    order: 'Order',
    table: 'Table',
    guests: 'Guests',
    cashier: 'Served by',
    customer: 'Customer',
    vat: 'VAT',
    refund: 'REFUND',
    refundOf: 'Refund of',
    duplicate: 'DUPLICATE',
    taxBreakdown: 'Tax breakdown',
    base: 'Base',
    rate: 'Rate',
    amount: 'Amount',
    scanForReceipt: 'Scan for your receipt',
    bill: 'BILL',
    kitchen: 'KITCHEN',
    course: 'Course',
    note: 'Note',
    cancelled: 'CANCELLED',
    quantity: 'Qty',
    price: 'Price',
};

/** Kitchen ticket input — no prices, ever (spec 01 §5.7). */
export type PrepTicketView = {
    orderUuid: string;
    orderName: string;
    trackingNumber: string | null;
    tableName: string | null;
    presetName: string | null;
    cashierName: string | null;
    firedAt: string;
    courseName: string | null;
    generalNote: string | null;
    /** `changed` marks a re-fire: only the delta is printed in bold. */
    lines: Array<{
        name: string;
        quantity: number;
        attributes?: string[];
        note?: string | null;
        change: 'new' | 'increased' | 'decreased' | 'cancelled' | 'unchanged';
    }>;
};
