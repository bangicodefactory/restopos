import type { EscPosDoc } from '@domain/escpos';
import { describe, expect, it } from 'vitest';

import { resolveDocImages } from './images';

/**
 * BAN-480 — the walk that decides whether a receipt prints its logo.
 *
 * The decode itself needs `createImageBitmap` and a canvas, which vitest's node environment does not
 * have. But the decode is not where the interesting decisions are: what matters is that a node with
 * no bytes behind it is **dropped** rather than passed through, because the serializer prints a bare
 * key as the literal text `[image logo:1]` — a receipt handed to a customer with a placeholder on it
 * is the exact bug this change exists to fix.
 *
 * Every case below stops before the decode, so they all run headless.
 */

function doc(nodes: EscPosDoc['nodes']): EscPosDoc {
    return { width: 32, profile: 'generic', nodes } as unknown as EscPosDoc;
}

/** A blob store holding whatever is passed in, and nothing else. */
function fakeDb(blobs: Record<string, Blob> = {}) {
    return {
        blobs: {
            get: (key: string) =>
                Promise.resolve(blobs[key] === undefined ? undefined : { key, blob: blobs[key] }),
        },
    } as never;
}

describe('resolveDocImages', () => {
    it('returns the same document when nothing needs resolving', async () => {
        // The common case by far — most receipts have no logo configured — so it must not cost a
        // rebuild of the node list, let alone a database read.
        const original = doc([{ t: 'text', v: 'TOTAL' }]);

        await expect(resolveDocImages(original, fakeDb())).resolves.toBe(original);
    });

    it('drops an image whose bytes are not cached', async () => {
        // Offline before the logo was ever fetched, or a media row whose file has gone. The receipt
        // must still print — without the logo, and without `[image logo:1]` where it should be.
        const resolved = await resolveDocImages(
            doc([
                { t: 'text', v: 'ACME' },
                { t: 'image', key: 'logo:1' },
                { t: 'text', v: 'TOTAL' },
            ]),
            fakeDb(),
        );

        expect(resolved.nodes).toHaveLength(2);
        expect(resolved.nodes.every((node) => node.t !== 'image')).toBe(true);
    });

    it('leaves a node that already carries a raster alone', async () => {
        // A caller that rasterised for itself must not be second-guessed, and must not pay for a
        // blob lookup that would find nothing.
        const raster = { width: 8, height: 1, data: new Uint8Array([0xff]) };
        const resolved = await resolveDocImages(doc([{ t: 'image', raster }]), fakeDb());

        expect(resolved.nodes).toHaveLength(1);
        expect(resolved.nodes[0]).toMatchObject({ t: 'image', raster });
    });

    it('does not mutate the document it was given', async () => {
        // The doc may be retried by the outbox, so resolution has to be a pure transformation —
        // a mutated original would lose its image key on the first attempt and never regain it.
        const original = doc([{ t: 'image', key: 'logo:1' }]);

        await resolveDocImages(original, fakeDb());

        expect(original.nodes).toHaveLength(1);
        expect(original.nodes[0]).toMatchObject({ t: 'image', key: 'logo:1' });
    });
});
