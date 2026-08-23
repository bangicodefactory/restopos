/**
 * Printing a cashier badge from the back office (BOF-120).
 *
 * The back office binds no printers — that is the register's job, and a manager sitting at a laptop
 * has no ePOS device on the LAN to route to. So this goes through `BrowserPrintTransport`, the
 * module's documented last resort: a hidden iframe and `window.print()`, which reaches whatever the
 * operator's machine can already print to, including the office label printer.
 *
 * **Only callable while the badge value is on screen.** `employees.barcode_hash` is a SHA-256, so
 * there is nothing to reprint from a record; the plaintext exists for exactly as long as the editor
 * holds it. A lost badge is reissued, not reprinted, and that is a property of the storage rather
 * than a gap in this function.
 */

import { BrowserPrintTransport, badgeDoc, type BadgeInput } from '@shared/printing';
import type { PrinterBinding } from '@shared/printing';

/**
 * A binding that means "whatever this machine prints to".
 *
 * Not a placeholder: `BrowserPrintTransport` treats `placeholder: true` as a sink that validates and
 * discards, which is right for a till completing a sale with no paper and wrong here — the operator
 * pressed a button and expects a dialog.
 */
const BROWSER_TARGET: PrinterBinding = {
    id: 'browser',
    name: 'Browser',
    role: 'label',
    categoryIds: [],
    transport: 'browser',
    address: '',
    profile: 'generic',
    enabled: true,
    status: { online: true, paper: 'unknown', cover: 'unknown', checkedAt: 0 },
};

/** `true` when the badge reached a print dialog. */
export async function printBadge(input: BadgeInput): Promise<boolean> {
    const doc = badgeDoc(input);

    if (doc === null) return false;

    const transport = new BrowserPrintTransport({ widthMm: 58 });

    if (!transport.isAvailable()) return false;

    const outcome = await transport.print(doc, BROWSER_TARGET);

    return outcome.ok;
}
