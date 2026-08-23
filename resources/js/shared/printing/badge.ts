/**
 * The cashier badge label (BOF-120).
 *
 * A badge is the barcode an employee scans to sign in at a register. This builds the label that goes
 * on it: their name, their job title, and the barcode itself.
 *
 * **It can only be built where the badge value is known, and that is not the employee list.**
 * `employees.barcode_hash` is a SHA-256 — the plaintext is never stored, which is the whole point of
 * it. So there is no way to reprint a badge from a record: the only moment the value exists is when
 * a manager types it into the editor, and that is where the action lives. A lost badge is not
 * reprinted, it is reissued.
 *
 * The label prints on the `label` printer role. A venue with no label printer bound gets nothing
 * routed rather than a badge on the receipt roll, which is the router's existing behaviour and the
 * right one — a badge on 80mm thermal paper is not a badge.
 */

import { EscPosBuilder } from '@domain/escpos/index';
import type { EscPosDoc } from '@domain/escpos/index';

import type { PrintJob } from './types';

export type BadgeInput = {
    name: string;
    jobTitle?: string | null;
    /** The plaintext badge value, as typed. Never read back from the server. */
    badge: string;
};

/**
 * Labels are narrower than receipts.
 *
 * 32 columns is the font-A width of the 58mm stock most label printers take. Building at 42 and
 * hoping produces a name that wraps mid-word on the one document where the name is the point.
 */
const LABEL_WIDTH = 32;

/** The badge label, or `null` when there is no badge value to encode. */
export function badgeDoc(input: BadgeInput): EscPosDoc | null {
    const badge = input.badge.trim();
    const name = input.name.trim();

    if (badge === '' || name === '') return null;

    const builder = new EscPosBuilder({ kind: 'badge', width: LABEL_WIDTH, title: name })
        .title(name)
        .when((input.jobTitle ?? '').trim() !== '', (b) => b.subtitle((input.jobTitle ?? '').trim()))
        .feed(1)
        // `code128` because a badge value is arbitrary text — the numeric symbologies would silently
        // refuse anything with a letter in it, and a manager is free to use one.
        //
        // The human-readable line is printed below the bars on purpose: when a scanner fails at 7pm,
        // somebody has to be able to read the badge out loud.
        .barcode(badge, 'code128', { height: 64, hri: 'below', align: 'center' })
        .feed(2)
        .cut('partial');

    return builder.build();
}

/** The badge as a print job, or `null` when there is nothing to print. */
export function badgeJob(input: BadgeInput, id: string): PrintJob | null {
    const doc = badgeDoc(input);

    if (doc === null) return null;

    return { id, doc, role: 'label', copies: 1, createdAt: 0 };
}
