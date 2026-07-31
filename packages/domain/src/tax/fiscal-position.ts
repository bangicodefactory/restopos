import type { FiscalPosition } from './types';

/**
 * §5 — fiscal position tax mapping. Applied BEFORE any arithmetic.
 *
 * - unmapped source taxes pass through unchanged (§5.2);
 * - `taxDestId === null` drops the tax (exemption);
 * - one source may expand to several destinations;
 * - the result is de-duplicated preserving first occurrence (§5.3);
 * - the mapping is not transitive (§5.4).
 */
export function mapTaxes(
    taxIds: readonly number[],
    fiscalPosition?: FiscalPosition | null,
): number[] {
    if (!fiscalPosition || fiscalPosition.mappings.length === 0) {
        return [...taxIds];
    }
    const emitted: number[] = [];
    for (const srcId of taxIds) {
        const rows = fiscalPosition.mappings.filter((m) => m.taxSrcId === srcId);
        if (rows.length === 0) {
            emitted.push(srcId);
            continue;
        }
        for (const row of rows) {
            if (row.taxDestId !== null && row.taxDestId !== undefined) {
                emitted.push(row.taxDestId);
            }
        }
    }
    const seen = new Set<number>();
    const out: number[] = [];
    for (const id of emitted) {
        if (!seen.has(id)) {
            seen.add(id);
            out.push(id);
        }
    }
    return out;
}
