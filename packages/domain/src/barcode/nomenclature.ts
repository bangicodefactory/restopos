import type { BarcodeNomenclatureRow, BarcodeRuleRow } from '../types';
import { eanToUpc, isValidEan8, isValidGtin, stripGtinPadding, upcToEan, withCheckDigit } from './checksum';
import { looksLikeGs1, parseGs1 } from './gs1';
import { matchPattern } from './pattern';

/**
 * Barcode nomenclature resolution (spec 01 §2.B `barcode_rules`, spec 03 §7.5).
 *
 * This is the offline decoder for everything a scanner can throw at a till:
 *
 *   - a plain product EAN-13 / EAN-8 / UPC-A;
 *   - a **weight-embedded** shelf label (`21` prefix, weight in the last digits);
 *   - a **price-embedded** label (`22`/`23` prefix depending on the venue);
 *   - a **discount** label;
 *   - a **customer** loyalty card, an **employee** badge, a **coupon**, a **lot**, a **package**;
 *   - an **alias** rule that rewrites one code into another before lookup;
 *   - GS1-128 composite codes.
 *
 * Two nomenclatures are supported (primary + fallback), exactly as Odoo does, because venues
 * routinely have one scale supplier and one legacy label printer that disagree.
 */

export type BarcodeKind =
    | 'product'
    | 'weight'
    | 'price'
    | 'discount'
    | 'customer'
    | 'cashier'
    | 'coupon'
    | 'lot'
    | 'package'
    | 'alias'
    | 'gs1'
    | 'error';

export type ParsedBarcode = {
    kind: BarcodeKind;
    /** What to look the record up by. For weight/price rules this is the *base* code. */
    code: string;
    /** The scanned string, untouched. */
    raw: string;
    /** Embedded value: kg for `weight`, currency units for `price`, percent for `discount`. */
    value: number;
    ruleId: number | null;
    /** Populated when the code was a GS1-128 composite. */
    gs1: ReturnType<typeof parseGs1> | null;
    /** Alternative codes worth retrying against the catalog, in order of preference. */
    candidates: string[];
};

export type Nomenclature = {
    nomenclature: BarcodeNomenclatureRow;
    /** Sorted by `sequence` ascending; the first match wins. */
    rules: BarcodeRuleRow[];
};

function sortRules(rules: readonly BarcodeRuleRow[]): BarcodeRuleRow[] {
    return [...rules].sort((a, b) => a.sequence - b.sequence || a.id - b.id);
}

/** Build a ready-to-use nomenclature from raw bootstrap rows. */
export function buildNomenclature(
    nomenclature: BarcodeNomenclatureRow,
    rules: readonly BarcodeRuleRow[],
): Nomenclature {
    return {
        nomenclature,
        rules: sortRules(rules.filter((r) => r.barcode_nomenclature_id === nomenclature.id)),
    };
}

/** Encoding gate: a rule declared for EAN-13 must not fire on a 8-digit code. */
function encodingMatches(code: string, rule: BarcodeRuleRow): boolean {
    switch (rule.encoding) {
        case 'ean13':
            return code.length === 13 && /^\d+$/.test(code);
        case 'ean8':
            return code.length === 8 && /^\d+$/.test(code);
        case 'upca':
            return code.length === 12 && /^\d+$/.test(code);
        case 'gs1_128':
            return looksLikeGs1(code);
        case 'any':
        default:
            return true;
    }
}

/**
 * Apply the nomenclature's UPC/EAN conversion policy, returning every code worth trying.
 * Order matters: the first candidate is what we report as `code`.
 */
export function conversionCandidates(code: string, nomenclature: BarcodeNomenclatureRow): string[] {
    const out = [code];
    const numeric = /^\d+$/.test(code);
    if (!numeric) return out;

    const conv = nomenclature.upc_ean_conv;
    if ((conv === 'upc2ean' || conv === 'always') && code.length === 12) out.push(upcToEan(code));
    if ((conv === 'ean2upc' || conv === 'always') && code.length === 13) out.push(eanToUpc(code));

    // Odoo's padded-GTIN fallback: some scanners left-pad short internal codes with zeros.
    const stripped = stripGtinPadding(code);
    if (stripped !== code) out.push(stripped);
    if (code.length < 13) out.push(code.padStart(13, '0'));

    return [...new Set(out)];
}

