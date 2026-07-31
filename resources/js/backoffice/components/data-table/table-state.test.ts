import { describe, expect, it } from 'vitest';

import {
    clampPage,
    compareValues,
    filterRows,
    isColumnVisible,
    matchesSearch,
    normalizeSearch,
    pageCount,
    pageWindow,
    paginate,
    parseSort,
    rowRange,
    selectAllState,
    serializeSort,
    setAll,
    sortRows,
    toggleColumn,
    toggleId,
    toggleSort,
    type RowId,
    type SortState,
} from './table-state';

/** Unit coverage for the back-office data table's state machine. */

type Row = { id: number; name: string; barcode: string | null; price: number };

const ROWS: Row[] = [
    { id: 1, name: 'Éclair', barcode: null, price: 3 },
    { id: 2, name: 'Crème brûlée', barcode: '5901234123457', price: 7 },
    { id: 3, name: 'Baba', barcode: '', price: 7 },
    { id: 4, name: 'Zeste', barcode: '4006381333931', price: 1 },
];

const accessor = (row: Row, key: string): string | number | null =>
    (row as unknown as Record<string, string | number | null>)[key] ?? null;

describe('toggleSort', () => {
    it('cycles unsorted → asc → desc → unsorted', () => {
        const first = toggleSort(null, 'name');
        expect(first).toEqual({ key: 'name', direction: 'asc' });

        const second = toggleSort(first, 'name');
        expect(second).toEqual({ key: 'name', direction: 'desc' });

        expect(toggleSort(second, 'name')).toBeNull();
    });

    it('starts a new column at ascending, whatever the previous column was doing', () => {
        const current: SortState = { key: 'name', direction: 'desc' };
        expect(toggleSort(current, 'price')).toEqual({ key: 'price', direction: 'asc' });
    });
});

describe('sort serialisation', () => {
    it.each([
        { sort: null, text: null },
        { sort: { key: 'name', direction: 'asc' } as SortState, text: 'name' },
        { sort: { key: 'name', direction: 'desc' } as SortState, text: '-name' },
    ])('serialises $sort as $text', ({ sort, text }) => {
        expect(serializeSort(sort)).toBe(text);
    });

    it.each([
        { text: 'name', sort: { key: 'name', direction: 'asc' } },
        { text: '-name', sort: { key: 'name', direction: 'desc' } },
        { text: '  -created_at  ', sort: { key: 'created_at', direction: 'desc' } },
        { text: '', sort: null },
        { text: '-', sort: null },
        { text: null, sort: null },
        { text: undefined, sort: null },
    ])('parses $text', ({ text, sort }) => {
        expect(parseSort(text)).toEqual(sort);
    });

    it('round-trips', () => {
        const sort: SortState = { key: 'amount_total', direction: 'desc' };
        expect(parseSort(serializeSort(sort))).toEqual(sort);
    });
});

describe('compareValues', () => {
    it('sorts numbers numerically, not lexically', () => {
        expect(compareValues(9, 10)).toBeLessThan(0);
    });

    it('sorts strings under the French collation, so accents stay next to their base letter', () => {
        expect(compareValues('Éclair', 'Eclair')).toBe(0);
        expect(compareValues('Éclair', 'Zeste')).toBeLessThan(0);
    });

    it('sorts embedded numbers naturally', () => {
        expect(compareValues('Table 2', 'Table 10')).toBeLessThan(0);
    });

    it('sorts booleans false before true', () => {
        expect(compareValues(false, true)).toBeLessThan(0);
    });

    it.each([null, undefined, ''])('always sorts %o last', (empty) => {
        expect(compareValues(empty, 'A')).toBeGreaterThan(0);
        expect(compareValues('A', empty)).toBeLessThan(0);
    });

    it('treats two empties as equal', () => {
        expect(compareValues(null, '')).toBe(0);
    });
});

describe('sortRows', () => {
    it('returns a copy in the server order when nothing is sorted', () => {
        const result = sortRows(ROWS, null, accessor);
        expect(result).toEqual(ROWS);
        expect(result).not.toBe(ROWS);
    });

    it('sorts ascending and descending', () => {
        expect(sortRows(ROWS, { key: 'price', direction: 'asc' }, accessor).map((r) => r.id)).toEqual([
            4, 1, 2, 3,
        ]);
        expect(sortRows(ROWS, { key: 'price', direction: 'desc' }, accessor).map((r) => r.id)).toEqual([
            2, 3, 1, 4,
        ]);
    });

    it('is stable — equal rows keep the order the server sent them in', () => {
        const asc = sortRows(ROWS, { key: 'price', direction: 'asc' }, accessor);
        expect(asc.filter((r) => r.price === 7).map((r) => r.id)).toEqual([2, 3]);
    });

    it('keeps empty values last in both directions', () => {
        const asc = sortRows(ROWS, { key: 'barcode', direction: 'asc' }, accessor).map((r) => r.id);
        const desc = sortRows(ROWS, { key: 'barcode', direction: 'desc' }, accessor).map((r) => r.id);

        expect(asc.slice(-2)).toEqual([1, 3]);
        expect(desc.slice(-2)).toEqual([1, 3]);
    });
});

