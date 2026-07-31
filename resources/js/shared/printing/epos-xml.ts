import {
    columnsFor,
    layoutCols,
    layoutRow,
    mergeStyle,
    wrap,
    type EscPosDoc,
    type EscPosNode,
    type TextStyle,
} from '@domain/escpos/index';

/**
 * ePOS-Print XML renderer (spec 03 §7.1, "toEposXml").
 *
 * Epson's TM-i / TM-intelligent printers speak this over plain HTTP(S) with no driver and no
 * pairing, from any device on the LAN, and they answer with a status block. That combination is why
 * they are the recommended hardware for new installs.
 */

const ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
};

export function escapeXml(value: string): string {
    return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

const ALIGN_MAP = { left: 'left', center: 'center', right: 'right' } as const;

function sizeAttrs(style: TextStyle): string {
    const size = style.size ?? 'md';
    const multiplier = size === 'xl' ? 3 : size === 'lg' ? 2 : 1;
    return ` width="${multiplier}" height="${multiplier}"`;
}

function textOpen(style: TextStyle): string {
    return [
        `<text align="${ALIGN_MAP[style.align ?? 'left']}"`,
        ` em="${style.bold ? 'true' : 'false'}"`,
        ` ul="${style.underline ? 'true' : 'false'}"`,
        ` reverse="${style.invert ? 'true' : 'false'}"`,
        sizeAttrs(style),
        '>',
    ].join('');
}

function emitLine(out: string[], text: string, style: TextStyle): void {
    out.push(`${textOpen(style)}${escapeXml(text)}&#10;</text>`);
}

function emit(out: string[], node: EscPosNode, doc: EscPosDoc, inherited: TextStyle): void {
    switch (node.t) {
        case 'group': {
            const style = mergeStyle(inherited, node.style);
            for (const child of node.children) emit(out, child, doc, style);
            return;
        }
        case 'text': {
            const style = mergeStyle(inherited, node.style);
            for (const line of wrap(node.v, columnsFor(doc.width, style.size))) emitLine(out, line, style);
            return;
        }
        case 'row': {
            const style = mergeStyle(inherited, node.style);
            emitLine(
                out,
                layoutRow(node.left, node.right, columnsFor(doc.width, style.size), node.fill ?? ' '),
                { ...style, align: 'left' },
            );
            return;
        }
        case 'cols': {
            const style = mergeStyle(inherited, node.style);
            emitLine(out, layoutCols(node.cells, columnsFor(doc.width, style.size)), { ...style, align: 'left' });
            return;
        }
        case 'rule':
            emitLine(out, (node.char ?? '-').repeat(doc.width), { align: 'left' });
            return;
        case 'feed':
            out.push(`<feed line="${Math.max(0, node.n)}"/>`);
            return;
        case 'qr':
            out.push(
                `<symbol type="qrcode_model2" level="level_${(node.ec ?? 'M').toLowerCase()}" width="${node.size ?? 5}" height="${node.size ?? 5}" align="${ALIGN_MAP[node.align ?? 'center']}">${escapeXml(node.data)}</symbol>`,
            );
            return;
        case 'barcode':
            out.push(
                `<barcode type="${node.symbology}" hri="${node.hri ?? 'below'}" height="${node.height ?? 64}" width="2" align="${ALIGN_MAP[node.align ?? 'center']}">${escapeXml(node.data)}</barcode>`,
            );
            return;
        case 'image':
            // ePOS wants base64 raster data; the caller resolves blobs to rasters before printing.
            if (node.raster) {
                out.push(
                    `<image width="${node.raster.width}" height="${node.raster.height}" color="color_1" mode="mono" align="${ALIGN_MAP[node.align ?? 'center']}">${base64(node.raster.data)}</image>`,
                );
            }
            return;
        case 'pulse':
            out.push(`<pulse drawer="drawer_${(node.pin ?? 0) + 1}" time="pulse_100"/>`);
            return;
        case 'cut':
            out.push(`<cut type="${node.mode === 'full' ? 'feed' : 'feed'}"/>`);
            return;
    }
}

function base64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (typeof globalThis.btoa === 'function') return globalThis.btoa(binary);
    return binary;
}

/** Wrap the document in the SOAP envelope the ePOS service endpoint expects. */
export function toEposXml(doc: EscPosDoc): string {
    const body: string[] = [];
    for (const node of doc.nodes) emit(body, node, doc, {});

    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">',
        '<s:Body>',
        '<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">',
        body.join(''),
        '</epos-print>',
        '</s:Body>',
        '</s:Envelope>',
    ].join('');
}

export type EposResponse = {
    success: boolean;
    code: string;
    status: number;
};

/** Parse the ePOS response block without pulling in a DOM parser dependency. */
export function parseEposResponse(xml: string): EposResponse {
    const success = /success="true"/i.test(xml);
    const code = /code="([^"]*)"/i.exec(xml)?.[1] ?? '';
    const status = Number.parseInt(/status="(\d+)"/i.exec(xml)?.[1] ?? '0', 10);
    return { success, code, status };
}

/** ASB status bits from the ePOS `status` attribute. */
export const ASB = {
    NO_RESPONSE: 0x00000001,
    PRINT_SUCCESS: 0x00000002,
    DRAWER_KICK: 0x00000004,
    OFF_LINE: 0x00000008,
    COVER_OPEN: 0x00000020,
    PAPER_FEED: 0x00000040,
    WAIT_ON_LINE: 0x00000100,
    PANEL_SWITCH: 0x00000200,
    MECHANICAL_ERR: 0x00000400,
    AUTOCUTTER_ERR: 0x00000800,
    UNRECOVER_ERR: 0x00002000,
    AUTORECOVER_ERR: 0x00004000,
    RECEIPT_NEAR_END: 0x00020000,
    RECEIPT_END: 0x00080000,
} as const;
