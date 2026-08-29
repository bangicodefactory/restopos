import type { PosDb } from '@shared/db';
import { ingestCatalogRows } from '@shared/db';
import type { ApiClient } from '@shared/sync';

import { getCatalog, nextCatalogVersion, setCatalog } from '../data/catalog';
import { insertCatalogProducts } from '../data/catalog-load';
import { lookupBarcode } from '../data/product-lookup';
import { routeScan, scanCandidates, type ScanAction } from './scanner';

/**
 * What to do when a scan matches nothing this device holds (REG-071, BAN-421).
 *
 * The register caches a capped slice of the catalogue, so "unknown barcode" has always had two very
 * different meanings that the till showed identically — it dropped the digits into the search box
 * and said nothing. A product that has simply not reached this device looked exactly like a product
 * that does not exist, and a scan made with no network looked like both.
 *
 * The three outcomes here are the three answers a cashier needs, and they are deliberately distinct:
 *
 *   - `resolved`  — the server had it; it is now cached and the scan means what it always meant;
 *   - `notFound`  — the server answered, and nothing carries this barcode. That is a real answer;
 *   - `offline`   — we did not ask. Not a statement about the catalogue, and must never be shown as
 *                   one: telling a cashier a product does not exist because the wifi dropped is how
 *                   a real sale gets refused.
 *
 * ## Why the scan is re-routed rather than added directly
 *
 * The obvious implementation adds a line for the variant the lookup returned. It is wrong for every
 * barcode that carries a payload: a weight-embedded label parses to a *base* code plus 1.5 kg, and
 * adding the returned variant would put one unit on the bill instead of one and a half kilos. So the
 * catalogue is updated and the **raw** scan is routed again, through the one parser, against the
 * index that now knows the product. Weight, embedded price and GS1 quantity survive because nothing
 * re-implements them.
 *
 * That is also why `raw` is threaded through rather than reusing `action.code` — for an embedded
 * label those are two different strings, and `action.code` is the one with the payload zeroed out.
 */

export type ScanMissOutcome =
    | { kind: 'resolved'; action: ScanAction }
    | { kind: 'notFound'; code: string }
    | { kind: 'offline'; code: string };

export type ScanMissDeps = {
    api: ApiClient;
    db: PosDb;
};

export async function resolveScanMiss(
    raw: string,
    action: Extract<ScanAction, { kind: 'unknown' }>,
    deps: ScanMissDeps,
): Promise<ScanMissOutcome> {
    const candidates = scanCandidates(action.parsed, raw);
    const result = await lookupBarcode(deps.api, candidates);

    if (result.kind === 'offline') return { kind: 'offline', code: action.code };
    if (result.kind === 'missing') return { kind: 'notFound', code: action.code };

    const { records, variants } = result.page;

    // Cache first, then index. A failed IndexedDB write (quota, private browsing) must not cost the
    // sale: the line carries its own `full_product_name` and price, so the only thing lost is that
    // the next scan of this code pays for the round trip again.
    try {
        await ingestCatalogRows(deps.db, { products: records, product_variants: variants });
    } catch {
        // Deliberately swallowed — see above.
    }

    setCatalog(
        insertCatalogProducts(getCatalog(), { products: records, variants }, nextCatalogVersion()),
    );

    const rerouted = routeScan(raw, getCatalog());

    // The server said it has this barcode and the local index still cannot see it. That is a bug in
    // the join, not a missing product, and reporting it as `notFound` would be the same silence this
    // ticket exists to remove — but there is nothing to add to the order either.
    if (rerouted.kind === 'unknown') return { kind: 'notFound', code: action.code };

    return { kind: 'resolved', action: rerouted };
}
