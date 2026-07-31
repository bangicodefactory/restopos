/**
 * The list component every back-office table is built from.
 *
 * What it does:
 *   - **server mode** — search, filters and pagination go through Inertia partial reloads
 *     (`useServerQuery`), which is how the paginated lists (products, orders, sessions) work;
 *   - **client mode** — the same UI over an array the controller sent whole (taxes, employees,
 *     floors, payment methods), with local search, sort and paging;
 *   - column visibility, remembered per table in `localStorage`;
 *   - bulk selection with an action bar;
 *   - sticky header, loading overlay, empty state, CSV export.
 *
 * **Sorting is client-side, deliberately.** Spec 05 §12 exposes no `sort` parameter on any list
 * route, so a server sort would be a query string the controller ignores — a control that lies.
 * Sorting therefore reorders the rows the table currently holds, and the header says so via
 * `aria-sort`. When the contract grows a sort parameter, `useServerQuery.set('sort', …)` is the
 * one line that changes.
 */

import { Link } from '@inertiajs/react';
import { Button, FOCUS_RING, LoadingPane, SearchInput, cn } from '@shared/ui';
import {
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type JSX,
    type ReactNode,
} from 'react';

import { useT } from '../../i18n';
import { downloadCsv, type CsvColumn } from '../../lib/csv';
import { decodePagerLabel } from '../../lib/query';
import type { Paginator } from '../../types/inertia';
import { Badge, EmptyState } from '../ui/primitives';

import {
    clampPage,
    filterRows,
    isColumnVisible,
    pageCount,
    pageWindow,
    paginate,
    rowRange,
    selectAllState,
    setAll,
    sortRows,
    toggleColumn,
    toggleId,
    toggleSort,
    type RowId,
    type SortState,
    type SortValue,
} from './table-state';

export type Column<T> = {
    id: string;
    header: ReactNode;
    cell: (row: T) => ReactNode;
    /** Providing this makes the column sortable. */
    sortValue?: (row: T) => SortValue;
    /** Contributes to the client-side search. */
    searchValue?: (row: T) => string | null | undefined;
    /** Cell content for the CSV export; falls back to `searchValue`. */
    exportValue?: (row: T) => string | number | null | undefined;
    align?: 'start' | 'center' | 'end';
    /** Tailwind width class, e.g. `w-32`. */
    width?: string;
    /** Hidden until the operator turns it on. */
    defaultHidden?: boolean;
    /** Cannot be hidden (the identifying column). */
    locked?: boolean;
    headerLabel?: string;
};

export type BulkAction = {
    id: string;
    label: string;
    onRun: (ids: RowId[]) => void;
    destructive?: boolean;
};

export type DataTableProps<T> = {
    columns: readonly Column<T>[];
    rows: readonly T[];
    getRowId: (row: T) => RowId;
    /** Stable key for the column-visibility preference. */
    storageKey: string;
    caption: string;

    loading?: boolean;
    emptyTitle?: string;
    emptyHint?: string;
    emptyAction?: ReactNode;

    /**
     * Search box. `server: true` means the caller pushes the term through `useServerQuery` and
     * the table must not filter locally; otherwise the term filters `searchValue`s in place.
     */
    search?: {
        value: string;
        onChange: (value: string) => void;
        placeholder?: string;
        server?: boolean;
    };
    filters?: ReactNode;
    actions?: ReactNode;

    selection?: {
        selected: RowId[];
        onChange: (ids: RowId[]) => void;
        actions: readonly BulkAction[];
    };

    /** Server paginator; when absent the table pages locally by `perPage`. */
    paginator?: Pick<Paginator<T>, 'current_page' | 'last_page' | 'per_page' | 'total' | 'from' | 'to' | 'links'>;
    perPage?: number;

    exportFilename?: string;
    onRowHref?: (row: T) => string;
    rowClassName?: (row: T) => string | undefined;
};

const ALIGN: Record<'start' | 'center' | 'end', string> = {
    start: 'text-start',
    center: 'text-center',
    end: 'text-end',
};