describe('selection', () => {
    it('toggleId adds then removes', () => {
        expect(toggleId([], 1)).toEqual([1]);
        expect(toggleId([1, 2], 1)).toEqual([2]);
    });

    it('setAll(true) adds the visible ids without dropping off-page ones', () => {
        expect(setAll([99], [1, 2], true)).toEqual([99, 1, 2]);
    });

    it('setAll(true) does not duplicate an already-selected id', () => {
        expect(setAll([1], [1, 2], true)).toEqual([1, 2]);
    });

    it('setAll(false) removes only the visible ids, so a page-1 selection survives page 2', () => {
        expect(setAll([1, 2, 99], [1, 2], false)).toEqual([99]);
    });

    it.each([
        { selected: [] as RowId[], ids: [1, 2], expected: 'none' },
        { selected: [1] as RowId[], ids: [1, 2], expected: 'some' },
        { selected: [1, 2] as RowId[], ids: [1, 2], expected: 'all' },
        { selected: [1, 2, 3] as RowId[], ids: [1, 2], expected: 'all' },
        { selected: [1] as RowId[], ids: [] as RowId[], expected: 'none' },
    ])('selectAllState($selected, $ids) → $expected', ({ selected, ids, expected }) => {
        expect(selectAllState(selected, ids)).toBe(expected);
    });
});

describe('column visibility', () => {
    it('stores hidden ids, so a newly added column is visible by default', () => {
        expect(isColumnVisible([], 'brand_new')).toBe(true);
        expect(isColumnVisible(['barcode'], 'barcode')).toBe(false);
    });

    it('toggles without duplicating', () => {
        expect(toggleColumn([], 'barcode', false)).toEqual(['barcode']);
        expect(toggleColumn(['barcode'], 'barcode', false)).toEqual(['barcode']);
        expect(toggleColumn(['barcode'], 'barcode', true)).toEqual([]);
    });
});

describe('paging', () => {
    it.each([
        { total: 0, perPage: 25, pages: 1 },
        { total: 1, perPage: 25, pages: 1 },
        { total: 25, perPage: 25, pages: 1 },
        { total: 26, perPage: 25, pages: 2 },
        { total: 100, perPage: 0, pages: 1 },
    ])('pageCount($total, $perPage) → $pages', ({ total, perPage, pages }) => {
        expect(pageCount(total, perPage)).toBe(pages);
    });

    it.each([
        { page: 0, pages: 5, expected: 1 },
        { page: 3, pages: 5, expected: 3 },
        { page: 9, pages: 5, expected: 5 },
        { page: 2.7, pages: 5, expected: 2 },
        { page: Number.NaN, pages: 5, expected: 1 },
        { page: 3, pages: 0, expected: 1 },
    ])('clampPage($page, $pages) → $expected', ({ page, pages, expected }) => {
        expect(clampPage(page, pages)).toBe(expected);
    });

    it('paginates and clamps an out-of-range page to the last one', () => {
        const rows = [1, 2, 3, 4, 5];
        expect(paginate(rows, 1, 2)).toEqual([1, 2]);
        expect(paginate(rows, 3, 2)).toEqual([5]);
        expect(paginate(rows, 99, 2)).toEqual([5]);
        expect(paginate(rows, 1, 0)).toEqual(rows);
    });

    it.each([
        { current: 1, pages: 1, expected: [1] },
        { current: 1, pages: 3, expected: [1, 2, 3] },
        { current: 5, pages: 20, expected: [1, '…', 4, 5, 6, '…', 20] },
        { current: 1, pages: 20, expected: [1, 2, '…', 20] },
        { current: 20, pages: 20, expected: [1, '…', 19, 20] },
    ])('pageWindow($current, $pages)', ({ current, pages, expected }) => {
        expect(pageWindow(current, pages)).toEqual(expected);
    });

    it('widens with the span', () => {
        expect(pageWindow(10, 20, 2)).toEqual([1, '…', 8, 9, 10, 11, 12, '…', 20]);
    });

    it.each([
        { page: 1, perPage: 50, total: 1284, expected: { from: 1, to: 50 } },
        { page: 2, perPage: 50, total: 1284, expected: { from: 51, to: 100 } },
        { page: 26, perPage: 50, total: 1284, expected: { from: 1251, to: 1284 } },
        { page: 1, perPage: 50, total: 0, expected: { from: 0, to: 0 } },
    ])('rowRange($page, $perPage, $total)', ({ page, perPage, total, expected }) => {
        expect(rowRange(page, perPage, total)).toEqual(expected);
    });
});

describe('filtering', () => {
    it.each([
        { input: 'Crème', expected: 'creme' },
        { input: '  ÉCLAIR ', expected: 'eclair' },
        { input: '', expected: '' },
    ])('normalizeSearch($input) → $expected', ({ input, expected }) => {
        expect(normalizeSearch(input)).toBe(expected);
    });

    it('matches accent- and case-insensitively', () => {
        expect(matchesSearch(['Crème brûlée'], 'creme')).toBe(true);
        expect(matchesSearch(['Crème brûlée'], 'BRULEE')).toBe(true);
        expect(matchesSearch(['Crème brûlée'], 'tarte')).toBe(false);
    });

    it('an empty query matches everything', () => {
        expect(matchesSearch([null], '   ')).toBe(true);
    });

    it('skips null and undefined fields', () => {
        expect(matchesSearch([null, undefined, 'Zeste'], 'zeste')).toBe(true);
        expect(matchesSearch([null, undefined], 'zeste')).toBe(false);
    });

    it('filterRows returns a copy for an empty query and filters otherwise', () => {
        const all = filterRows(ROWS, '  ', (row) => [row.name, row.barcode]);
        expect(all).toEqual(ROWS);
        expect(all).not.toBe(ROWS);

        expect(filterRows(ROWS, 'creme', (row) => [row.name, row.barcode]).map((r) => r.id)).toEqual([2]);
        expect(filterRows(ROWS, '590123', (row) => [row.name, row.barcode]).map((r) => r.id)).toEqual([2]);
    });
});
