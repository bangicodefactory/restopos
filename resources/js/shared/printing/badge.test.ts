/**
 * The cashier badge label (BOF-120).
 *
 * The thing worth pinning here is not the layout — it is that this is the *only* place a badge can
 * be built. `employees.barcode_hash` is a SHA-256, so a badge cannot be reprinted from a record; the
 * plaintext exists for exactly as long as the editor holds it. These tests describe a builder that
 * takes the value as an argument and never goes looking for one.
 */

import { describe, expect, it } from 'vitest';

import { badgeDoc, badgeJob } from './badge';

const INPUT = { name: 'Karim M.', jobTitle: 'Chef de rang', badge: 'EMP-0041' };

/** Every node of a kind, flattened out of any groups. */
function nodesOfKind(doc: NonNullable<ReturnType<typeof badgeDoc>>, kind: string): unknown[] {
    const found: unknown[] = [];

    const walk = (nodes: readonly { t: string; children?: readonly unknown[] }[]): void => {
        for (const node of nodes) {
            if (node.t === kind) found.push(node);
            if (node.t === 'group') {
                walk((node.children ?? []) as { t: string }[]);
            }
        }
    };

    walk(doc.nodes as { t: string }[]);

    return found;
}

describe('badgeDoc', () => {
    it('encodes the badge value the manager typed', () => {
        const doc = badgeDoc(INPUT);
        const [barcode] = nodesOfKind(doc!, 'barcode') as { data: string; symbology: string }[];

        expect(barcode?.data).toBe('EMP-0041');
    });

    it('uses code128, because a badge value may contain letters', () => {
        // The numeric symbologies would refuse `EMP-0041` outright, and a manager is free to use one.
        const [barcode] = nodesOfKind(badgeDoc(INPUT)!, 'barcode') as { symbology: string }[];

        expect(barcode?.symbology).toBe('code128');
    });

    it('prints the value in human-readable form under the bars', () => {
        // When a scanner fails mid-service somebody has to read the badge out loud.
        const [barcode] = nodesOfKind(badgeDoc(INPUT)!, 'barcode') as { hri: string }[];

        expect(barcode?.hri).toBe('below');
    });

    it('carries the name and the job title', () => {
        const text = JSON.stringify(badgeDoc(INPUT)!.nodes);

        expect(text).toContain('Karim M.');
        expect(text).toContain('Chef de rang');
    });

    it('prints without a job title, which is optional', () => {
        const doc = badgeDoc({ name: 'Karim M.', badge: 'EMP-0041' });

        expect(doc).not.toBeNull();
        expect(JSON.stringify(doc!.nodes)).toContain('Karim M.');
    });

    it('builds at label width rather than receipt width', () => {
        // 42 columns is the receipt roll. A name that wraps mid-word on the one document whose
        // entire purpose is the name is not a badge.
        expect(badgeDoc(INPUT)!.width).toBe(32);
    });

    it('declares itself a badge, so the router and the audit trail can tell', () => {
        expect(badgeDoc(INPUT)!.meta.kind).toBe('badge');
    });

    it('cuts, so the label separates from the roll', () => {
        expect(nodesOfKind(badgeDoc(INPUT)!, 'cut')).toHaveLength(1);
    });

    it('refuses to build a badge with no value', () => {
        // A label with an empty barcode is a blank sticker that looks like a badge, which is worse
        // than no label at all.
        expect(badgeDoc({ ...INPUT, badge: '' })).toBeNull();
        expect(badgeDoc({ ...INPUT, badge: '   ' })).toBeNull();
    });

    it('refuses to build a badge with no name', () => {
        expect(badgeDoc({ ...INPUT, name: '  ' })).toBeNull();
    });

    it('trims, so a trailing space does not become part of the barcode', () => {
        const [barcode] = nodesOfKind(badgeDoc({ ...INPUT, badge: '  EMP-0041 ' })!, 'barcode') as {
            data: string;
        }[];

        expect(barcode?.data).toBe('EMP-0041');
    });
});

describe('badgeJob', () => {
    it('routes to the label role, not the receipt roll', () => {
        // A venue with no label printer bound gets nothing routed, which is the router's existing
        // behaviour and the right one here.
        expect(badgeJob(INPUT, 'job-1')?.role).toBe('label');
    });

    it('prints one copy', () => {
        expect(badgeJob(INPUT, 'job-1')?.copies).toBe(1);
    });

    it('is null when there is nothing to print', () => {
        expect(badgeJob({ ...INPUT, badge: '' }, 'job-1')).toBeNull();
    });
});
