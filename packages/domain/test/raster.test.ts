import { describe, expect, it } from 'vitest';

import { rasterFromRgba } from '../src/escpos/raster';

/**
 * BAN-480 — the raster the printer actually prints.
 *
 * The serializer has always taken `{t:'image', raster}` and nothing ever produced one, so a receipt
 * printed `[image logo:1]` as literal text. These pin the arithmetic; the decode that feeds it needs
 * a browser and lives in the client adapter.
 */

/** A solid block of one colour. */
function solid(width: number, height: number, r: number, g: number, b: number, a = 255): Uint8ClampedArray {
    const out = new Uint8ClampedArray(width * height * 4);

    for (let i = 0; i < width * height; i++) {
        out[i * 4] = r;
        out[i * 4 + 1] = g;
        out[i * 4 + 2] = b;
        out[i * 4 + 3] = a;
    }

    return out;
}

function bitsSet(data: Uint8Array): number {
    let count = 0;

    for (const byte of data) {
        for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) count += 1;
    }

    return count;
}

describe('rasterFromRgba', () => {
    it('sizes the buffer exactly as the serializer requires', () => {
        // The doc type states it: `ceil(width / 8) * height`. A printer fed a short buffer prints
        // garbage for the remaining rows rather than failing.
        const raster = rasterFromRgba(solid(20, 3, 0, 0, 0), 20, 3, 384);

        expect(raster.width).toBe(20);
        expect(raster.height).toBe(3);
        expect(raster.data.length).toBe(Math.ceil(20 / 8) * 3);
    });

    it('prints every dot of a black image', () => {
        const raster = rasterFromRgba(solid(8, 2, 0, 0, 0), 8, 2, 384);

        expect([...raster.data]).toEqual([0xff, 0xff]);
    });

    it('prints no dot for a white image', () => {
        const raster = rasterFromRgba(solid(8, 2, 255, 255, 255), 8, 2, 384);

        expect([...raster.data]).toEqual([0x00, 0x00]);
    });

    it('composites transparency onto white rather than printing it black', () => {
        // A logo with a transparent background is the normal case. Treating alpha as black would
        // print a solid rectangle and empty the till's paper roll doing it.
        const raster = rasterFromRgba(solid(8, 2, 0, 0, 0, 0), 8, 2, 384);

        expect(bitsSet(raster.data)).toBe(0);
    });

    it('renders mid-grey as a stipple, not as all-or-nothing', () => {
        // The reason for dithering: a flat threshold turns a grey logo into either a blank or a
        // blotch. Roughly half the dots should fire.
        const raster = rasterFromRgba(solid(16, 16, 128, 128, 128), 16, 16, 384);
        const set = bitsSet(raster.data);

        expect(set).toBeGreaterThan(16 * 16 * 0.3);
        expect(set).toBeLessThan(16 * 16 * 0.7);
    });

    it('downscales a wide image to the printer width', () => {
        const raster = rasterFromRgba(solid(800, 200, 0, 0, 0), 800, 200, 384);

        expect(raster.width).toBe(384);
        // Aspect preserved: 200 * (384/800) = 96.
        expect(raster.height).toBe(96);
    });

    it('leaves an image narrower than the head alone', () => {
        // Upscaling a small logo to the full width would just make it blurry.
        const raster = rasterFromRgba(solid(100, 50, 0, 0, 0), 100, 50, 384);

        expect(raster.width).toBe(100);
        expect(raster.height).toBe(50);
    });

    it('preserves roughly the amount of ink when downscaling', () => {
        // What box sampling buys over nearest-neighbour: half a black image stays half black after a
        // 4x reduction. Nearest-neighbour can land every sample on one side of a pattern and report
        // all or nothing.
        //
        // Note what this does *not* claim: an isolated feature light enough to average above the
        // threshold — a one-pixel stroke reduced fourfold, say — can diffuse away without firing a
        // dot. That is error diffusion working as designed over too small an area to accumulate,
        // not a defect, and it is why a logo meant for a 58 mm head should be authored near 384 px.
        const width = 400;
        const height = 40;
        const rgba = solid(width, height, 255, 255, 255);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width / 2; x++) {
                const i = (y * width + x) * 4;
                rgba[i] = 0;
                rgba[i + 1] = 0;
                rgba[i + 2] = 0;
            }
        }

        const raster = rasterFromRgba(rgba, width, height, 100);
        const total = raster.width * raster.height;

        expect(bitsSet(raster.data)).toBeGreaterThan(total * 0.4);
        expect(bitsSet(raster.data)).toBeLessThan(total * 0.6);
    });

    it('returns an empty raster rather than throwing on a degenerate size', () => {
        expect(rasterFromRgba(new Uint8ClampedArray(0), 0, 0, 384)).toEqual({
            width: 0,
            height: 0,
            data: new Uint8Array(0),
        });
    });
});
