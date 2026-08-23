export { UNKNOWN_STATUS, printError } from './types';
export type {
    PaperState,
    PrintError,
    PrintJob,
    PrintOutcome,
    PrintTransport,
    PrinterBinding,
    PrinterRole,
    PrinterStatus,
    TransportKind,
} from './types';

export { ASB, escapeXml, parseEposResponse, toEposXml } from './epos-xml';
export type { EposResponse } from './epos-xml';

export { EposNetworkTransport, epsonCertifiedDomain, eposServiceUrl, statusFromAsb } from './epos-network';
export type { EposOptions } from './epos-network';

export { WebUsbTransport, usbSignature } from './web-usb';

export { BrowserPrintTransport } from './browser-print';
export type { BrowserPrintOptions } from './browser-print';

export { badgeDoc, badgeJob } from './badge';
export type { BadgeInput } from './badge';
export { PrinterRouter } from './router';
export type { RouterEvent, RouterOptions } from './router';

export { ReceiptView, descriptorToPrintHtml } from './receipt-view';
export type { ReceiptViewProps } from './receipt-view';
