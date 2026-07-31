import type {
    Align,
    BarcodeSymbology,
    Codepage,
    DocKind,
    EscPosDoc,
    EscPosNode,
    QrErrorCorrection,
    RasterImage,
    ReceiptWidth,
    TextStyle,
} from './doc';

/**
 * Fluent builder for the receipt IR.
 *
 * Exists so receipt templates read like the receipt they print, and so every node is constructed
 * through one place (making a future IR version bump a single-file change).
 *
 *   const doc = new EscPosBuilder({ width: 42, kind: 'receipt', orderUuid })
 *       .title('LE COMPTOIR')
 *       .rule()
 *       .row('2 x Espresso', '5.00')
 *       .total('TOTAL', '5.00')
 *       .qr('https://…/r/K7F2Q')
 *       .cut()
 *       .build();
 */
export class EscPosBuilder {
    private readonly nodes: EscPosNode[] = [];
    private readonly width: ReceiptWidth;
    private readonly codepage: Codepage;
    private readonly meta: EscPosDoc['meta'];

    constructor(options: {
        width?: ReceiptWidth;
        codepage?: Codepage;
        kind: DocKind;
        orderUuid?: string | null;
        copy?: number;
        title?: string;
    }) {
        this.width = options.width ?? 42;
        this.codepage = options.codepage ?? 'cp858';
        this.meta = {
            orderUuid: options.orderUuid ?? null,
            kind: options.kind,
            copy: options.copy ?? 1,
            ...(options.title !== undefined ? { title: options.title } : {}),
        };
    }

    node(node: EscPosNode): this {
        this.nodes.push(node);
        return this;
    }

    text(value: string, style?: TextStyle): this {
        return this.node(style ? { t: 'text', v: value, style } : { t: 'text', v: value });
    }

    /** Centred, bold, double-height — the venue name at the top of a receipt. */
    title(value: string): this {
        return this.text(value, { align: 'center', bold: true, size: 'lg' });
    }

    subtitle(value: string): this {
        return this.text(value, { align: 'center' });
    }

    row(left: string, right: string, style?: TextStyle, fill?: string): this {
        return this.node({
            t: 'row',
            left,
            right,
            ...(style ? { style } : {}),
            ...(fill ? { fill } : {}),
        });
    }

    /** The grand total: double size, dot leader, impossible to misread across a counter. */
    total(label: string, amount: string): this {
        return this.row(label, amount, { bold: true, size: 'lg' });
    }

    cols(cells: Array<{ v: string; w: number; align?: Align }>, style?: TextStyle): this {
        return this.node({ t: 'cols', cells, ...(style ? { style } : {}) });
    }

    rule(char = '-'): this {
        return this.node({ t: 'rule', char });
    }

    feed(n = 1): this {
        return this.node({ t: 'feed', n });
    }

    image(source: { key?: string; raster?: RasterImage; align?: Align }): this {
        return this.node({ t: 'image', ...source });
    }

    qr(data: string, options?: { size?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8; ec?: QrErrorCorrection; align?: Align }): this {
        return this.node({ t: 'qr', data, ...(options ?? {}) });
    }

    barcode(
        data: string,
        symbology: BarcodeSymbology = 'code128',
        options?: { height?: number; hri?: 'none' | 'above' | 'below' | 'both'; align?: Align },
    ): this {
        return this.node({ t: 'barcode', data, symbology, ...(options ?? {}) });
    }

    /** Cash-drawer kick. Emitted inside a receipt it opens as the receipt prints. */
    pulse(pin: 0 | 1 = 0, on = 25, off = 250): this {
        return this.node({ t: 'pulse', pin, on, off });
    }

    cut(mode: 'full' | 'partial' = 'partial'): this {
        return this.node({ t: 'cut', mode });
    }

    group(style: TextStyle, build: (b: EscPosBuilder) => void): this {
        const inner = new EscPosBuilder({ width: this.width, codepage: this.codepage, kind: this.meta.kind });
        build(inner);
        return this.node({ t: 'group', style, children: inner.build().nodes });
    }

    /** Append raw nodes produced elsewhere (e.g. a per-venue promo block). */
    concat(nodes: readonly EscPosNode[]): this {
        for (const n of nodes) this.nodes.push(n);
        return this;
    }

    /** Only emit the block when `condition` holds — keeps templates free of `&&` noise. */
    when(condition: boolean, build: (b: this) => void): this {
        if (condition) build(this);
        return this;
    }

    build(): EscPosDoc {
        return { width: this.width, codepage: this.codepage, nodes: this.nodes, meta: this.meta };
    }
}

/** Standalone one-node document: open the drawer without a sale (spec 03 §7.4). */
export function drawerKickDoc(pin: 0 | 1 = 0): EscPosDoc {
    return new EscPosBuilder({ kind: 'drawer' }).pulse(pin).build();
}
