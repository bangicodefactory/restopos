import type { EscPosDoc, EscPosNode, RasterImage } from '@domain/escpos';
import { rasterFromRgba } from '@domain/escpos';

import type { PosDb } from '../db';
import { mediaBlob } from '../media';

/**
 * Resolve `{t:'image', key}` nodes into printable rasters (BAN-480).
 *
 * `receipt.ts` has always emitted `{t:'image', key:'logo:{id}'}` and the serializer has always taken
 * `raster`, with nothing in between — so a receipt printed the literal text `[image logo:1]` where
 * the logo belongs. `types.ts` even documents a `resolveImages` seam "passed in rather than
 * imported, because image resolution needs the blob store". This is that function, finally written.
 *
 * Failure is never fatal. A missing blob, an undecodable file, a browser without `OffscreenCanvas` —
 * all of them drop the node rather than the receipt. A sale that cannot print because the logo is
 * missing is a far worse outcome than a receipt with no logo, and the customer is waiting.
 */
export async function resolveDocImages(doc: EscPosDoc, db: PosDb): Promise<EscPosDoc> {
    if (!doc.nodes.some((node) => node.t === 'image' && node.key !== undefined && node.raster === undefined)) {
        return doc;
    }

    const nodes: EscPosNode[] = [];

    for (const node of doc.nodes) {
        if (node.t !== 'image' || node.key === undefined || node.raster !== undefined) {
            nodes.push(node);

            continue;
        }

        const raster = await rasterFor(db, node.key, doc.width * 12);

        // Dropped, not kept as a bare key: the serializer would otherwise print the placeholder
        // text, and "[image logo:1]" on a customer's receipt looks like a broken till.
        if (raster !== null) nodes.push({ ...node, raster });
    }

    return { ...doc, nodes };
}

/**
 * Decode a cached blob into a raster at the printer's dot width.
 *
 * `doc.width` is in characters; a 58 mm head is 32 characters and 384 dots, so twelve dots per
 * character is the ratio the rest of the printing stack assumes.
 */
async function rasterFor(db: PosDb, key: string, targetWidth: number): Promise<RasterImage | null> {
    const blob = await mediaBlob(db, key);
    if (blob === null) return null;

    try {
        const bitmap = await createImageBitmap(blob);

        try {
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext('2d');

            if (context === null) return null;

            context.drawImage(bitmap, 0, 0);
            const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);

            return rasterFromRgba(pixels.data, bitmap.width, bitmap.height, targetWidth);
        } finally {
            bitmap.close();
        }
    } catch {
        return null;
    }
}