const KIND_BY_RULE: Record<BarcodeRuleRow['rule_type'], BarcodeKind> = {
    product: 'product',
    weight: 'weight',
    price: 'price',
    discount: 'discount',
    customer: 'customer',
    cashier: 'cashier',
    coupon: 'coupon',
    lot: 'lot',
    package: 'package',
    alias: 'alias',
};

function checksumOk(code: string): boolean {
    if (!/^\d+$/.test(code)) return true;
    if (code.length === 13) return isValidGtin(code, 13);
    if (code.length === 12) return isValidGtin(code, 12);
    if (code.length === 8) return isValidEan8(code);
    return true;
}

/**
 * Decode a scan against one nomenclature.
 *
 * Returns `kind: 'error'` when no rule matches — the caller then tries the fallback nomenclature
 * and, failing that, treats the string as a raw product barcode lookup.
 */
export function parseBarcode(raw: string, nomenclature: Nomenclature): ParsedBarcode {
    const trimmed = raw.trim();

    const base: ParsedBarcode = {
        kind: 'error',
        code: trimmed,
        raw,
        value: 0,
        ruleId: null,
        gs1: null,
        candidates: conversionCandidates(trimmed, nomenclature.nomenclature),
    };

    if (trimmed === '') return base;

    if (nomenclature.nomenclature.is_gs1 || looksLikeGs1(trimmed)) {
        const gs1 = parseGs1(trimmed);
        if (gs1.ok && gs1.gtin) {
            // A GTIN-14 with a leading zero is an EAN-13 in disguise; offer both.
            const ean13 = gs1.gtin.startsWith('0') ? gs1.gtin.slice(1) : gs1.gtin;
            return {
                kind: 'gs1',
                code: ean13,
                raw,
                value: gs1.weightKg ?? gs1.quantity ?? gs1.price ?? 0,
                ruleId: null,
                gs1,
                candidates: [...new Set([ean13, gs1.gtin, ...conversionCandidates(ean13, nomenclature.nomenclature)])],
            };
        }
    }

    for (const candidate of base.candidates) {
        for (const rule of nomenclature.rules) {
            if (!encodingMatches(candidate, rule)) continue;

            const match = matchPattern(candidate, rule.pattern, withCheckDigit);
            if (!match.matched) continue;

            if (rule.rule_type === 'alias') {
                const aliased = rule.alias ?? candidate;
                return {
                    kind: 'alias',
                    code: aliased,
                    raw,
                    value: 0,
                    ruleId: rule.id,
                    gs1: null,
                    candidates: conversionCandidates(aliased, nomenclature.nomenclature),
                };
            }

            const embedded = rule.rule_type === 'weight' || rule.rule_type === 'price' || rule.rule_type === 'discount';
            const code = embedded ? match.baseCode : candidate;

            return {
                kind: KIND_BY_RULE[rule.rule_type],
                code,
                raw,
                value: match.value,
                ruleId: rule.id,
                gs1: null,
                candidates: [...new Set([code, ...conversionCandidates(code, nomenclature.nomenclature)])],
            };
        }
    }

    // No rule matched. A well-formed GTIN is still a perfectly good product lookup.
    if (checksumOk(trimmed) && /^\d{8,14}$/.test(trimmed)) {
        return { ...base, kind: 'product' };
    }
    return base;
}

/** Try the primary nomenclature, then the fallback (Odoo's two-nomenclature behaviour). */
export function parseBarcodeWithFallback(
    raw: string,
    primary: Nomenclature,
    fallback?: Nomenclature | null,
): ParsedBarcode {
    const first = parseBarcode(raw, primary);
    if (first.kind !== 'error' || !fallback) return first;
    const second = parseBarcode(raw, fallback);
    return second.kind === 'error' ? first : second;
}
