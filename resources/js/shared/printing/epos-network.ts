import { drawerKickDoc, type EscPosDoc } from '@domain/escpos/index';

import { ASB, parseEposResponse, toEposXml } from './epos-xml';
import {
    printError,
    type PrintOutcome,
    type PrintTransport,
    type PrinterBinding,
    type PrinterStatus,
} from './types';

/**
 * ePOS-over-network transport (spec 03 §7.3, transport 1).
 *
 * `POST http(s)://{ip}/cgi-bin/epos/service.cgi?devid=local_printer&timeout=10000`
 *
 * **The mixed-content trap.** An HTTPS page cannot `fetch()` an HTTP printer. Mitigations, in the
 * order we try them:
 *
 *   1. Epson's certified-domain scheme — the printer's serial maps to
 *      `<serial>.printer.epson.net`, which resolves to the LAN IP and carries an Epson-issued
 *      certificate. This is why Odoo does that odd serial→domain conversion, and we replicate it.
 *   2. Chrome's Private Network Access: `fetch(url, { targetAddressSpace: 'private' })` plus the
 *      printer answering the preflight. Requires the local-network permission, which we surface in
 *      a first-run dialog.
 *   3. Fall back to the print agent.
 */

const SERVICE_PATH = '/cgi-bin/epos/service.cgi';

export type EposOptions = {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** Force plain HTTP even from an HTTPS page (only useful behind the print agent). */
    forceHttp?: boolean;
};

/** `TM-m30_012345` → `012345.printer.epson.net`, Epson's certified-domain trick. */
export function epsonCertifiedDomain(serial: string): string {
    return `${serial.toLowerCase().replace(/[^a-z0-9]/g, '')}.printer.epson.net`;
}

/** Build the service URL, upgrading to HTTPS when the page is secure. */
export function eposServiceUrl(address: string, options: EposOptions = {}): string {
    const pageSecure = globalThis.location?.protocol === 'https:';
    const hasScheme = /^https?:\/\//i.test(address);

    if (hasScheme) {
        const url = new URL(address);
        if (!url.pathname || url.pathname === '/') url.pathname = SERVICE_PATH;
        url.searchParams.set('devid', url.searchParams.get('devid') ?? 'local_printer');
        url.searchParams.set('timeout', String(options.timeoutMs ?? 10_000));
        return url.toString();
    }

    const scheme = options.forceHttp ? 'http' : pageSecure ? 'https' : 'http';
    return `${scheme}://${address}${SERVICE_PATH}?devid=local_printer&timeout=${options.timeoutMs ?? 10_000}`;
}

export class EposNetworkTransport implements PrintTransport {
    readonly kind = 'epos' as const;

    private readonly fetchImpl: typeof fetch;

    constructor(private readonly options: EposOptions = {}) {
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    }

    isAvailable(): boolean {
        return typeof globalThis.fetch === 'function';
    }

    async print(doc: EscPosDoc, binding: PrinterBinding): Promise<PrintOutcome> {
        return this.send(toEposXml(doc), binding);
    }

    async openDrawer(binding: PrinterBinding): Promise<PrintOutcome> {
        return this.send(toEposXml(drawerKickDoc()), binding);
    }

    private async send(xml: string, binding: PrinterBinding): Promise<PrintOutcome> {
        const url = eposServiceUrl(binding.address, this.options);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);

        try {
            const response = await this.fetchImpl(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/xml; charset=utf-8',
                    'SOAPAction': '""',
                },
                body: xml,
                signal: controller.signal,
                // Private Network Access: Chromium requires this hint for a LAN target from HTTPS.
                ...({ targetAddressSpace: 'private' } as Record<string, string>),
            });

            if (!response.ok) {
                return {
                    ok: false,
                    transport: this.kind,
                    printerId: binding.id,
                    error: printError('unreachable', `HTTP ${response.status}`),
                };
            }

            const parsed = parseEposResponse(await response.text());
            if (parsed.success) return { ok: true, transport: this.kind, printerId: binding.id };

            const status = statusFromAsb(parsed.status);
            const kind = status.paper === 'out' ? 'paper' : status.cover === 'open' ? 'cover' : 'unknown';
            return {
                ok: false,
                transport: this.kind,
                printerId: binding.id,
                error: printError(kind, `ePOS ${parsed.code || 'error'}`),
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const kind = /abort/i.test(message) ? 'timeout' : 'unreachable';
            return {
                ok: false,
                transport: this.kind,
                printerId: binding.id,
                error: printError(kind, message),
            };
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Status poll (every 30 s in the router). This is what pre-empts the "the receipt did not
     * print" support call: paper-out shows in the navbar before the cashier notices.
     */
    async status(binding: PrinterBinding): Promise<PrinterStatus> {
        // An empty document is a legal ePOS request and returns the ASB block.
        const outcome = await this.send(toEposXml({ width: 42, codepage: 'cp858', nodes: [], meta: { orderUuid: null, kind: 'test', copy: 1 } }), binding);
        if (outcome.ok) return { online: true, paper: 'ok', cover: 'ok', checkedAt: Date.now() };
        return {
            online: false,
            paper: outcome.error.kind === 'paper' ? 'out' : 'unknown',
            cover: outcome.error.kind === 'cover' ? 'open' : 'unknown',
            checkedAt: Date.now(),
            message: outcome.error.message,
        };
    }
}

export function statusFromAsb(status: number): PrinterStatus {
    return {
        online: (status & ASB.OFF_LINE) === 0 && (status & ASB.NO_RESPONSE) === 0,
        paper: (status & ASB.RECEIPT_END) !== 0 ? 'out' : (status & ASB.RECEIPT_NEAR_END) !== 0 ? 'low' : 'ok',
        cover: (status & ASB.COVER_OPEN) !== 0 ? 'open' : 'ok',
        checkedAt: Date.now(),
    };
}
