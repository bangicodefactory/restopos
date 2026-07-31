import { describe, expect, it } from 'vitest';

import { EscPosBuilder, drawerKickDoc } from '../src/escpos/builder';
import { canEncode, encodeText, highTableLength } from '../src/escpos/codepage';
import type { EscPosDoc, RasterImage } from '../src/escpos/doc';
import { PRINTER_PROFILES, resolveProfile } from '../src/escpos/profiles';
import {
    ESC,
    GS,
    layoutCols,
    layoutRow,
    padTo,
    toEscPos,
    toPlainText,
    truncate,
    wrap,
} from '../src/escpos/serializer';
import { toDescriptor, descriptorToText } from '../src/receipt/descriptor';

/** Unit coverage for docs/spec/03-architecture.md §7.1 and §7.2. */

const profile = PRINTER_PROFILES['epson-tm-t88'];

function bytesOf(doc: EscPosDoc): number[] {
    return Array.from(toEscPos(doc, profile));
}

/** Find a command sequence inside the output. */
function contains(haystack: number[], needle: number[]): boolean {
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return true;
    }
    return false;
}

describe('codepage tables', () => {
    it('declares exactly 128 high-half slots per table', () => {
        for (const cp of ['cp437', 'cp850', 'cp858', 'cp1252'] as const) {
            expect(highTableLength(cp)).toBe(128);
        }
    });

    it('encodes ASCII as identity', () => {
        expect(Array.from(encodeText('ABC 12.30', 'cp437'))).toEqual([
            65, 66, 67, 32, 49, 50, 46, 51, 48,
        ]);
    });

    it('encodes accented Latin from the cp858 table', () => {
        // é is 0x82 in CP437/CP850/CP858.
        expect(Array.from(encodeText('é', 'cp858'))).toEqual([0x82]);
        expect(Array.from(encodeText('ü', 'cp858'))).toEqual([0x81]);
    });

    it('places the euro sign only in cp858, not cp850', () => {
        expect(Array.from(encodeText('€', 'cp858'))).toEqual([0xd5]);
        expect(canEncode('€', 'cp850')).toBe(false);
    });

    it('strips diacritics before falling back to "?"', () => {
        // ẞ-with-caron style characters are absent from cp437: the NFD fallback yields the base letter.
        expect(Array.from(encodeText('ř', 'cp437'))).toEqual([114]); // 'r'
        expect(Array.from(encodeText('中', 'cp437'))).toEqual([63]); // '?'
    });

    it('reports scripts the printer font cannot express', () => {
        expect(canEncode('مرحبا', 'cp858')).toBe(false);
        expect(canEncode('Bonjour', 'cp858')).toBe(true);
        expect(canEncode('مرحبا', 'utf8')).toBe(true);
    });
});

describe('text layout', () => {
    it('pads and truncates to an exact column count', () => {
        expect(padTo('abc', 6)).toBe('abc   ');
        expect(padTo('abc', 6, 'right')).toBe('   abc');
        expect(padTo('abc', 7, 'center')).toBe('  abc  ');
        expect(truncate('abcdef', 3)).toBe('abc');
    });

    it('lays out a label/amount row with the amount hard right', () => {
        const row = layoutRow('2 x Espresso', '5.00', 24);
        expect(row).toHaveLength(24);
        expect(row.endsWith('5.00')).toBe(true);
        expect(row.startsWith('2 x Espresso')).toBe(true);
    });

    it('keeps the amount when the label is too long', () => {
        const row = layoutRow('A very long product name indeed', '123.45', 20);
        expect(row).toHaveLength(20);
        expect(row.endsWith('123.45')).toBe(true);
    });

    it('supports a dot leader', () => {
        expect(layoutRow('A', 'B', 6, '.')).toBe('A....B');
    });

    it('fills the line exactly with columns', () => {
        const line = layoutCols(
            [
                { v: 'Qty', w: 6 },
                { v: 'Item', w: 24 },
                { v: '1.00', w: 12, align: 'right' },
            ],
            42,
        );
        expect(line).toHaveLength(42);
        expect(line.trimEnd().endsWith('1.00')).toBe(true);
    });

    it('wraps on word boundaries and hard-breaks unbreakable runs', () => {
        expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
        expect(wrap('aaaaaaaaaaaa', 5)).toEqual(['aaaaa', 'aaaaa', 'aa']);
        expect(wrap('a\nb', 10)).toEqual(['a', 'b']);
    });
});

