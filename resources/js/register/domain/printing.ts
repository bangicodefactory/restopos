import type { EscPosDoc, PrinterProfileId } from '@domain/escpos/index';
import type { PosPrinterRow } from '@domain/types';
import {
    PrinterRouter,
    type PrintOutcome,
    type PrinterBinding,
    type PrinterRole,
    type TransportKind,
} from '@shared/printing';

import { getCatalog, type CatalogIndex } from '../data/catalog';

/**
 * Printer wiring (spec 03 §7.3, REG-242 … REG-244).
 *
 * `@shared/printing` owns transports, routing, retry and status polling; this module only maps the
 * register's configured printers onto bindings and offers a promise-shaped `print()` for screens
 * that need to tell the cashier whether the paper actually came out.
 *
 * The browser fallback is always appended: a receipt the customer is standing there waiting for
 * must not be lost because the LAN printer moved to a new IP.
 */

const TRANSPORTS: Record<PosPrinterRow['printer_type'], TransportKind> = {
    iot: 'agent',
    epson_epos: 'epos',
    network_escpos: 'epos',
    browser: 'browser',
};

export function bindingsFromCatalog(catalog: CatalogIndex = getCatalog()): PrinterBinding[] {
    const bindings: PrinterBinding[] = catalog.printers.map((printer) => ({
        id: String(printer.id),
        name: printer.name,
        role: printer.print_receipt ? 'receipt' : 'prep',
        categoryIds: printer.pos_category_ids,
        transport: TRANSPORTS[printer.printer_type] ?? 'browser',
        address: printer.address ?? '',
        profile: (printer.profile ?? 'generic') as PrinterProfileId,
        enabled: true,
        status: { online: false, paper: 'unknown', cover: 'unknown', checkedAt: 0 },
    }));

    // Always keep a receipt target. Without one, `resolveTargets` drops the job and the cashier
    // learns about it only when the customer asks for a ticket. This stand-in is a `placeholder`:
    // the browser transport renders the receipt for it but does not open the native print dialog,
    // so a printer-less till (or development) tenders a sale without a modal blocking the drawer.
    if (!bindings.some((binding) => binding.role === 'receipt')) {
        bindings.push({
            id: 'browser',
            name: 'Navigateur',
            role: 'receipt',
            categoryIds: [],
            transport: 'browser',
            address: '',
            profile: 'generic',
            enabled: true,
            placeholder: true,
            status: { online: true, paper: 'unknown', cover: 'unknown', checkedAt: 0 },
        });
    }

    return bindings;
}

export function createPrinterRouter(catalog: CatalogIndex = getCatalog()): PrinterRouter {
    return new PrinterRouter({ bindings: bindingsFromCatalog(catalog) });
}

export type PrintRequest = {
    role?: PrinterRole;
    printerId?: string;
    categoryIds?: number[];
    copies?: number;
    timeoutMs?: number;
};

/**
 * Enqueue a document and resolve when the router settles it.
 *
 * The router retries internally with the outbox's backoff, so a rejection here means the job was
 * dropped for good — that is when a retry dialog is worth showing the cashier (REG-248).
 */
export function print(router: PrinterRouter, doc: EscPosDoc, request: PrintRequest = {}): Promise<PrintOutcome> {
    return new Promise((resolve) => {
        const timeoutMs = request.timeoutMs ?? 20_000;
        let settled = false;

        const finish = (outcome: PrintOutcome): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe();
            resolve(outcome);
        };

        const job = router.enqueue(doc, {
            ...(request.role !== undefined ? { role: request.role } : {}),
            ...(request.printerId !== undefined ? { printerId: request.printerId } : {}),
            ...(request.categoryIds !== undefined ? { categoryIds: request.categoryIds } : {}),
            ...(request.copies !== undefined ? { copies: request.copies } : {}),
        });

        const unsubscribe = router.subscribe((event) => {
            if (!('job' in event) || event.job.id !== job.id) return;
            if (event.type === 'job:done') finish(event.outcome);
            if (event.type === 'job:failed') finish(event.outcome);
            if (event.type === 'job:dropped') {
                finish({
                    ok: false,
                    transport: 'browser',
                    printerId: '',
                    error: { kind: 'unsupported', message: event.reason, retryable: false },
                });
            }
        });

        const timer = setTimeout(
            () =>
                finish({
                    ok: false,
                    transport: 'browser',
                    printerId: '',
                    error: { kind: 'timeout', message: 'timeout', retryable: true },
                }),
            timeoutMs,
        );
    });
}

/** REG-206 — open the drawer on a cash payment, and on a manager no-sale. */
export async function openDrawer(router: PrinterRouter): Promise<void> {
    await router.openDrawer();
}
