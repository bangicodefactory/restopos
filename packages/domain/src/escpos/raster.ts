import type { RasterImage } from './doc';

/**
 * RGBA pixels → the 1-bit raster an ESC/POS printer prints (BAN-480).
 *
 * The serializer has always accepted `{t:'image', raster}` and `receipt.ts` has always emitted
 * `{t:'image', key:'logo:{id}'}`, but nothing ever turned one into the other — so every receipt
 * printed `[image logo:1]` as text where the logo should have been.
 *
 * A thermal head prints a dot or it does not: there is no grey. Rounding each pixel to the nearest
 * of black and white turns a logo into a blotch, because the error at every pixel is thrown away.
 * Floyd–Steinberg pushes that error into the neighbours not yet visited, so a mid-grey region comes
 * out as a stipple that reads as grey from reading distance. It is the difference between a legible
 * mark and a smudge, and it costs one pass.
 *
 * Pure and browser-free on purpose: decoding a Blob needs `createImageBitmap` and a canvas, which do
 * not exist under vitest's node environment. The decode lives in the client adapter; the arithmetic
 * — which is the part that can be wrong — lives here where it can be tested.
 */

/** How dark a pixel must be to print. Mid-grey, after alpha is composited onto white. */
const THRESHOLD = 128;

/**
 * Pack RGBA into a raster, downscaling to `targetWidth` if the source is wider.
 *
 * @param rgba   Row-major RGBA, 4 bytes per pixel — `ImageData.data`.
 * @param width  Source width in pixels.
 * @param height Source height in pixels.
 * @param targetWidth Printer dot width for the image, e.g. 384 on a 58 mm head.
 */
export function rasterFromRgba(
    rgba: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    targetWidth: number,
): RasterImage {
    if (width <= 0 || height <= 0 || targetWidth <= 0) {
        return { width: 0, height: 0, data: new Uint8Array(0) };
    }

    const scale = Math.min(1, targetWidth / width);
    const outWidth = Math.max(1, Math.round(width * scale));
    const outHeight = Math.max(1, Math.round(height * scale));

    // Greyscale first, at the output size. Box-sampling rather than nearest-neighbour: a logo
    // downscaled by picking one source pixel per destination loses thin strokes entirely.
    const grey = new Float32Array(outWidth * outHeight);

    for (let y = 0; y < outHeight; y++) {
        const y0 = Math.floor((y * height) / outHeight);
        const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outHeight));

        for (let x = 0; x < outWidth; x++) {
            const x0 = Math.floor((x * width) / outWidth);
            const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outWidth));

            let sum = 0;
            let count = 0;

            for (let sy = y0; sy < y1 && sy < height; sy++) {
                for (let sx = x0; sx < x1 && sx < width; sx++) {
                    const i = (sy * width + sx) * 4;
                    const alpha = (rgba[i + 3] ?? 255) / 255;

                    // Composited onto white: a transparent logo must not print as a black box.
                    const luma =
                        0.299 * (rgba[i] ?? 0) + 0.587 * (rgba[i + 1] ?? 0) + 0.114 * (rgba[i + 2] ?? 0);

                    sum += luma * alpha + 255 * (1 - alpha);
                    count += 1;
                }
            }

            grey[y * outWidth + x] = count === 0 ? 255 : sum / count;
        }
    }

    // Floyd–Steinberg, in place over the greyscale buffer.
    const bytesPerRow = Math.ceil(outWidth / 8);
    const data = new Uint8Array(bytesPerRow * outHeight);

    for (let y = 0; y < outHeight; y++) {
        for (let x = 0; x < outWidth; x++) {
            const index = y * outWidth + x;
            const old = grey[index] ?? 255;
            const isBlack = old < THRESHOLD;
            const next = isBlack ? 0 : 255;
            const error = old - next;

            if (isBlack) {
                // 1 = print a dot. Bit 7 is the leftmost pixel of the byte.
                const at = y * bytesPerRow + (x >> 3);
                data[at] = (data[at] ?? 0) | (0x80 >> (x & 7));
            }

            diffuse(grey, outWidth, outHeight, x + 1, y, (error * 7) / 16);
            diffuse(grey, outWidth, outHeight, x - 1, y + 1, (error * 3) / 16);
            diffuse(grey, outWidth, outHeight, x, y + 1, (error * 5) / 16);
            diffuse(grey, outWidth, outHeight, x + 1, y + 1, (error * 1) / 16);
        }
    }

    return { width: outWidth, height: outHeight, data };
}

function diffuse(grey: Float32Array, width: number, height: number, x: number, y: number, delta: number): void {
    if (x < 0 || x >= width || y < 0 || y >= height) return;

    grey[y * width + x] = (grey[y * width + x] ?? 0) + delta;
}