describe('toEscPos', () => {
    it('initialises the printer and selects the codepage', () => {
        const doc = new EscPosBuilder({ kind: 'receipt', codepage: 'cp858' }).text('hi').build();
        const bytes = bytesOf(doc);
        expect(bytes.slice(0, 2)).toEqual([ESC, 0x40]);
        expect(contains(bytes, [ESC, 0x74, 19])).toBe(true); // ESC t 19 = cp858 on Epson
    });

    it('emits alignment, bold and size changes only when they change', () => {
        const doc = new EscPosBuilder({ kind: 'receipt' })
            .text('a', { bold: true })
            .text('b', { bold: true })
            .text('c')
            .build();
        const bytes = bytesOf(doc);
        const boldOn = bytes.filter((_, i) => bytes[i] === ESC && bytes[i + 1] === 0x45 && bytes[i + 2] === 1);
        expect(boldOn).toHaveLength(1);
    });

    it('maps text size onto GS ! multipliers', () => {
        const doc = new EscPosBuilder({ kind: 'receipt' }).text('BIG', { size: 'lg' }).build();
        // lg = 2x2 → ((2-1)<<4) | (2-1) = 0x11
        expect(contains(bytesOf(doc), [GS, 0x21, 0x11])).toBe(true);
    });

    it('emits a native QR command sequence', () => {
        const doc = new EscPosBuilder({ kind: 'receipt' }).qr('https://x.test/r/K7F2Q', { ec: 'M' }).build();
        const bytes = bytesOf(doc);
        expect(contains(bytes, [GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00])).toBe(true); // model 2
        expect(contains(bytes, [GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 49])).toBe(true); // EC = M
        expect(contains(bytes, [GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30])).toBe(true); // print
    });

    it('falls back to text when the profile has no native QR', () => {
        const doc = new EscPosBuilder({ kind: 'receipt' }).qr('ABC').build();
        const bytes = Array.from(toEscPos(doc, PRINTER_PROFILES.generic));
        expect(contains(bytes, [GS, 0x28, 0x6b])).toBe(false);
        expect(contains(bytes, [65, 66, 67])).toBe(true);
    });

    it('emits an EAN-13 barcode with its length byte', () => {
        const doc = new EscPosBuilder({ kind: 'receipt' }).barcode('5901234123457', 'ean13').build();
        expect(contains(bytesOf(doc), [GS, 0x6b, 67, 13])).toBe(true);
    });

    it('prefixes CODE128 payloads with the code-set selector', () => {
        const doc = new EscPosBuilder({ kind: 'receipt' }).barcode('ABC', 'code128').build();
        const bytes = bytesOf(doc);
        expect(contains(bytes, [0x7b, 0x42, 65, 66, 67])).toBe(true); // "{B" + ABC
    });

    it('emits the drawer kick as ESC p', () => {
        expect(contains(bytesOf(drawerKickDoc(0)), [ESC, 0x70, 0, 25, 250])).toBe(true);
    });

    it('emits a partial cut with a paper feed first', () => {
        const doc = new EscPosBuilder({ kind: 'receipt' }).cut('partial').build();
        expect(contains(bytesOf(doc), [GS, 0x56, 0x42, 0x00])).toBe(true);
    });

    it('downgrades partial to full cut on a profile without it', () => {
        const doc = new EscPosBuilder({ kind: 'receipt' }).cut('partial').build();
        const bytes = Array.from(toEscPos(doc, PRINTER_PROFILES['star-tsp100']));
        expect(contains(bytes, [GS, 0x56, 0x41, 0x00])).toBe(true);
    });

    it('emits a GS v 0 raster for an image node', () => {
        const raster: RasterImage = { width: 16, height: 2, data: new Uint8Array([1, 2, 3, 4]) };
        const doc = new EscPosBuilder({ kind: 'receipt' }).image({ raster }).build();
        expect(contains(bytesOf(doc), [GS, 0x76, 0x30, 0x00, 2, 0, 2, 0])).toBe(true);
    });

    it('resets the printer state at the end so the next job starts clean', () => {
        const bytes = bytesOf(new EscPosBuilder({ kind: 'receipt' }).text('x', { bold: true }).build());
        expect(bytes.slice(-3)).toEqual([ESC, 0x61, 0x00]);
    });
});

describe('renderer parity', () => {
    const doc = new EscPosBuilder({ width: 32, kind: 'receipt', orderUuid: 'u1' })
        .title('CAFÉ')
        .rule()
        .row('2 x Espresso', '5.00')
        .total('TOTAL', '5.00')
        .cut()
        .build();

    it('produces the same character layout in the plain-text and descriptor renderers', () => {
        expect(descriptorToText(toDescriptor(doc))).toBe(
            toPlainText(doc)
                .split('\n')
                .map((l) => l.replace(/\s+$/, ''))
                .join('\n'),
        );
    });

    it('drops non-visual nodes from the on-screen descriptor', () => {
        const descriptor = toDescriptor(doc);
        expect(descriptor.elements.some((e) => e.kind === 'line' && e.text.includes('TOTAL'))).toBe(true);
        expect(descriptor.orderUuid).toBe('u1');
        expect(descriptor.width).toBe(32);
    });
});

describe('profiles', () => {
    it('falls back to the conservative generic profile for an unknown id', () => {
        expect(resolveProfile('nope').id).toBe('generic');
        expect(resolveProfile(null).nativeQr).toBe(false);
        expect(resolveProfile('star-tsp100').id).toBe('star-tsp100');
    });
});
