/**
 * `Products/Index` — `GET /products` (BOF-080).
 *
 * Server-paginated (50/page) with the two filters the controller accepts: a free-text `search`
 * over name, internal reference and barcode, and `category_id`. Both go through
 * `useServerQuery`, so a keystroke re-fetches **only** the `products` prop and leaves the
 * deferred category list alone.
 */

import { Head, Link, router, useForm } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { useServerQuery } from '../../components/data-table/use-server-table';
import { TextField } from '../../components/form';
import { FormSection, MoneyField } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, BoolCell, Card, CardBody, CardHeader } from '../../components/ui/primitives';
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
            cell: (row) => (
                <EightySixToggle
                    uuid={row.uuid}
                    name={row.name}
                    available={row.self_order_available}
                />
            ),
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

            <div className="mt-6">
                <AddProduct />
            </div>
        </AppLayout>
    );
}


/**
 * 86-ing a dish, in one tap from the list (BOF-094).
 *
 * "86" is kitchen shorthand for "we are out of it". It happens mid-service, at speed, usually while
 * somebody is standing at the pass shouting — and it used to mean two navigations into the editor
 * and a save. The realtime half already worked: the write invalidates the catalogue cache and
 * broadcasts, so the self-order menu drops the dish without a reload.
 *
 * `self_order_available` rather than `available_in_pos`: taking a dish off the guest-facing menu is
 * a service decision, while pulling it from the till is a catalogue one — and the second is frozen
 * during an open session anyway (BOF-083), which is exactly when 86-ing happens.
 */
function EightySixToggle({
    uuid,
    name,
    available,
}: {
    uuid: string;
    name: string;
    available: boolean;
}): JSX.Element {
    const t = useT();
    const [busy, setBusy] = useState(false);

    return (
        <Button
            variant={available ? 'ghost' : 'secondary'}
            size="sm"
            loading={busy}
            aria-label={`${available ? t('product.eightySix') : t('product.eightySixBack')} — ${name}`}
            onClick={() => {
                setBusy(true);
                router.patch(
                    routes.products.update(uuid),
                    { self_order_available: !available },
                    {
                        preserveScroll: true,
                        preserveState: true,
                        onFinish: () => setBusy(false),
                    },
                );
            }}
        >
            {available ? t('product.eightySix') : t('product.eightySixBack')}
        </Button>
    );
}


/**
 * Adding a product (BOF-081).
 *
 * Name and price only. Everything else is on the product's own page, and a new product is given the
 * venue's reference unit and one variant server-side — a product with no variant is listable,
 * editable and unsellable, because an order line references a variant rather than a product.
 */
function AddProduct(): JSX.Element {
    const t = useT();
    const form = useForm<{ name: string; list_price: string }>({ name: '', list_price: '0.00' });

    return (
        <Card>
            <CardHeader title={t('product.add')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('productCategory.name')}
                        required
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <MoneyField
                        label={t('product.listPrice')}
                        value={form.data.list_price}
                        error={form.errors.list_price}
                        onChange={(value) => form.setData('list_price', value)}
                    />
                </FormSection>

                <Button
                    loading={form.processing}
                    disabled={form.data.name.trim() === ''}
                    onClick={() =>
                        form.post(routes.products.store(), {
                            preserveScroll: true,
                            onSuccess: () => form.reset(),
                        })
                    }
                >
                    {t('product.add')}
                </Button>
            </CardBody>
        </Card>
    );
}
