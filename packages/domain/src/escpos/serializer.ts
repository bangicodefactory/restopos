import { canEncode, displayWidth, encodeText } from './codepage';
import {
    columnsFor,
    mergeStyle,
    SIZE_MULTIPLIERS,
    type Align,
    type BarcodeSymbology,
    type EscPosDoc,
    type EscPosNode,
    type RasterImage,
    type TextStyle,
} from './doc';
import type { PrinterProfile } from './profiles';

/** ESC/POS control bytes. */
export const ESC = 0x1b;
export const GS = 0x1d;
export const LF = 0x0a;
export const NUL = 0x00;

/** Growable byte sink. Avoids the quadratic cost of concatenating Uint8Arrays. */
export class ByteBuilder {
    private chunks: Uint8Array[] = [];
    private length = 0;

    raw(...bytes: number[]): this {
        return this.push(Uint8Array.from(bytes));
    }

    push(bytes: Uint8Array): this {
        if (bytes.length === 0) return this;
        this.chunks.push(bytes);
        this.length += bytes.length;
        return this;
    }

    size(): number {
        return this.length;
    }

    build(): Uint8Array {
        const out = new Uint8Array(this.length);
        let offset = 0;
        for (const chunk of this.chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }
}

const ALIGN_CODE: Record<Align, number> = { left: 0, center: 1, right: 2 };

const BARCODE_CODE: Record<BarcodeSymbology, number> = {
    upca: 65,
    ean13: 67,
    ean8: 68,
    code39: 69,
    itf: 70,
    code93: 72,
    code128: 73,
};

const HRI_CODE = { none: 0, above: 1, below: 2, both: 3 } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Text layout — pure string helpers, exported because the React renderer reuses them
// ─────────────────────────────────────────────────────────────────────────────

export function padTo(text: string, width: number, align: Align = 'left', fill = ' '): string {
    const len = displayWidth(text);
    if (len >= width) return truncate(text, width);
    const pad = fill.repeat(Math.max(0, width - len));
    if (align === 'right') return pad + text;
    if (align === 'center') {
        const left = Math.floor((width - len) / 2);
        return fill.repeat(left) + text + fill.repeat(width - len - left);
    }
    return text + pad;
}

export function truncate(text: string, width: number): string {
    if (displayWidth(text) <= width) return text;
    let out = '';
    let n = 0;
    for (const ch of text) {
        const w = displayWidth(ch);
        if (n + w > width) break;
        out += ch;
        n += w;
    }
    return out;
}

/** "Label ................ 12.30" — the workhorse of every receipt. */
export function layoutRow(left: string, right: string, width: number, fill = ' '): string {
    const r = truncate(right, width);
    const room = width - displayWidth(r);
    const l = truncate(left, Math.max(0, room - 1));
    const gap = Math.max(1, room - displayWidth(l));
    return l + (fill === ' ' ? ' '.repeat(gap) : fill.repeat(gap)) + r;
}

export function layoutCols(
    cells: ReadonlyArray<{ v: string; w: number; align?: Align }>,
    width: number,
): string {
    const declared = cells.reduce((sum, c) => sum + c.w, 0);
    // Distribute rounding slack to the last cell so columns always fill the line exactly.
    let remaining = width;
    let out = '';
    cells.forEach((cell, i) => {
        const isLast = i === cells.length - 1;
        const w = isLast ? remaining : Math.max(1, Math.round((cell.w / declared) * width));
        out += padTo(cell.v, Math.min(w, remaining), cell.align ?? 'left');
        remaining -= w;
    });
    return truncate(out, width);
}

/** Hard-wrap on word boundaries, falling back to a hard break for unbreakable runs. */
export function wrap(text: string, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
        if (paragraph === '') {
            lines.push('');
            continue;
        }
        let current = '';
        for (const word of paragraph.split(/\s+/).filter((w) => w !== '')) {
            if (current === '') {
                current = word;
            } else if (displayWidth(current) + 1 + displayWidth(word) <= width) {
                current += ' ' + word;
            } else {
                lines.push(current);
                current = word;
            }
            while (displayWidth(current) > width) {
                lines.push(truncate(current, width));
                current = [...current].slice(width).join('');
            }
        }
        if (current !== '') lines.push(current);
    }
    return lines.length ? lines : [''];
}

// ─────────────────────────────────────────────────────────────────────────────
// Serializer
// ─────────────────────────────────────────────────────────────────────────────

type EmitState = { align: Align; bold: boolean; underline: boolean; invert: boolean; size: number };

function sizeByte(style: TextStyle): number {
    const { w, h } = SIZE_MULTIPLIERS[style.size ?? 'md'];
    return ((w - 1) << 4) | (h - 1);
}

