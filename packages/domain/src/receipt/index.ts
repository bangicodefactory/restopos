export { buildBillDoc, buildPrepTicketDoc, buildReceiptDoc } from './build';
export { descriptorToText, toDescriptor } from './descriptor';
export type { ReceiptDescriptor, ReceiptElement } from './descriptor';
export { formatDateTime, formatMoney, formatPercent, formatQuantity } from './format';
export { DEFAULT_LABELS } from './types';
export type {
    CurrencyFormat,
    PrepTicketView,
    ReceiptConfigView,
    ReceiptLabels,
    ReceiptLineView,
    ReceiptOrderView,
    ReceiptPaymentView,
    ReceiptTaxLineView,
} from './types';
