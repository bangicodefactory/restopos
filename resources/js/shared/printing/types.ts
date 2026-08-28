import type { EscPosDoc, PrinterProfileId } from '@domain/escpos/index';

/**
 * Printing contracts (spec 03 §7.3).
 *
 * Transports are ranked by preference and the router remembers what actually worked per printer:
 *
 *   1. **ePOS-over-network** (Epson TM-i) — no drivers, LAN-wide, status polling. Recommended.
 *   2. **WebUSB** — zero infrastructure, one user gesture per device, Chromium only.
 *   3. **WebSerial / Bluetooth** — RS-232 and belt printers (interfaces reserved, not shipped v1).
 *   4. **Print agent** — the escape hatch that makes any printer work, including Windows spooler.
 *   5. **`window.print()`** — always available, always ugly.
 */

export type TransportKind = 'epos' | 'webusb' | 'webserial' | 'bluetooth' | 'agent' | 'browser';

export type PrinterRole = 'receipt' | 'prep' | 'report' | 'label';

export type PaperState = 'ok' | 'low' | 'out' | 'unknown';

export type PrinterStatus = {
    online: boolean;
    paper: PaperState;
    cover: 'ok' | 'open' | 'unknown';
    checkedAt: number;
    message?: string;
};

export type PrinterBinding = {
    id: string;
    name: string;
    role: PrinterRole;
    /** Prep routing: which POS categories this printer is responsible for. */
    categoryIds: number[];
    /**
     * Routes every category regardless of `categoryIds`.
     *
     * Distinct from `categoryIds: []`, which marks the "everything else" fallback that only fires
     * when nothing else matched. The server has always drawn this distinction
     * ({@link app/Models/Pos/PosPrinter.php} `handlesCategory`); the client had no way to say it,
     * so a printer set to print all categories was demoted to a fallback and printed nothing
     * whenever a more specific printer existed.
     */
    allCategories?: boolean;
    transport: TransportKind;
    /** ip[:port] | usb device signature | agent printer id. */
    address: string;
    /**
     * Epson ePOS `devid`. A single TM-i answers on `local_printer`; a multi-port unit exposes
     * `local_printer2` and up, and addressing all of them as the first one prints every ticket on
     * the same roll. Null falls back to `local_printer`, which is right for the common case.
     */
    eposDeviceId?: string | null;
    profile: PrinterProfileId;
    enabled: boolean;
    status: PrinterStatus;
    /**
     * A stand-in receipt target created only because *no* printer is configured — not a real
     * device the operator chose. Transports treat it as a silent sink: the browser transport
     * renders the receipt but must NOT open the native `window.print()` dialog, so tendering a sale
     * on a printer-less till (or in development) does not block on a modal. An operator who wants
     * paper configures a printer, or triggers an explicit print from the receipt screen.
     */
    placeholder?: boolean;
};

export type PrintJob = {
    id: string;
    doc: EscPosDoc;
    /** Explicit target; when absent the router picks by role/category. */
    printerId?: string;
    role: PrinterRole;
    /** POS category of the content, for prep routing. */
    categoryIds?: number[];
    copies?: number;
    createdAt: number;
};

export type PrintOutcome =
    | { ok: true; transport: TransportKind; printerId: string }
    | { ok: false; transport: TransportKind; printerId: string; error: PrintError };

export type PrintError = {
    kind: 'unreachable' | 'permission' | 'paper' | 'cover' | 'unsupported' | 'timeout' | 'unknown';
    message: string;
    /** `false` for a permission or unsupported failure: retrying will not help. */
    retryable: boolean;
};

/**
 * Every transport implements exactly this. The router does not care which one it holds.
 *
 * `resolveImages` is passed in rather than imported because image resolution needs the blob store,
 * and printing must stay usable from a worker where Dexie may not be open.
 */
export type PrintTransport = {
    readonly kind: TransportKind;
    /** Cheap capability probe; `false` means "do not even offer this transport on this device". */
    isAvailable(): boolean;
    print(doc: EscPosDoc, binding: PrinterBinding): Promise<PrintOutcome>;
    status?(binding: PrinterBinding): Promise<PrinterStatus>;
    /** Open the drawer wired to this printer's kick port. */
    openDrawer?(binding: PrinterBinding): Promise<PrintOutcome>;
};

export const UNKNOWN_STATUS: PrinterStatus = {
    online: false,
    paper: 'unknown',
    cover: 'unknown',
    checkedAt: 0,
};

export function printError(kind: PrintError['kind'], message: string, retryable = true): PrintError {
    return { kind, message, retryable };
}