function applyStyle(b: ByteBuilder, state: EmitState, style: TextStyle): void {
    const align = style.align ?? 'left';
    if (align !== state.align) {
        b.raw(ESC, 0x61, ALIGN_CODE[align]);
        state.align = align;
    }
    const bold = style.bold === true;
    if (bold !== state.bold) {
        b.raw(ESC, 0x45, bold ? 1 : 0);
        state.bold = bold;
    }
    const underline = style.underline === true;
    if (underline !== state.underline) {
        b.raw(ESC, 0x2d, underline ? 1 : 0);
        state.underline = underline;
    }
    const invert = style.invert === true;
    if (invert !== state.invert) {
        b.raw(GS, 0x42, invert ? 1 : 0);
        state.invert = invert;
    }
    const size = sizeByte(style);
    if (size !== state.size) {
        b.raw(GS, 0x21, size);
        state.size = size;
    }
}

function emitLine(b: ByteBuilder, text: string, codepage: EscPosDoc['codepage']): void {
    b.push(encodeText(text, codepage));
    b.raw(LF);
}

/** `GS v 0` raster bit image, chunked so no single command exceeds the printer's buffer. */
export function emitRaster(b: ByteBuilder, img: RasterImage, profile: PrinterProfile): void {
    const bytesPerRow = Math.ceil(img.width / 8);
    const maxRows = 255; // keep yH at 0/1 territory and stay inside modest buffers
    for (let y = 0; y < img.height; y += maxRows) {
        const rows = Math.min(maxRows, img.height - y);
        const slice = img.data.subarray(y * bytesPerRow, (y + rows) * bytesPerRow);
        if (profile.rasterGsV0) {
            b.raw(GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, rows & 0xff, (rows >> 8) & 0xff);
            b.push(slice);
        } else {
            // ESC * column mode fallback: emit row by row as 8-dot single-density strips.
            for (let r = 0; r < rows; r++) {
                b.raw(ESC, 0x2a, 0x00, img.width & 0xff, (img.width >> 8) & 0xff);
                b.push(slice.subarray(r * bytesPerRow, (r + 1) * bytesPerRow));
                b.raw(LF);
            }
        }
    }
}

function emitQr(
    b: ByteBuilder,
    node: Extract<EscPosNode, { t: 'qr' }>,
    doc: EscPosDoc,
    profile: PrinterProfile,
): void {
    if (!profile.nativeQr) {
        // No native QR: the caller must have pre-rasterised. Print the payload as text so the
        // receipt is still useful rather than silently dropping it.
        emitLine(b, truncate(node.data, doc.width), doc.codepage);
        return;
    }
    const ecByte = { L: 48, M: 49, Q: 50, H: 51 }[node.ec ?? 'M'];
    const size = node.size ?? 5;

    // GS ( k  pL pH cn fn n : select model 2
    b.raw(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);
    // module size
    b.raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, size);
    // error correction
    b.raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, ecByte);
    // store data
    const payload = encodeText(node.data, doc.codepage === 'utf8' ? 'utf8' : 'cp437');
    const len = payload.length + 3;
    b.raw(GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30);
    b.push(payload);
    // print
    b.raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);
}

function emitBarcode(
    b: ByteBuilder,
    node: Extract<EscPosNode, { t: 'barcode' }>,
    doc: EscPosDoc,
    profile: PrinterProfile,
): void {
    if (!profile.nativeBarcode) {
        emitLine(b, truncate(node.data, doc.width), doc.codepage);
        return;
    }
    b.raw(GS, 0x68, Math.max(1, Math.min(255, node.height ?? 64))); // GS h — height
    b.raw(GS, 0x77, 2); // GS w — module width
    b.raw(GS, 0x48, HRI_CODE[node.hri ?? 'below']); // GS H — HRI position

    const m = BARCODE_CODE[node.symbology];
    let data = node.data;
    if (node.symbology === 'code128' && !data.startsWith('{')) data = '{B' + data;

    const bytes = encodeText(data, 'cp437');
    b.raw(GS, 0x6b, m, bytes.length);
    b.push(bytes);
}

