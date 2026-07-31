#!/usr/bin/env node
/**
 * PWA icon generator.
 *
 * Writes public/icons/{app}-{192,512}.png plus a maskable 512 for each of the four surfaces.
 *
 * No dependencies on purpose: `sharp`/`canvas` are native modules that would have to build on every
 * developer machine and in CI just to produce eight flat-colour squares. Instead we rasterise a few
 * geometric primitives into an RGBA buffer and encode the PNG by hand (zlib comes from Node).
 *
 * The icons are placeholders in the *design* sense — a real brand mark drops in by replacing the
 * files — but they are correct in every way the platform cares about: right sizes, right purposes,
 * 20 % safe zone on the maskable variants, opaque background (Android composites transparent icons
 * onto white and a white-on-white glyph disappears).
 *
 *   node tools/icons/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'icons');

// ── PNG encoding ─────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xffffffff;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}

/** RGBA buffer → PNG (colour type 6, bit depth 8, filter 0 on every scanline). */
function encodePng(width, height, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0; // deflate
    ihdr[11] = 0; // adaptive filtering
    ihdr[12] = 0; // no interlace

    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ── drawing ──────────────────────────────────────────────────────────────────

function createCanvas(size) {
    return { size, data: Buffer.alloc(size * size * 4) };
}

function hexToRgb(hex) {
    const value = hex.replace('#', '');
    return [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16),
    ];
}

/** Source-over blend of one pixel; `alpha` is 0..1 and gives us cheap antialiasing. */
function blend(canvas, x, y, [r, g, b], alpha) {
    if (alpha <= 0 || x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
    const i = (y * canvas.size + x) * 4;
    const a = Math.min(1, alpha);
    const dstA = canvas.data[i + 3] / 255;
    const outA = a + dstA * (1 - a);
    if (outA === 0) return;
    for (let c = 0; c < 3; c++) {
        const src = [r, g, b][c];
        const dst = canvas.data[i + c];
        canvas.data[i + c] = Math.round((src * a + dst * dstA * (1 - a)) / outA);
    }
    canvas.data[i + 3] = Math.round(outA * 255);
}

/**
 * Signed-distance fill: `sdf(x, y)` returns the distance to the shape's edge in pixels (negative
 * inside). One pixel of falloff gives clean antialiased edges at every size for free.
 */
function fillSdf(canvas, sdf, colour, alpha = 1) {
    for (let y = 0; y < canvas.size; y++) {
        for (let x = 0; x < canvas.size; x++) {
            const d = sdf(x + 0.5, y + 0.5);
            const coverage = Math.min(1, Math.max(0, 0.5 - d));
            if (coverage > 0) blend(canvas, x, y, colour, coverage * alpha);
        }
    }
}

const roundedRect = (x, y, w, h, r) => (px, py) => {
    const dx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
    const dy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    return outside + Math.min(Math.max(dx, dy), 0) - r;
};

const circle = (cx, cy, r) => (px, py) => Math.hypot(px - cx, py - cy) - r;

/** Half-disc, flat side down — the cloche dome on the kitchen icon. */
const dome = (cx, cy, r) => (px, py) => Math.max(Math.hypot(px - cx, py - cy) - r, py - cy);

// ── glyphs ───────────────────────────────────────────────────────────────────

const GLYPHS = {
    /** A receipt with three lines of text. */
    register(canvas, box, fg) {
        const { x, y, w, h } = box;
        fillSdf(canvas, roundedRect(x + w * 0.18, y + h * 0.08, w * 0.64, h * 0.84, w * 0.06), fg);
        const accent = [15, 23, 42];
        for (let i = 0; i < 3; i++) {
            const ly = y + h * (0.26 + i * 0.18);
            fillSdf(canvas, roundedRect(x + w * 0.3, ly, w * 0.4 - i * w * 0.08, h * 0.07, h * 0.035), accent);
        }
    },

    /** A cloche: dome plus a base bar. */
    kitchen(canvas, box, fg) {
        const { x, y, w, h } = box;
        fillSdf(canvas, dome(x + w * 0.5, y + h * 0.66, w * 0.34), fg);
        fillSdf(canvas, roundedRect(x + w * 0.14, y + h * 0.68, w * 0.72, h * 0.1, h * 0.05), fg);
        fillSdf(canvas, circle(x + w * 0.5, y + h * 0.26, w * 0.05), fg);
    },

    /** A phone with a menu list on it. */
    selforder(canvas, box, fg) {
        const { x, y, w, h } = box;
        fillSdf(canvas, roundedRect(x + w * 0.28, y + h * 0.08, w * 0.44, h * 0.84, w * 0.09), fg);
        const accent = [15, 23, 42];
        for (let i = 0; i < 3; i++) {
            const ly = y + h * (0.26 + i * 0.17);
            fillSdf(canvas, circle(x + w * 0.37, ly + h * 0.035, w * 0.03), accent);
            fillSdf(canvas, roundedRect(x + w * 0.44, ly, w * 0.22, h * 0.07, h * 0.035), accent);
        }
    },

    /** A bar chart. */
    backoffice(canvas, box, fg) {
        const { x, y, w, h } = box;
        const heights = [0.34, 0.56, 0.44, 0.72];
        heights.forEach((value, i) => {
            const bw = w * 0.15;
            const bx = x + w * 0.14 + i * (bw + w * 0.06);
            fillSdf(canvas, roundedRect(bx, y + h * (0.9 - value), bw, h * value, bw * 0.28), fg);
        });
    },
};

const APPS = {
    register: { bg: '#0f172a', fg: '#f8fafc' },
    kitchen: { bg: '#0a0f14', fg: '#4ade80' },
    selforder: { bg: '#1d4ed8', fg: '#ffffff' },
    backoffice: { bg: '#1e293b', fg: '#60a5fa' },
};

function renderIcon(app, size, maskable) {
    const canvas = createCanvas(size);
    const { bg, fg } = APPS[app];

    if (maskable) {
        // Maskable icons are cropped to an arbitrary shape: bleed the background to every edge.
        fillSdf(canvas, () => -1, hexToRgb(bg));
    } else {
        fillSdf(canvas, roundedRect(0, 0, size, size, size * 0.22), hexToRgb(bg));
    }

    // 20 % safe zone for maskable, a comfortable 16 % otherwise.
    const inset = maskable ? size * 0.2 : size * 0.16;
    const box = { x: inset, y: inset, w: size - inset * 2, h: size - inset * 2 };

    GLYPHS[app](canvas, box, hexToRgb(fg));
    return encodePng(size, size, canvas.data);
}

// ── main ─────────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

const written = [];
for (const app of Object.keys(APPS)) {
    for (const size of [192, 512]) {
        const file = join(OUT_DIR, `${app}-${size}.png`);
        writeFileSync(file, renderIcon(app, size, false));
        written.push(file);
    }
    const maskable = join(OUT_DIR, `${app}-maskable-512.png`);
    writeFileSync(maskable, renderIcon(app, 512, true));
    written.push(maskable);
}

console.log(`Wrote ${written.length} icons to ${OUT_DIR}`);
for (const file of written) console.log('  ', file.replace(`${process.cwd()}/`, ''));
