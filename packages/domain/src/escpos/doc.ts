/**
 * The receipt document IR (docs/spec/03-architecture.md §7.1).
 *
 * We deliberately do NOT render receipts as HTML → canvas → raster (Odoo's approach: 200–600 ms
 * per print, 30–80 kB on the wire, fuzzy text at 203 dpi). Instead the client produces this small,
 * structured-cloneable IR and renderers turn it into whatever the target needs:
 *
 *   toEscPos(doc, profile)  → Uint8Array      native printer fonts, ~2 kB, instant   (escpos/serializer)
 *   toDescriptor(doc)       → ReceiptDescriptor  on-screen preview / window.print()  (receipt/descriptor)
 *
 * Because it is plain data it crosses a worker boundary, an IndexedDB round-trip and a
 * BroadcastChannel unchanged, and a receipt regression test is a snapshot of the IR.
 */

export type Align = 'left' | 'center' | 'right';

/** Maps onto ESC/POS `GS !` width/height multipliers. */
export type TextSize = 'sm' | 'md' | 'lg' | 'xl';

export type TextStyle = {
    bold?: boolean;
    underline?: boolean;
    align?: Align;
    size?: TextSize;
    invert?: boolean;
};

export type BarcodeSymbology = 'ean13' | 'ean8' | 'upca' | 'code39' | 'itf' | 'code93' | 'code128';

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

/** A 1-bit raster, already dithered, row-major, MSB-first, `width` padded to a byte boundary. */
export type RasterImage = {
    width: number;
    height: number;
    /** Length must be `ceil(width / 8) * height`. */
    data: Uint8Array;
};

export type EscPosNode =
    | { t: 'text'; v: string; style?: TextStyle }
    /** Dot-leader aligned "label ......... value" pair. */
    | { t: 'row'; left: string; right: string; style?: TextStyle; fill?: string }
    | { t: 'cols'; cells: Array<{ v: string; w: number; align?: Align }>; style?: TextStyle }
    | { t: 'rule'; char?: string }
    | { t: 'feed'; n: number }
    /** Resolved from the client blob store by key, or carried inline as a dithered raster. */
    | { t: 'image'; key?: string; raster?: RasterImage; align?: Align }
    | { t: 'qr'; data: string; size?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8; ec?: QrErrorCorrection; align?: Align }
    | {
          t: 'barcode';
          data: string;
          symbology: BarcodeSymbology;
          height?: number;
          hri?: 'none' | 'above' | 'below' | 'both';
          align?: Align;
      }
    | { t: 'cut'; mode?: 'full' | 'partial' }
    /** Cash-drawer kick on the printer's RJ-11 port (spec §7.4). */
    | { t: 'pulse'; pin?: 0 | 1; on?: number; off?: number }
    | { t: 'group'; children: EscPosNode[]; style?: TextStyle };

export type ReceiptWidth = 32 | 42 | 48;

export type Codepage = 'cp437' | 'cp850' | 'cp858' | 'cp1252' | 'utf8';

export type DocKind = 'receipt' | 'bill' | 'prep' | 'cash_move' | 'report' | 'test' | 'drawer';

export type EscPosDoc = {
    /** Characters per line at font A. */
    width: ReceiptWidth;
    codepage: Codepage;
    nodes: EscPosNode[];
    meta: {
        orderUuid: string | null;
        kind: DocKind;
        copy: number;
        title?: string;
    };
};

/** Multiplier pair applied by `GS !`. */
export const SIZE_MULTIPLIERS: Record<TextSize, { w: number; h: number }> = {
    sm: { w: 1, h: 1 },
    md: { w: 1, h: 1 },
    lg: { w: 2, h: 2 },
    xl: { w: 3, h: 3 },
};

/** How many characters a run of this size occupies on a `width`-column line. */
export function columnsFor(width: ReceiptWidth, size: TextSize | undefined): number {
    const mult = SIZE_MULTIPLIERS[size ?? 'md'].w;
    return Math.max(1, Math.floor(width / mult));
}

/** Depth-first walk over the tree, parents before children. */
export function walkNodes(nodes: readonly EscPosNode[], visit: (node: EscPosNode) => void): void {
    for (const node of nodes) {
        visit(node);
        if (node.t === 'group') walkNodes(node.children, visit);
    }
}

/** Merge a parent group style with a child's own style; the child wins field by field. */
export function mergeStyle(parent: TextStyle | undefined, child: TextStyle | undefined): TextStyle {
    if (!parent) return child ?? {};
    if (!child) return parent;
    return { ...parent, ...child };
}
