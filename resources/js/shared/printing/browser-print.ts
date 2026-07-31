import { toDescriptor } from '@domain/receipt/index';
import type { EscPosDoc } from '@domain/escpos/index';

import { descriptorToPrintHtml } from './receipt-view';
import { printError, type PrintOutcome, type PrintTransport, type PrinterBinding } from './types';

/**
 * `window.print()` transport (spec 03 §7.3, transport 6).
 *
 * Last resort: always available, always ugly. Renders the receipt descriptor into a hidden iframe
 * with an `@page { size: 80mm auto; margin: 0 }` stylesheet and calls `print()` on that frame's
 * window, so the surrounding application is never part of the output.
 *
 * It exists for three real cases: a venue whose printer died mid-shift, a manager printing a
 * session report to an A4 office printer, and development on a machine with no hardware at all.
 */

export type BrowserPrintOptions = {
    widthMm?: number;
    /** How long to wait for the iframe to load before giving up. */
    timeoutMs?: number;
    /** Leave the iframe in the DOM (debugging aid). */
    keepFrame?: boolean;
};

export class BrowserPrintTransport implements PrintTransport {
    readonly kind = 'browser' as const;

    constructor(private readonly options: BrowserPrintOptions = {}) {}

    isAvailable(): boolean {
        return typeof globalThis.document !== 'undefined' && typeof globalThis.print === 'function';
    }

    async print(doc: EscPosDoc, binding: PrinterBinding): Promise<PrintOutcome> {
        // No printer is configured — this is the placeholder receipt sink. Do NOT open the native
        // print dialog (it is modal and would block the till on every sale); the sale simply
        // completes without paper. `toDescriptor(doc)` still validates the document so a genuinely
        // malformed receipt is caught rather than silently swallowed.
        if (binding.placeholder === true) {
            toDescriptor(doc);
            return { ok: true, transport: this.kind, printerId: binding.id };
        }

        const document = globalThis.document;
        if (!document) {
            return {
                ok: false,
                transport: this.kind,
                printerId: binding.id,
                error: printError('unsupported', 'No document available', false),
            };
        }

        const html = descriptorToPrintHtml(toDescriptor(doc), this.options.widthMm ?? 80);

        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.setAttribute('tabindex', '-1');
        // Off-screen rather than display:none — a hidden frame does not always lay out for print.
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
        document.body.appendChild(frame);

        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('print frame timeout')), this.options.timeoutMs ?? 10_000);
                frame.addEventListener(
                    'load',
                    () => {
                        clearTimeout(timer);
                        resolve();
                    },
                    { once: true },
                );
                frame.srcdoc = html;
            });

            const frameWindow = frame.contentWindow;
            if (!frameWindow) throw new Error('print frame has no window');

            // Give the frame one paint before printing, otherwise Safari prints a blank page.
            await new Promise((resolve) => setTimeout(resolve, 50));
            frameWindow.focus();
            frameWindow.print();

            return { ok: true, transport: this.kind, printerId: binding.id };
        } catch (error) {
            return {
                ok: false,
                transport: this.kind,
                printerId: binding.id,
                error: printError('unknown', error instanceof Error ? error.message : String(error)),
            };
        } finally {
            if (this.options.keepFrame !== true) {
                // The print dialog is modal but asynchronous; removing the frame immediately can
                // cancel the job on some engines.
                setTimeout(() => frame.remove(), 1_000);
            }
        }
    }
}