export function DataTable<T>({
    columns,
    rows,
    getRowId,
    storageKey,
    caption,
    loading = false,
    emptyTitle,
    emptyHint,
    emptyAction,
    search,
    filters,
    actions,
    selection,
    paginator,
    perPage = 25,
    exportFilename,
    onRowHref,
    rowClassName,
}: DataTableProps<T>): JSX.Element {
    const t = useT();
    const base = useId();
    const [sort, setSort] = useState<SortState | null>(null);
    const [page, setPage] = useState(1);
    const [hidden, setHidden] = useState<string[]>(() => readHidden(storageKey, columns));
    const [columnsOpen, setColumnsOpen] = useState(false);
    const columnsMenuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        writeHidden(storageKey, hidden);
    }, [hidden, storageKey]);

    // Close the column menu on an outside click or Escape — it is a menu, not a dialog.
    useEffect(() => {
        if (!columnsOpen) return undefined;
        const onDown = (event: MouseEvent): void => {
            if (!columnsMenuRef.current?.contains(event.target as Node)) setColumnsOpen(false);
        };
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setColumnsOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [columnsOpen]);

    const visibleColumns = useMemo(
        () => columns.filter((column) => isColumnVisible(hidden, column.id)),
        [columns, hidden],
    );

    const clientSearch = search !== undefined && search.server !== true;

    const filtered = useMemo(() => {
        if (!clientSearch || !search) return rows;
        return filterRows(rows, search.value, (row) =>
            columns.map((column) => (column.searchValue ? column.searchValue(row) : null)),
        );
    }, [clientSearch, columns, rows, search]);

    const sorted = useMemo(() => {
        if (sort === null) return filtered;
        const accessor = (row: T, key: string): SortValue => {
            const column = columns.find((candidate) => candidate.id === key);
            return column?.sortValue ? column.sortValue(row) : null;
        };
        return sortRows(filtered, sort, accessor);
    }, [columns, filtered, sort]);

    const pages = paginator ? paginator.last_page : pageCount(sorted.length, perPage);
    const currentPage = paginator ? paginator.current_page : clampPage(page, pages);
    const visibleRows = paginator ? sorted : paginate(sorted, currentPage, perPage);
    const visibleIds = useMemo(() => visibleRows.map(getRowId), [getRowId, visibleRows]);

    const allState = selection ? selectAllState(selection.selected, visibleIds) : 'none';

    const onSort = useCallback((key: string) => setSort((current) => toggleSort(current, key)), []);

    const onExport = useCallback(() => {
        if (!exportFilename) return;
        const csvColumns: CsvColumn<T>[] = visibleColumns.map((column) => ({
            header: typeof column.header === 'string' ? column.header : (column.headerLabel ?? column.id),
            value: (row: T) =>
                column.exportValue ? column.exportValue(row) : (column.searchValue?.(row) ?? ''),
        }));
        downloadCsv(exportFilename, sorted, csvColumns);
    }, [exportFilename, sorted, visibleColumns]);

    const range = paginator
        ? { from: paginator.from ?? 0, to: paginator.to ?? 0 }
        : rowRange(currentPage, perPage, sorted.length);
    const total = paginator ? paginator.total : sorted.length;

    return (
        <div className="rounded-pos-lg bg-white shadow-pos ring-1 ring-slate-200">
            {/* toolbar */}
            <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3">
                {search ? (
                    <div className="min-w-[16rem] flex-1">
                        <label className="sr-only" htmlFor={`${base}-search`}>
                            {search.placeholder ?? t('table.search')}
                        </label>
                        <SearchInput
                            id={`${base}-search`}
                            value={search.value}
                            onChange={(value) => {
                                setPage(1);
                                search.onChange(value);
                            }}
                            placeholder={search.placeholder ?? t('table.search')}
                        />
                    </div>
                ) : (
                    <div className="flex-1" />
                )}

                {filters}

                <div className="relative" ref={columnsMenuRef}>
                    <Button
                        variant="secondary"
                        size="md"
                        aria-haspopup="true"
                        aria-expanded={columnsOpen}
                        onClick={() => setColumnsOpen((open) => !open)}
                    >
                        {t('table.columns')}
                    </Button>
                    {columnsOpen ? (
                        <div
                            role="group"
                            aria-label={t('table.columnsHint')}
                            className="absolute end-0 z-30 mt-1 max-h-80 w-64 overflow-auto rounded-pos bg-white p-2 shadow-pos-lg ring-1 ring-slate-200"
                        >
                            {columns.map((column) => (
                                <label
                                    key={column.id}
                                    className={cn(
                                        'flex min-h-touch cursor-pointer items-center gap-2 rounded-pos px-2 text-sm hover:bg-slate-50',
                                        column.locked && 'cursor-not-allowed opacity-50',
                                    )}
                                >
                                    <input
                                        type="checkbox"
                                        className={cn('h-4 w-4 rounded border-slate-300', FOCUS_RING)}
                                        checked={isColumnVisible(hidden, column.id)}
                                        disabled={column.locked}
                                        onChange={(event) =>
                                            setHidden((current) =>
                                                toggleColumn(current, column.id, event.target.checked),
                                            )
                                        }
                                    />
                                    <span className="truncate">
                                        {typeof column.header === 'string' ? column.header : (column.headerLabel ?? column.id)}
                                    </span>
                                </label>
                            ))}
                        </div>
                    ) : null}
                </div>

                {exportFilename ? (
                    <Button variant="secondary" size="md" onClick={onExport}>
                        {t('action.export')}
                    </Button>
                ) : null}

                {actions}
            </div>

            {/* bulk bar */}
            {selection && selection.selected.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2 border-b border-brand-200 bg-brand-50 px-4 py-2">
                    <Badge tone="brand">{t('table.selected', { count: selection.selected.length })}</Badge>
                    {selection.actions.map((action) => (
                        <Button
                            key={action.id}
                            size="sm"
                            variant={action.destructive ? 'danger' : 'secondary'}
                            onClick={() => action.onRun(selection.selected)}
                        >
                            {action.label}
                        </Button>
                    ))}
                    <Button size="sm" variant="ghost" onClick={() => selection.onChange([])}>
                        {t('table.clearSelection')}
                    </Button>
                </div>
            ) : null}

            {/* table */}
            <div className="relative max-h-[70vh] overflow-auto">
                {loading ? (
                    <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/70">
                        <LoadingPane label={t('state.loading')} />
                    </div>
                ) : null}

                <table className="w-full border-collapse text-sm">
                    <caption className="sr-only">{caption}</caption>
                    <thead className="sticky top-0 z-10 bg-slate-50 shadow-[0_1px_0_0_theme(colors.slate.200)]">
                        <tr>
                            {selection ? (
                                <th scope="col" className="w-10 px-3 py-2">
                                    <input
                                        type="checkbox"
                                        aria-label={t('table.selectAll')}
                                        className={cn('h-4 w-4 rounded border-slate-300', FOCUS_RING)}
                                        checked={allState === 'all'}
                                        ref={(node) => {
                                            if (node) node.indeterminate = allState === 'some';
                                        }}
                                        onChange={(event) =>
                                            selection.onChange(
                                                setAll(selection.selected, visibleIds, event.target.checked),
                                            )
                                        }
                                    />
                                </th>
                            ) : null}

                            {visibleColumns.map((column) => {
                                const sortable = column.sortValue !== undefined;
                                const active = sort?.key === column.id;
                                return (
                                    <th
                                        key={column.id}
                                        scope="col"
                                        aria-sort={
                                            active ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : 'none'
                                        }
                                        className={cn(
                                            'whitespace-nowrap px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600',
                                            ALIGN[column.align ?? 'start'],
                                            column.width,
                                        )}
                                    >
                                        {sortable ? (
                                            <button
                                                type="button"
                                                onClick={() => onSort(column.id)}
                                                title={
                                                    active && sort?.direction === 'asc'
                                                        ? t('table.sortDesc')
                                                        : active
                                                          ? t('table.sortNone')
                                                          : t('table.sortAsc')
                                                }
                                                className={cn(
                                                    'inline-flex min-h-touch items-center gap-1 rounded-pos px-1 hover:text-slate-900',
                                                    FOCUS_RING,
                                                )}
                                            >
                                                {column.header}
                                                <span aria-hidden className={cn(!active && 'opacity-30')}>
                                                    {active ? (sort?.direction === 'asc' ? '▲' : '▼') : '↕'}
                                                </span>
                                            </button>
                                        ) : (
                                            column.header
                                        )}
                                    </th>
                                );
                            })}
                        </tr>
                    </thead>

                    <tbody className="divide-y divide-slate-100">
                        {visibleRows.map((row) => {
                            const id = getRowId(row);
                            const checked = selection?.selected.includes(id) ?? false;
                            return (
                                <tr
                                    key={String(id)}
                                    className={cn(
                                        'hover:bg-slate-50',
                                        checked && 'bg-brand-50/60',
                                        rowClassName?.(row),
                                    )}
                                >
                                    {selection ? (
                                        <td className="px-3 py-2">
                                            <input
                                                type="checkbox"
                                                aria-label={t('table.selectRow')}
                                                className={cn('h-4 w-4 rounded border-slate-300', FOCUS_RING)}
                                                checked={checked}
                                                onChange={() => selection.onChange(toggleId(selection.selected, id))}
                                            />
                                        </td>
                                    ) : null}

                                    {visibleColumns.map((column, columnIndex) => {
                                        const content = column.cell(row);
                                        const href = columnIndex === 0 ? onRowHref?.(row) : undefined;
                                        return (
                                            <td
                                                key={column.id}
                                                className={cn(
                                                    'px-3 py-2 align-middle text-slate-800',
                                                    ALIGN[column.align ?? 'start'],
                                                )}
                                            >
                                                {href ? (
                                                    <Link
                                                        href={href}
                                                        className={cn(
                                                            'rounded-pos font-medium text-brand-700 underline-offset-2 hover:underline',
                                                            FOCUS_RING,
                                                        )}
                                                    >
                                                        {content}
                                                    </Link>
                                                ) : (
                                                    content
                                                )}
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>

                {visibleRows.length === 0 && !loading ? (
                    <EmptyState
                        title={emptyTitle ?? t('state.empty')}
                        hint={emptyHint ?? t('state.emptyHint')}
                        action={emptyAction}
                    />
                ) : null}
            </div>

            {/* footer */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
                <span aria-live="polite">
                    {t('table.rows', { from: range.from, to: range.to, total })}
                </span>

                {paginator ? (
                    <nav aria-label={t('table.page', { page: currentPage, pages })} className="flex flex-wrap gap-1">
                        {paginator.links.map((link, index) => {
                            const label = decodePagerLabel(link.label);
                            if (link.url === null) {
                                return (
                                    <span key={index} className="min-h-touch px-3 py-1 text-slate-400">
                                        {label}
                                    </span>
                                );
                            }
                            return (
                                <Link
                                    key={index}
                                    href={link.url}
                                    preserveScroll
                                    preserveState
                                    aria-current={link.active ? 'page' : undefined}
                                    className={cn(
                                        'inline-flex min-h-touch items-center rounded-pos px-3',
                                        FOCUS_RING,
                                        link.active
                                            ? 'bg-brand-600 font-semibold text-white'
                                            : 'text-slate-700 hover:bg-slate-100',
                                    )}
                                >
                                    {label}
                                </Link>
                            );
                        })}
                    </nav>
                ) : pages > 1 ? (
                    <nav aria-label={t('table.page', { page: currentPage, pages })} className="flex flex-wrap gap-1">
                        <PagerButton
                            label={t('table.previous')}
                            disabled={currentPage <= 1}
                            onClick={() => setPage(currentPage - 1)}
                        />
                        {pageWindow(currentPage, pages).map((entry, index) =>
                            entry === '…' ? (
                                <span key={`gap-${index}`} className="px-2 py-1 text-slate-400">
                                    …
                                </span>
                            ) : (
                                <button
                                    key={entry}
                                    type="button"
                                    aria-current={entry === currentPage ? 'page' : undefined}
                                    onClick={() => setPage(entry)}
                                    className={cn(
                                        'inline-flex min-h-touch items-center rounded-pos px-3',
                                        FOCUS_RING,
                                        entry === currentPage
                                            ? 'bg-brand-600 font-semibold text-white'
                                            : 'text-slate-700 hover:bg-slate-100',
                                    )}
                                >
                                    {entry}
                                </button>
                            ),
                        )}
                        <PagerButton
                            label={t('table.next')}
                            disabled={currentPage >= pages}
                            onClick={() => setPage(currentPage + 1)}
                        />
                    </nav>
                ) : null}
            </div>
        </div>
    );
}

function PagerButton({
    label,
    disabled,
    onClick,
}: {
    label: string;
    disabled: boolean;
    onClick: () => void;
}): JSX.Element {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={cn(
                'inline-flex min-h-touch items-center rounded-pos px-3 text-slate-700 hover:bg-slate-100',
                'disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent',
                FOCUS_RING,
            )}
        >
            {label}
        </button>
    );
}

function storageId(key: string): string {
    return `restopos.bo.columns.${key}`;
}

function readHidden<T>(key: string, columns: readonly Column<T>[]): string[] {
    const fallback = columns.filter((column) => column.defaultHidden).map((column) => column.id);
    try {
        const raw = globalThis.localStorage?.getItem(storageId(key));
        if (raw === null || raw === undefined) return fallback;
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return fallback;
        return parsed.filter((value): value is string => typeof value === 'string');
    } catch {
        return fallback;
    }
}

function writeHidden(key: string, hidden: readonly string[]): void {
    try {
        globalThis.localStorage?.setItem(storageId(key), JSON.stringify(hidden));
    } catch {
        // A private-mode browser with storage disabled loses the preference; the table still works.
    }
}

export { useServerQuery } from './use-server-table';
export type { ServerQuery } from './use-server-table';
export * from './table-state';
