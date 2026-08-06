import type { EscPosDoc, PrinterProfileId } from '@domain/escpos/index';
import type { AuditBatchPayload } from '@domain/sync/wire';
import { asUuid, type PosPrinterRow } from '@domain/types';
import {
    PrinterRouter,
    type PrintOutcome,
    type PrinterBinding,
    type PrinterRole,
    type TransportKind,
} from '@shared/printing';

import { resolveDocImages } from '@shared/printing/images';

import { getCatalog, type CatalogIndex } from '../data/catalog';
import { tryRuntime } from '../data/runtime';

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
export async function print(
    router: PrinterRouter,
    doc: EscPosDoc,
    request: PrintRequest = {},
): Promise<PrintOutcome> {
    // Turn `{t:'image', key}` into pixels before the doc reaches a transport (BAN-480). Done here
    // rather than inside the router because resolution needs the blob store, and the router is
    // meant to stay usable from a worker where Dexie may not be open.
    const runtime = tryRuntime();
    const resolved = runtime ? await resolveDocImages(doc, runtime.db) : doc;

    return printResolved(router, resolved, request);
}

function printResolved(router: PrinterRouter, doc: EscPosDoc, request: PrintRequest = {}): Promise<PrintOutcome> {
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

/** Why the drawer opened. `no_sale` is the one a manager goes looking for. */
export type DrawerReason = 'cash_payment' | 'no_sale' | 'cash_move' | 'unknown';

/**
 * REG-206 — open the drawer on a cash payment, and on a manager no-sale.
 *
 * The pulse goes straight from this browser to the printer, so without the queued report below the
 * server never learns the drawer opened at all — the one money-adjacent action leaving no row of any
 * kind (BAN-413). The report is queued rather than posted because the drawer opens whether or not
 * there is a network, and an opening during an outage is not the one you would want to lose.
 *
 * Reporting lives *here*, not at the call sites, on purpose: a caller that forgets is a silent hole
 * in the trail, and holes in a fraud trail are found by the person exploiting them before they are
 * found by anyone else.
 */
export async function openDrawer(
    router: PrinterRouter,
    reason: DrawerReason = 'unknown',
    context: { sessionId?: number | null; orderUuid?: string | null; employeeId?: number | null } = {},
): Promise<void> {
    const runtime = tryRuntime();

    if (runtime) {
        const batch: AuditBatchPayload = {
            events: [
                {
                    // The event's own uuid, not the batch's: the outbox redelivers, and each event
                    // has to dedupe on itself or a resent batch reports openings that never happened.
                    uuid: asUuid(crypto.randomUUID()),
                    event: 'cash.drawer.opened',
                    at: new Date().toISOString(),
                    session_id: context.sessionId ?? null,
                    order_uuid: context.orderUuid === null || context.orderUuid === undefined ? null : asUuid(context.orderUuid),
                    employee_id: context.employeeId ?? null,
                    detail: { reason },
                },
            ],
        };

        // Never let the report cost the pulse. A trail that can stop a cashier opening the till has
        // traded a working register for better paperwork, which is the wrong way round.
        void Promise.resolve(runtime.syncer.enqueueCommand('audit.batch', batch)).catch(() => undefined);
    }

    await router.openDrawer();
}
