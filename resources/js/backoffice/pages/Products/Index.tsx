/**
 * `Products/Index` — `GET /products` (BOF-080).
 *
 * Server-paginated (50/page) with the two filters the controller accepts: a free-text `search`
 * over name, internal reference and barcode, and `category_id`. Both go through
 * `useServerQuery`, so a keystroke re-fetches **only** the `products` prop and leaves the
 * deferred category list alone.
 */

import { Head, Link } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { useServerQuery } from '../../components/data-table/use-server-table';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, BoolCell } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { EUR, money, subtractMoney } from '../../lib/money';
import { routes } from '../../lib/routes';

import type { ProductListRow, ProductsIndexProps } from './types';

export default function ProductsIndex({ products, filters, categories }: ProductsIndexProps): JSX.Element {
    const t = useT();

    const query = useServerQuery({
        url: routes.products.index(),
        only: ['products', 'filters'],
        initial: {
            search: filters.search ?? undefined,
            category_id: filters.category_id ?? undefined,
        },
    });

    const columns: Column<ProductListRow>[] = [
        {
            id: 'name',
            header: t('nav.products'),
            locked: true,
            cell: (row) => row.name,
            sortValue: (row) => row.name,
            searchValue: (row) => row.name,
            exportValue: (row) => row.name,
        },
        {
            id: 'default_code',
            header: 'Référence',
            cell: (row) => <span className="font-mono text-xs">{row.default_code ?? '—'}</span>,
            sortValue: (row) => row.default_code,
            exportValue: (row) => row.default_code,
        },
        {
            id: 'barcode',
            header: 'Code-barres',
            defaultHidden: true,
            cell: (row) => <span className="font-mono text-xs">{row.barcode ?? '—'}</span>,
            sortValue: (row) => row.barcode,
            exportValue: (row) => row.barcode,
        },
        {
            id: 'categories',
            header: t('product.categories'),
            cell: (row) => (
                <span className="flex flex-wrap gap-1">
                    {row.categories.length === 0 ? (
                        <span className="text-slate-400">—</span>
                    ) : (
                        row.categories.map((category) => <Badge key={category}>{category}</Badge>)
                    )}
                </span>
            ),
            searchValue: (row) => row.categories.join(' '),
            exportValue: (row) => row.categories.join(' / '),
        },
        {
            id: 'list_price',
            header: t('product.listPrice'),
            align: 'end',
            cell: (row) => <span className="font-semibold tabular-nums">{money(row.list_price, EUR)}</span>,
            sortValue: (row) => Number(row.list_price),
            exportValue: (row) => row.list_price,
        },
        {
            id: 'standard_price',
            header: t('product.standardPrice'),
            align: 'end',
            defaultHidden: true,
            cell: (row) => <span className="tabular-nums text-slate-600">{money(row.standard_price, EUR)}</span>,
            sortValue: (row) => Number(row.standard_price),
            exportValue: (row) => row.standard_price,
        },
        {
            id: 'margin',
            header: t('product.margin'),
            align: 'end',
            defaultHidden: true,
            cell: (row) => (
                <span className="tabular-nums text-slate-600">
                    {money(subtractMoney(row.list_price, row.standard_price), EUR)}
                </span>
            ),
            sortValue: (row) => Number(row.list_price) - Number(row.standard_price),
            exportValue: (row) => subtractMoney(row.list_price, row.standard_price),
        },
        {
            id: 'available_in_pos',
            header: t('product.availableInPos'),
            align: 'center',
            cell: (row) => <BoolCell value={row.available_in_pos} labels={[t('state.yes'), t('state.no')]} />,
            sortValue: (row) => row.available_in_pos,
            exportValue: (row) => (row.available_in_pos ? '1' : '0'),
        },
        {
            id: 'self_order_available',
            header: t('product.selfOrderAvailable'),
            align: 'center',
            defaultHidden: true,
            cell: (row) => <BoolCell value={row.self_order_available} labels={[t('state.yes'), t('state.no')]} />,
            sortValue: (row) => row.self_order_available,
            exportValue: (row) => (row.self_order_available ? '1' : '0'),
        },
        {
            id: 'active',
            header: t('state.active'),
            align: 'center',
            cell: (row) => (
                <Badge tone={row.active ? 'ok' : 'neutral'}>{row.active ? t('state.active') : t('state.inactive')}</Badge>
            ),
            sortValue: (row) => row.active,
            exportValue: (row) => (row.active ? '1' : '0'),
        },
        {
            id: 'actions',
            header: '',
            align: 'end',
            cell: (row) => (
                <Link
                    href={routes.products.edit(row.uuid)}
                    className={cn('rounded-pos px-2 py-1 text-sm text-brand-700 hover:underline', FOCUS_RING)}
                >
                    {t('action.edit')}
                </Link>
            ),
        },
    ];

    return (
        <AppLayout title={t('product.title')}>
            <Head title={t('product.title')} />

            <DataTable
                columns={columns}
                rows={products.data}
                getRowId={(row) => row.id}
                storageKey="products"
                caption={t('product.title')}
                loading={query.processing}
                paginator={products}
                search={{
                    value: String(query.params.search ?? ''),
                    onChange: (value) => query.set('search', value, { debounce: true }),
                    placeholder: t('product.filterSearch'),
                    server: true,
                }}
                filters={
                    <>
                        <label className="sr-only" htmlFor="product-category-filter">
                            {t('product.filterCategory')}
                        </label>
                        <select
                            id="product-category-filter"
                            value={String(query.params.category_id ?? '')}
                            onChange={(event) => query.set('category_id', event.target.value || undefined)}
                            className={cn(
                                'min-h-touch rounded-pos bg-white px-3 text-sm ring-1 ring-inset ring-slate-300',
                                FOCUS_RING,
                            )}
                        >
                            <option value="">{t('product.filterCategory')} — {t('state.all')}</option>
                            {(categories ?? []).map((category) => (
                                <option key={category.id} value={category.id}>
                                    {category.name}
                                </option>
                            ))}
                        </select>

                        {query.dirty ? (
                            <Button variant="ghost" size="md" onClick={query.reset}>
                                {t('action.clearFilters')}
                            </Button>
                        ) : null}
                    </>
                }
                exportFilename="produits"
                onRowHref={(row) => routes.products.edit(row.uuid)}
            />
        </AppLayout>
    );
}
