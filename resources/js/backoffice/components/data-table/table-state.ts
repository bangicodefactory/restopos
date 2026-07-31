/**
 * The data table's state machine, as pure functions.
 *
 * Everything the table does that can be wrong — the three-way sort cycle, selection across a
 * filtered view, column visibility, the page window, the "select all" tri-state — lives here with
 * no React and no DOM, which is why it is the part that has unit tests
 * (`table-state.test.ts`). The component below it is then only markup and event wiring.
 */

export type SortDirection = 'asc' | 'desc';

export type SortState = {
    key: string;
    direction: SortDirection;
};

export type SortValue = string | number | boolean | null | undefined;

export type RowId = string | number;

/**
 * Three-way cycle: unsorted → ascending → descending → unsorted.
 *
 * The third state matters. Without it a table can never be returned to the server's own
 * ordering, which for orders and sessions is "newest first" — the ordering the operator actually
 * wants back after a detour through "sort by amount".
 */
export function toggleSort(current: SortState | null, key: string): SortState | null {
    if (current === null || current.key !== key) return { key, direction: 'asc' };
    if (current.direction === 'asc') return { key, direction: 'desc' };
    return null;
}

/** `{key:'name',direction:'desc'}` → `"-name"`. Compact enough to live in a URL. */
export function serializeSort(sort: SortState | null): string | null {
    if (sort === null) return null;
    return sort.direction === 'desc' ? `-${sort.key}` : sort.key;
}

export function parseSort(value: string | null | undefined): SortState | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === '-') return null;
    return trimmed.startsWith('-')
        ? { key: trimmed.slice(1), direction: 'desc' }
        : { key: trimmed, direction: 'asc' };
}

/**
 * Comparator with the two behaviours a POS back-office needs:
 * nulls always sort last regardless of direction (an empty barcode is not "before A"), and
 * strings compare with `localeCompare` under the French collation so "Éclair" lands next to
 * "Eclair" rather than after "Zeste".
 */
export function compareValues(a: SortValue, b: SortValue): number {
    const aEmpty = a === null || a === undefined || a === '';
    const bEmpty = b === null || b === undefined || b === '';
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;

    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);

    return String(a).localeCompare(String(b), 'fr', { numeric: true, sensitivity: 'base' });
}

/** Stable sort: equal rows keep the order the server sent them in. */
export function sortRows<T>(
    rows: readonly T[],
    sort: SortState | null,
    accessor: (row: T, key: string) => SortValue,
): T[] {
    if (sort === null) return [...rows];
    const sign = sort.direction === 'asc' ? 1 : -1;
    return rows
        .map((row, index) => ({ row, index }))
        .sort((left, right) => {
            const delta = compareValues(accessor(left.row, sort.key), accessor(right.row, sort.key));
            // The empty-last rule must survive a descending sort, so it is applied before the sign.
            if (delta === 0) return left.index - right.index;
            const leftEmpty = isEmpty(accessor(left.row, sort.key));
            const rightEmpty = isEmpty(accessor(right.row, sort.key));
            if (leftEmpty !== rightEmpty) return delta;
            return delta * sign;
        })
        .map((entry) => entry.row);
}

function isEmpty(value: SortValue): boolean {
    return value === null || value === undefined || value === '';
}

// ───────────────────────────────────────────────────────────── selection

export function toggleId(selected: readonly RowId[], id: RowId): RowId[] {
    return selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
}

/**
 * "Select all" applies to the **visible** rows only, and unselecting removes only those — so a
 * selection made on page 1 survives a trip to page 2 and back.
 */
export function setAll(selected: readonly RowId[], ids: readonly RowId[], checked: boolean): RowId[] {
    if (checked) {
        const merged = new Set<RowId>(selected);
        for (const id of ids) merged.add(id);
        return [...merged];
    }
    const removing = new Set<RowId>(ids);
    return selected.filter((id) => !removing.has(id));
}

export type SelectAllState = 'none' | 'some' | 'all';

export function selectAllState(selected: readonly RowId[], ids: readonly RowId[]): SelectAllState {
    if (ids.length === 0) return 'none';
    const chosen = new Set(selected);
    let count = 0;
    for (const id of ids) if (chosen.has(id)) count++;
    if (count === 0) return 'none';
    return count === ids.length ? 'all' : 'some';
}

// ───────────────────────────────────────────────────────────── column visibility

/** Hidden ids, not visible ids: a column added later is visible by default. */
export function toggleColumn(hidden: readonly string[], id: string, visible: boolean): string[] {
    if (visible) return hidden.filter((value) => value !== id);
    return hidden.includes(id) ? [...hidden] : [...hidden, id];
}

export function isColumnVisible(hidden: readonly string[], id: string): boolean {
    return !hidden.includes(id);
}

// ───────────────────────────────────────────────────────────── paging

export function pageCount(total: number, perPage: number): number {
    if (perPage <= 0) return 1;
    return Math.max(1, Math.ceil(total / perPage));
}

export function clampPage(page: number, pages: number): number {
    if (!Number.isFinite(page)) return 1;
    return Math.min(Math.max(1, Math.trunc(page)), Math.max(1, pages));
}

export function paginate<T>(rows: readonly T[], page: number, perPage: number): T[] {
    if (perPage <= 0) return [...rows];
    const safe = clampPage(page, pageCount(rows.length, perPage));
    const start = (safe - 1) * perPage;
    return rows.slice(start, start + perPage);
}

/** `[1, '…', 4, 5, 6, '…', 20]` — always first, last, and a window around the current page. */
export function pageWindow(current: number, pages: number, span = 1): (number | '…')[] {
    if (pages <= 1) return [1];
    const safe = clampPage(current, pages);
    const wanted = new Set<number>([1, pages]);
    for (let page = safe - span; page <= safe + span; page++) {
        if (page >= 1 && page <= pages) wanted.add(page);
    }

    const ordered = [...wanted].sort((a, b) => a - b);
    const out: (number | '…')[] = [];
    let previous = 0;
    for (const page of ordered) {
        if (previous !== 0 && page - previous > 1) out.push('…');
        out.push(page);
        previous = page;
    }
    return out;
}

// ───────────────────────────────────────────────────────────── filtering

/** Accent- and case-insensitive contains, so "creme" finds "Crème". */
export function normalizeSearch(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

export function matchesSearch(haystack: readonly (string | null | undefined)[], query: string): boolean {
    const needle = normalizeSearch(query);
    if (needle === '') return true;
    return haystack.some((value) => value !== null && value !== undefined && normalizeSearch(value).includes(needle));
}

export function filterRows<T>(
    rows: readonly T[],
    query: string,
    fields: (row: T) => (string | null | undefined)[],
): T[] {
    if (normalizeSearch(query) === '') return [...rows];
    return rows.filter((row) => matchesSearch(fields(row), query));
}

/** Row range for the "1–50 of 1 284" caption. */
export function rowRange(page: number, perPage: number, total: number): { from: number; to: number } {
    if (total === 0) return { from: 0, to: 0 };
    const from = (clampPage(page, pageCount(total, perPage)) - 1) * perPage + 1;
    return { from, to: Math.min(from + perPage - 1, total) };
}
