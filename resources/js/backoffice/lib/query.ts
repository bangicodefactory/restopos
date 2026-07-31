/**
 * Query-string plumbing shared by every server-driven list.
 *
 * The list controllers read their filters straight off the request (`$request->query('search')`)
 * and echo them back in a `filters` prop, so the URL *is* the table state. Keeping it there —
 * rather than in component state — means back/forward work, a filtered list is a shareable link,
 * and an Inertia partial reload can re-fetch only the prop that changed.
 */

export type QueryValue = string | number | boolean | null | undefined;

/** Drop empties so `/products?search=&category_id=` never happens. */
export function cleanParams(params: Record<string, QueryValue>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && value.trim() === '') continue;
        if (typeof value === 'boolean') {
            if (!value) continue;
            out[key] = '1';
            continue;
        }
        out[key] = String(value);
    }
    return out;
}

/** `{search: 'pizza'}` → `?search=pizza`, or `''` when nothing is set. */
export function toQueryString(params: Record<string, QueryValue>): string {
    const cleaned = cleanParams(params);
    const search = new URLSearchParams(cleaned).toString();
    return search === '' ? '' : `?${search}`;
}

export function withQuery(path: string, params: Record<string, QueryValue>): string {
    return `${path}${toQueryString(params)}`;
}

/** Read the current URL's query string — used to seed a filter bar on first render. */
export function currentParams(): Record<string, string> {
    if (typeof globalThis.location === 'undefined') return {};
    const out: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(globalThis.location.search)) out[key] = value;
    return out;
}

/**
 * Laravel's paginator emits `links[].label` containing raw HTML entities
 * (`&laquo; Previous`). Decoding is done here, once, rather than with
 * `dangerouslySetInnerHTML` in the pager.
 */
export function decodePagerLabel(label: string): string {
    return label
        .replace(/&laquo;/g, '«')
        .replace(/&raquo;/g, '»')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .replace(/Previous/i, 'Précédent')
        .replace(/Next/i, 'Suivant')
        .trim();
}
