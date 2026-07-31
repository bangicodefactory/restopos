import { columnsFor, mergeStyle, type Align, type EscPosDoc, type EscPosNode, type TextSize, type TextStyle } from '../escpos/doc';
import { layoutCols, layoutRow, padTo, truncate, wrap } from '../escpos/serializer';

/**
 * A React-renderable description of the very same document the printer receives.
 *
 * Framework-free by construction — this is plain data; `@shared/printing/receipt-view` turns it
 * into JSX. Because the line breaking, column layout and dot leaders are computed here with the
 * *same* helpers the ESC/POS serializer uses, the on-screen preview is character-exact with the
 * paper. That is what makes `window.print()` a usable fallback and what makes the emailed receipt
 * match the printed one.
 */

export type ReceiptElement =
    | {
          kind: 'line';
          text: string;
          align: Align;
          bold: boolean;
          underline: boolean;
          invert: boolean;
          size: TextSize;
      }
    | { kind: 'rule'; text: string }
    | { kind: 'space'; n: number }
    | { kind: 'qr'; data: string; size: number }
    | { kind: 'barcode'; data: string; symbology: string }
    | { kind: 'image'; key: string | null };

export type ReceiptDescriptor = {
    /** Characters per line — the preview uses a monospace font at this column count. */
    width: number;
    kind: EscPosDoc['meta']['kind'];
    copy: number;
    orderUuid: string | null;
    title: string | null;
    elements: ReceiptElement[];
};

function textElement(text: string, style: TextStyle): Extract<ReceiptElement, { kind: 'line' }> {
    return {
        kind: 'line',
        text,
        align: style.align ?? 'left',
        bold: style.bold === true,
        underline: style.underline === true,
        invert: style.invert === true,
        size: style.size ?? 'md',
    };
}

export function toDescriptor(doc: EscPosDoc): ReceiptDescriptor {
    const elements: ReceiptElement[] = [];

    const visit = (node: EscPosNode, inherited: TextStyle): void => {
        switch (node.t) {
            case 'group': {
                const style = mergeStyle(inherited, node.style);
                for (const child of node.children) visit(child, style);
                return;
            }
            case 'text': {
                const style = mergeStyle(inherited, node.style);
                const cols = columnsFor(doc.width, style.size);
                for (const line of wrap(node.v, cols)) elements.push(textElement(line, style));
                return;
            }
            case 'row': {
                const style = mergeStyle(inherited, node.style);
                const cols = columnsFor(doc.width, style.size);
                elements.push(
                    textElement(layoutRow(node.left, node.right, cols, node.fill ?? ' '), {
                        ...style,
                        align: 'left',
                    }),
                );
                return;
            }
            case 'cols': {
                const style = mergeStyle(inherited, node.style);
                elements.push(
                    textElement(layoutCols(node.cells, columnsFor(doc.width, style.size)), {
                        ...style,
                        align: 'left',
                    }),
                );
                return;
            }
            case 'rule':
                elements.push({ kind: 'rule', text: (node.char ?? '-').repeat(doc.width) });
                return;
            case 'feed':
                elements.push({ kind: 'space', n: Math.max(0, node.n) });
                return;
            case 'qr':
                elements.push({ kind: 'qr', data: node.data, size: node.size ?? 5 });
                return;
            case 'barcode':
                elements.push({ kind: 'barcode', data: node.data, symbology: node.symbology });
                return;
            case 'image':
                elements.push({ kind: 'image', key: node.key ?? null });
                return;
            case 'cut':
            case 'pulse':
                // Not renderable on screen: a cut is where the paper ends, a pulse is a drawer.
                return;
        }
    };

    for (const node of doc.nodes) visit(node, {});

    return {
        width: doc.width,
        kind: doc.meta.kind,
        copy: doc.meta.copy,
        orderUuid: doc.meta.orderUuid,
        title: doc.meta.title ?? null,
        elements,
    };
}

/** Monospace text block — handy for a `<pre>` preview, a test snapshot or a plain-text email. */
export function descriptorToText(descriptor: ReceiptDescriptor): string {
    const out: string[] = [];
    for (const element of descriptor.elements) {
        switch (element.kind) {
            case 'line': {
                // Size-scaled runs occupy fewer columns: a `lg` line is 21 columns on 42-column paper.
                const cols = columnsFor(descriptor.width as 32 | 42 | 48, element.size);
                out.push(padTo(truncate(element.text, cols), cols, element.align));
                break;
            }
            case 'rule':
                out.push(element.text);
                break;
            case 'space':
                for (let i = 0; i < element.n; i++) out.push('');
                break;
            case 'qr':
                out.push(padTo('[QR]', descriptor.width, 'center'));
                break;
            case 'barcode':
                out.push(padTo(`[${element.symbology}]`, descriptor.width, 'center'));
                break;
            case 'image':
                out.push(padTo('[logo]', descriptor.width, 'center'));
                break;
        }
    }
    return out.map((line) => line.replace(/\s+$/, '')).join('\n');
}
