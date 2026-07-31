import type { Codepage } from './doc';

/**
 * Single-byte codepage encoding for thermal printers.
 *
 * Each table below is the 0x80–0xFF half of the codepage, in order. ASCII (< 0x80) is identity in
 * every table we support. A character that is not in the selected table cannot be printed with the
 * printer's own font — `canEncode()` reports that, and the caller promotes that run of text to a
 * dithered raster image, node by node (spec 03 §7.1, "when we still rasterize").
 */

const CP437_HIGH =
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

const CP850_HIGH =
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ';

/** CP858 is CP850 with the dotless i at 0xD5 replaced by the euro sign. */
const CP858_HIGH = CP850_HIGH.slice(0, 0xd5 - 0x80) + '€' + CP850_HIGH.slice(0xd5 - 0x80 + 1);

const CP1252_HIGH =
    '€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž��‘’“”•–—˜™š›œ�žŸ ¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ';

const HIGH_TABLES: Record<Exclude<Codepage, 'utf8'>, string> = {
    cp437: CP437_HIGH,
    cp850: CP850_HIGH,
    cp858: CP858_HIGH,
    cp1252: CP1252_HIGH,
};

const reverseCache = new Map<string, Map<string, number>>();

function reverseTable(codepage: Exclude<Codepage, 'utf8'>): Map<string, number> {
    const cached = reverseCache.get(codepage);
    if (cached) return cached;

    const high = HIGH_TABLES[codepage];
    const map = new Map<string, number>();
    for (let i = 0; i < high.length; i++) {
        const ch = high[i];
        // U+FFFD marks an undefined slot; never encode to it.
        if (ch === undefined || ch === '�') continue;
        if (!map.has(ch)) map.set(ch, 0x80 + i);
    }
    reverseCache.set(codepage, map);
    return map;
}

/** Number of byte slots each table declares. Exposed for the table-integrity unit test. */
export function highTableLength(codepage: Exclude<Codepage, 'utf8'>): number {
    return HIGH_TABLES[codepage].length;
}

/** True when every character of `text` can be printed with the printer's own font. */
export function canEncode(text: string, codepage: Codepage): boolean {
    if (codepage === 'utf8') return true;
    const table = reverseTable(codepage);
    for (const ch of text) {
        const cp = ch.codePointAt(0) ?? 0;
        if (cp === 0x0a || cp === 0x0d) continue;
        if (cp < 0x80) continue;
        if (!table.has(ch)) return false;
    }
    return true;
}

const utf8Encoder = new TextEncoder();

/**
 * Encode text for the printer. Characters outside the codepage become `fallback` (default `?`)
 * rather than throwing: a receipt with one wrong glyph still prints, and `canEncode` exists so the
 * caller can rasterise instead when fidelity matters.
 */
export function encodeText(text: string, codepage: Codepage, fallback = '?'): Uint8Array {
    if (codepage === 'utf8') return utf8Encoder.encode(text);

    const table = reverseTable(codepage);
    const fallbackByte = fallback.charCodeAt(0);
    const out: number[] = [];

    for (const ch of text) {
        const cp = ch.codePointAt(0) ?? 0;
        if (cp < 0x80) {
            out.push(cp);
            continue;
        }
        const mapped = table.get(ch);
        if (mapped !== undefined) {
            out.push(mapped);
            continue;
        }
        // Try a diacritic-stripped equivalent before giving up (é → e beats é → ?).
        const stripped = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (stripped.length === 1 && stripped !== ch) {
            const cp2 = stripped.codePointAt(0) ?? 0;
            if (cp2 < 0x80) {
                out.push(cp2);
                continue;
            }
            const mapped2 = table.get(stripped);
            if (mapped2 !== undefined) {
                out.push(mapped2);
                continue;
            }
        }
        out.push(fallbackByte);
    }

    return Uint8Array.from(out);
}

/** Display width of a string in printer columns (combining marks take no column). */
export function displayWidth(text: string): number {
    let n = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0) ?? 0;
        if (cp >= 0x0300 && cp <= 0x036f) continue;
        n++;
    }
    return n;
}
