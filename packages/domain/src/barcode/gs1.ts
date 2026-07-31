/**
 * Minimal GS1-128 / GS1 DataMatrix parser.
 *
 * Only the Application Identifiers a restaurant POS actually meets are decoded; anything else is
 * returned raw so the caller can decide. Variable-length AIs terminate on the FNC1 separator,
 * which scanners emit as GS (0x1D) or, badly configured, as `]` or nothing at all — we accept the
 * first two and fall back to the AI's maximum length.
 */

export const FNC1 = '\u001d';

type AiSpec = { length: number | 'variable'; max?: number; decimals?: number; kind: AiKind };

export type AiKind =
    | 'gtin'
    | 'content'
    | 'batch'
    | 'production_date'
    | 'best_before'
    | 'expiry_date'
    | 'serial'
    | 'quantity'
    | 'net_weight_kg'
    | 'net_weight_lb'
    | 'price'
    | 'unknown';

const AI_TABLE: Record<string, AiSpec> = {
    '00': { length: 18, kind: 'unknown' },
    '01': { length: 14, kind: 'gtin' },
    '02': { length: 14, kind: 'content' },
    '10': { length: 'variable', max: 20, kind: 'batch' },
    '11': { length: 6, kind: 'production_date' },
    '15': { length: 6, kind: 'best_before' },
    '17': { length: 6, kind: 'expiry_date' },
    '21': { length: 'variable', max: 20, kind: 'serial' },
    '30': { length: 'variable', max: 8, kind: 'quantity' },
    '37': { length: 'variable', max: 8, kind: 'quantity' },
};

/** AIs whose 4th digit is the number of implied decimals: 310n weight kg, 320n lb, 392n price. */
const DECIMAL_AI_PREFIXES: Record<string, { kind: AiKind; length: number }> = {
    '310': { kind: 'net_weight_kg', length: 6 },
    '320': { kind: 'net_weight_lb', length: 6 },
    '392': { kind: 'price', length: 15 },
    '393': { kind: 'price', length: 18 },
};

export type Gs1Element = {
    ai: string;
    kind: AiKind;
    /** The raw digits/characters of the element, separator excluded. */
    raw: string;
    /** Numeric interpretation when the AI is numeric, otherwise `null`. */
    value: number | null;
};

export type Gs1Parse = {
    ok: boolean;
    elements: Gs1Element[];
    /** Convenience accessors for the hot paths. */
    gtin: string | null;
    quantity: number | null;
    weightKg: number | null;
    price: number | null;
    lot: string | null;
    expiry: string | null;
};

function specFor(ai: string): { spec: AiSpec; aiLength: number } | null {
    const two = ai.slice(0, 2);
    if (two in AI_TABLE) return { spec: AI_TABLE[two] as AiSpec, aiLength: 2 };

    const three = ai.slice(0, 3);
    const decimal = DECIMAL_AI_PREFIXES[three];
    if (decimal) {
        const decimals = Number(ai[3] ?? '0');
        return {
            spec: { length: decimal.length, kind: decimal.kind, decimals: Number.isNaN(decimals) ? 0 : decimals },
            aiLength: 4,
        };
    }
    return null;
}

/** `(01)05901234123457(3103)001500` → elements + the flattened convenience fields. */
export function parseGs1(input: string): Gs1Parse {
    // Both wire forms occur in the wild: FNC1-separated, and the human-readable
    // parenthesised form printed under the bars. Normalise the latter into the former.
    let data = input.replace(/^\]C1/, '');
    if (data.includes('(')) {
        data = data
            .replace(/\)/g, '')
            .replace(/\(/g, FNC1)
            .replace(new RegExp('^' + FNC1), '');
    }

    const elements: Gs1Element[] = [];
    let i = 0;
    let ok = true;

    while (i < data.length) {
        if (data[i] === FNC1) {
            i++;
            continue;
        }
        const resolved = specFor(data.slice(i, i + 4));
        if (!resolved) {
            ok = false;
            break;
        }
        const ai = data.slice(i, i + resolved.aiLength);
        i += resolved.aiLength;

        let raw: string;
        if (resolved.spec.length === 'variable') {
            const end = data.indexOf(FNC1, i);
            const stop = end === -1 ? Math.min(data.length, i + (resolved.spec.max ?? 20)) : end;
            raw = data.slice(i, stop);
            i = stop;
        } else {
            raw = data.slice(i, i + resolved.spec.length);
            i += resolved.spec.length;
        }

        if (raw.length === 0) {
            ok = false;
            break;
        }

        const numeric = /^\d+$/.test(raw);
        const decimals = resolved.spec.decimals ?? 0;
        elements.push({
            ai,
            kind: resolved.spec.kind,
            raw,
            value: numeric ? Number(raw) / 10 ** decimals : null,
        });
    }

    const find = (kind: AiKind): Gs1Element | undefined => elements.find((e) => e.kind === kind);

    return {
        ok: ok && elements.length > 0,
        elements,
        gtin: find('gtin')?.raw ?? null,
        quantity: find('quantity')?.value ?? null,
        weightKg: find('net_weight_kg')?.value ?? null,
        price: find('price')?.value ?? null,
        lot: find('batch')?.raw ?? null,
        expiry: find('expiry_date')?.raw ?? find('best_before')?.raw ?? null,
    };
}

/** Cheap pre-check so we do not run the full parser on every keyboard-wedge scan. */
export function looksLikeGs1(input: string): boolean {
    return input.startsWith(']C1') || input.includes(FNC1) || /^\(\d{2,4}\)/.test(input);
}