function emit(b: ByteBuilder, node: EscPosNode, doc: EscPosDoc, profile: PrinterProfile, state: EmitState, inherited: TextStyle): void {
    switch (node.t) {
        case 'group': {
            const style = mergeStyle(inherited, node.style);
            for (const child of node.children) emit(b, child, doc, profile, state, style);
            return;
        }

        case 'text': {
            const style = mergeStyle(inherited, node.style);
            applyStyle(b, state, style);
            const cols = columnsFor(doc.width, style.size);
            for (const line of wrap(node.v, cols)) {
                emitLine(b, style.align === 'left' || !style.align ? line : padTo(line, cols, style.align), doc.codepage);
            }
            return;
        }

        case 'row': {
            const style = mergeStyle(inherited, node.style);
            applyStyle(b, state, { ...style, align: 'left' });
            state.align = 'left';
            emitLine(b, layoutRow(node.left, node.right, columnsFor(doc.width, style.size), node.fill ?? ' '), doc.codepage);
            return;
        }

        case 'cols': {
            const style = mergeStyle(inherited, node.style);
            applyStyle(b, state, { ...style, align: 'left' });
            state.align = 'left';
            emitLine(b, layoutCols(node.cells, columnsFor(doc.width, style.size)), doc.codepage);
            return;
        }

        case 'rule': {
            applyStyle(b, state, { ...mergeStyle(inherited, undefined), align: 'left', size: 'md' });
            emitLine(b, (node.char ?? '-').repeat(doc.width), doc.codepage);
            return;
        }

        case 'feed': {
            for (let i = 0; i < Math.max(0, node.n); i++) b.raw(LF);
            return;
        }

        case 'image': {
            applyStyle(b, state, { align: node.align ?? 'center' });
            if (node.raster) emitRaster(b, node.raster, profile);
            return;
        }

        case 'qr': {
            applyStyle(b, state, { align: node.align ?? 'center' });
            emitQr(b, node, doc, profile);
            return;
        }

        case 'barcode': {
            applyStyle(b, state, { align: node.align ?? 'center' });
            emitBarcode(b, node, doc, profile);
            return;
        }

        case 'pulse': {
            // ESC p m t1 t2 — drawer kick.
            b.raw(ESC, 0x70, node.pin ?? profile.drawer.pin, node.on ?? profile.drawer.on, node.off ?? profile.drawer.off);
            return;
        }

        case 'cut': {
            for (let i = 0; i < profile.feedBeforeCut; i++) b.raw(LF);
            const partial = (node.mode ?? 'partial') === 'partial' && profile.partialCut;
            // GS V A n — feed then cut.
            b.raw(GS, 0x56, partial ? 0x42 : 0x41, 0x00);
            return;
        }
    }
}

/**
 * Render the IR to ESC/POS bytes. Pure: no DOM, no fetch, no clock.
 *
 * The caller is responsible for resolving `{t:'image', key}` nodes into `raster` before calling —
 * blob lookup is a client-side concern and `packages/domain` never touches storage.
 */
export function toEscPos(doc: EscPosDoc, profile: PrinterProfile): Uint8Array {
    const b = new ByteBuilder();
    const state: EmitState = { align: 'left', bold: false, underline: false, invert: false, size: 0 };

    b.raw(ESC, 0x40); // ESC @ — initialise
    const cpId = profile.codepageIds[doc.codepage];
    if (cpId !== undefined) b.raw(ESC, 0x74, cpId); // ESC t — select codepage

    for (const node of doc.nodes) emit(b, node, doc, profile, state, {});

    // Leave the printer in a known state for whatever prints next.
    b.raw(ESC, 0x45, 0x00, ESC, 0x2d, 0x00, GS, 0x42, 0x00, GS, 0x21, 0x00, ESC, 0x61, 0x00);
    return b.build();
}

/** Plain-text rendering of the IR — the fallback body for `window.print()` and for snapshots. */
export function toPlainText(doc: EscPosDoc): string {
    const lines: string[] = [];

    const visit = (node: EscPosNode, inherited: TextStyle): void => {
        switch (node.t) {
            case 'group':
                for (const child of node.children) visit(child, mergeStyle(inherited, node.style));
                return;
            case 'text': {
                const style = mergeStyle(inherited, node.style);
                const cols = columnsFor(doc.width, style.size);
                for (const line of wrap(node.v, cols)) lines.push(padTo(line, cols, style.align ?? 'left'));
                return;
            }
            case 'row': {
                const style = mergeStyle(inherited, node.style);
                lines.push(layoutRow(node.left, node.right, columnsFor(doc.width, style.size), node.fill ?? ' '));
                return;
            }
            case 'cols': {
                const style = mergeStyle(inherited, node.style);
                lines.push(layoutCols(node.cells, columnsFor(doc.width, style.size)));
                return;
            }
            case 'rule':
                lines.push((node.char ?? '-').repeat(doc.width));
                return;
            case 'feed':
                for (let i = 0; i < node.n; i++) lines.push('');
                return;
            case 'qr':
                lines.push(padTo(`[QR ${truncate(node.data, doc.width - 5)}]`, doc.width, 'center'));
                return;
            case 'barcode':
                lines.push(padTo(`[${node.symbology} ${node.data}]`, doc.width, 'center'));
                return;
            case 'image':
                lines.push(padTo(`[image${node.key ? ' ' + node.key : ''}]`, doc.width, 'center'));
                return;
            case 'cut':
            case 'pulse':
                return;
        }
    };

    for (const node of doc.nodes) visit(node, {});
    return lines.join('\n');
}

/** Which text nodes cannot be printed with the printer's font and must be rasterised instead. */
export function findUnprintableNodes(doc: EscPosDoc): Array<Extract<EscPosNode, { t: 'text' }>> {
    const out: Array<Extract<EscPosNode, { t: 'text' }>> = [];
    const visit = (node: EscPosNode): void => {
        if (node.t === 'group') {
            node.children.forEach(visit);
            return;
        }
        if (node.t === 'text' && !canEncode(node.v, doc.codepage)) out.push(node);
    };
    doc.nodes.forEach(visit);
    return out;
}
