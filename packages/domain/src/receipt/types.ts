import type { Codepage, ReceiptWidth } from '../escpos/doc';
import type { Iso, Money } from '../types';

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
    /**
     * The course this line belongs to (RST-088), or null on an order that has none.
     *
     * Carried per line rather than as a grouped structure so the renderer stays a single pass and a
     * caller that does not care can keep ignoring it. A heading is printed only where the value
     * changes, and never on an order with one course — a bill that says "Service 1" above every
     * line it already listed is noise.
     */
    courseName?: string | null;
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
    gratuity: string;
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
    /** The signature tip slip (RST-124). */
    tipLine: string;
    tipTotalLine: string;
    signature: string;
    merchantCopy: string;
    note: string;
    cancelled: string;
    quantity: string;
    price: string;
    cashIn: string;
    cashOut: string;
    reason: string;
    cashMoveSlip: string;
    xReport: string;
    zReport: string;
    openedAt: string;
    printedAt: string;
    orders: string;
    grossSales: string;
    refunds: string;
    netSales: string;
    openingFloat: string;
    expectedInDrawer: string;
    payments: string;
    notAClose: string;
    incompleteReading: string;
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
    gratuity: 'Gratuity suggestions',
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
    tipLine: 'Tip',
    tipTotalLine: 'Total',
    signature: 'Signature',
    merchantCopy: 'Merchant copy',
    note: 'Note',
    cancelled: 'CANCELLED',
    quantity: 'Qty',
    price: 'Price',
    cashIn: 'CASH IN',
    cashOut: 'CASH OUT',
    reason: 'Reason',
    cashMoveSlip: 'Drawer movement',
    xReport: 'X-REPORT',
    zReport: 'Z-REPORT',
    openedAt: 'Opened',
    printedAt: 'Printed',
    orders: 'Orders',
    grossSales: 'Gross sales',
    refunds: 'Refunds',
    netSales: 'NET SALES',
    openingFloat: 'Opening float',
    expectedInDrawer: 'Expected in drawer',
    payments: 'Payments',
    notAClose: 'This session is still open',
    // Short enough to survive a 42-column roll without wrapping mid-sentence.
    incompleteReading: 'Queued sales not included',
};

/**
 * A session reading (REG-020, REG-022).
 *
 * The same numbers a Z-report carries, asked for mid-service. The one thing this slip must never do
 * is look like a Z-report: a cashier holding the wrong piece of paper thinks the till is closed and
 * stops counting, so `NOT A CLOSE` is printed rather than implied, and the heading says which of
 * the two it is.
 */
export type SessionReportView = {
    sessionId: number;
    sessionName: string | null;
    configName: string;
    /** `false` prints the same layout under a Z-REPORT heading, for a reprint after close. */
    isOpen: boolean;
    openedAt: Iso | null;
    printedAt: Iso;
    cashierName: string | null;
    orderCount: number;
    /** Tax-exclusive, and excluding refunds — the same thing the accounting export calls sales. */
    grossSales: Money;
    /**
     * **Negative**, because money went out. A refund line's `base_amount` carries its negative
     * quantity and the server passes that through unchanged, so the net line *adds* this rather
     * than subtracting it. Getting that backwards prints a day that sold 20 and refunded 10 as
     * 30.00 net — the one number on the slip a manager actually reads.
     */
    refunds: Money;
    tax: Money;
    openingFloat: Money;
    cashIn: Money;
    cashOut: Money;
    expectedCash: Money;
    taxes: ReadonlyArray<{ label: string; base: Money; amount: Money }>;
    payments: ReadonlyArray<{ label: string; amount: Money; count: number }>;
    /**
     * The till still had sales queued when this was taken, so the figures are short by whatever is
     * in the outbox. Printed on the slip rather than used to refuse it: a reading that says it is
     * incomplete is worth more than no reading, and the cashier asking is usually the person who
     * can see the queue.
     */
    queuedUnsent?: boolean;
};

/**
 * A drawer movement slip (REG-013).
 *
 * Not a receipt: nothing was sold. It is the piece of paper that explains why the drawer is light
 * — the float taken to the bank, the window cleaner paid in cash — and it is signed by whoever
 * took the money out, which is why `cashierName` is on it rather than optional decoration.
 */
export type CashMoveView = {
    uuid: string;
    /** `cash_in` or `cash_out`. The slip that matters is the one for money leaving. */
    kind: 'cash_in' | 'cash_out';
    /** Always a positive magnitude; the direction is `kind`. */
    amount: Money;
    reason: string | null;
    cashierName: string | null;
    movedAt: Iso;
    sessionName: string | null;
};

/** Kitchen ticket input — no prices, ever (spec 01 §5.7). */
export type PrepTicketView = {
    orderUuid: string;
    orderName: string;
    trackingNumber: string | null;
    tableName: string | null;
    presetName: string | null;
    /**
     * Covers on the table (RST-073) — the number a chef plates to.
     *
     * The receipt has carried it since it was written; the prep ticket, which is the copy the
     * kitchen actually reads, did not. Null where it is unknown or meaningless (a takeaway), and
     * zero is treated the same way: "0 guests" printed on a ticket is worse than no line.
     */
    guests: number | null;
    cashierName: string | null;
    firedAt: string;
    courseName: string | null;
    generalNote: string | null;
    /** `changed` marks a re-fire: only the delta is printed in bold. */
    lines: Array<{
        name: string;
        /** Course heading to print above this line when it differs from the previous (RST-088). */
        courseName?: string | null;
        quantity: number;
        attributes?: string[];
        note?: string | null;
        change: 'new' | 'increased' | 'decreased' | 'cancelled' | 'unchanged';
    }>;
};
