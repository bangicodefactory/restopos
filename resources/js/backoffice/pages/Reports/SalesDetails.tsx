/**
 * `Reports/SalesDetails` — `GET /reports/sales-details` (BOF-160…BOF-169).
 *
 * The X/Z-report equivalent: what sold, in what category, under which taxes, and how it was paid
 * for, over a date range.
 *
 * Every figure here comes from the **frozen** `session_*_summaries` tables, joined by the set of
 * sessions whose `business_date` falls in the range. That is why the numbers on this page can
 * differ from a live count of orders for a still-open session, and why the page says so instead
 * of leaving an operator to reconcile two screens that were never measuring the same thing.
 *
 * Charts are the existing hand-written SVG components (`components/charts`) — each one is a
 * `<figure>` with a `<title>`, a `<desc>` and a visually-hidden data table, so the numbers are
 * reachable and not merely drawn. No charting dependency is added; none is needed.
 *
 * **Contract gaps, named on the page rather than faked:** the controller exposes no breakdown by
 * employee (`session_sales_summaries` has no employee column) and none by hour (the summaries are
 * per session, and a session is not an hour). Both are stated with the key the vocabulary already
 * has for them, and the CSV export covers what *is* here.
 */

import { Head } from '@inertiajs/react';
import { Button } from '@shared/ui';
import { useMemo, useState, type JSX } from 'react';

import { BarChart, DonutChart, type ChartPoint } from '../../components/charts';
import { DataTable, type Column } from '../../components/data-table/DataTable';
import { useServerQuery } from '../../components/data-table/use-server-table';
import { AppLayout } from '../../components/layout/AppLayout';
import { PeriodFilter, type PeriodValue } from '../../components/report/PeriodFilter';
import { Tabs, type TabItem } from '../../components/ui/Tabs';
import { Card, CardBody, CardHeader, Notice, Stat } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { downloadCsv } from '../../lib/csv';
import { EUR, money, quantity, subtractMoney, sumMoney, toDecimal } from '../../lib/money';
import { routes } from '../../lib/routes';

import type {
    SalesByCategory,
    SalesByPaymentMethod,
    SalesByProduct,
    SalesByTax,
    SalesDetailsProps,
} from './types';

export default function SalesDetails({
    filters,
    byProduct,
    byCategory,
    byTax,
    byPaymentMethod,
}: SalesDetailsProps): JSX.Element {
    const t = useT();
    const [tab, setTab] = useState('product');
    const [search, setSearch] = useState('');

    const query = useServerQuery({
        url: routes.reports.salesDetails(),
        only: ['filters', 'byProduct', 'byCategory', 'byTax', 'byPaymentMethod'],
        initial: {
            from: filters.from,
            to: filters.to,
            config_id: filters.config_id ?? undefined,
        },
    });

    const [period, setPeriod] = useState<PeriodValue>({
        from: filters.from,
        to: filters.to,
        configId: filters.config_id === null ? '' : String(filters.config_id),
    });

    const totals = useMemo(
        () => ({
            base: sumMoney(byProduct.map((row) => row.base_amount)),
            tax: sumMoney(byProduct.map((row) => row.tax_amount)),
            total: sumMoney(byProduct.map((row) => row.total_amount)),
            cost: sumMoney(byProduct.map((row) => row.cost_amount)),
        }),
        [byProduct],
    );

    const categoryPoints = useMemo<ChartPoint[]>(
        () =>
            byCategory.slice(0, 8).map((row) => ({
                label: row.category_name ?? t('state.none'),
                value: Number(toDecimal(row.total_amount).toString()),
                display: money(row.total_amount, EUR),
            })),
        [byCategory, t],
    );

    const productPoints = useMemo<ChartPoint[]>(
        () =>
            byProduct.slice(0, 10).map((row) => ({
                label: row.product_name ?? `#${row.product_id ?? '?'}`,
                value: Number(toDecimal(row.total_amount).toString()),
                display: money(row.total_amount, EUR),
            })),
        [byProduct],
    );

    const tabs: TabItem[] = [
        { id: 'product', label: t('report.byProduct') },
        { id: 'category', label: t('report.byCategory') },
        { id: 'tax', label: t('report.byTax') },
        { id: 'payment', label: t('report.byPaymentMethod') },
    ];

    return (
        <AppLayout
            fullWidth
            title={t('report.salesDetails')}
            description={t('report.frozenSourceHint')}
            actions={
                <Button variant="secondary" size="md" onClick={() => globalThis.print()}>
                    {t('action.print')}
                </Button>
            }
        >
            <Head title={t('report.salesDetails')} />

            <div className="space-y-6">
                <PeriodFilter
                    value={period}
                    onChange={setPeriod}
                    processing={query.processing}
                    onApply={() =>
                        query.merge({
                            from: period.from === '' ? undefined : period.from,
                            to: period.to === '' ? undefined : period.to,
                            config_id: period.configId === '' ? undefined : period.configId,
                        })
                    }
                />

                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <Stat label={t('report.base')} value={money(totals.base, EUR)} />
                    <Stat label={t('report.taxAmount')} value={money(totals.tax, EUR)} tone="info" />
                    <Stat label={t('report.total')} value={money(totals.total, EUR)} tone="ok" icon="€" />
                    <Stat
                        label={t('report.margin')}
                        value={money(subtractMoney(totals.base, totals.cost), EUR)}
                        hint={`${t('report.cost')} ${money(totals.cost, EUR)}`}
                    />
                </div>

                <div className="grid gap-6 xl:grid-cols-2">
                    <Card>
                        <CardHeader title={t('report.byCategory')} />
                        <CardBody>
                            <DonutChart
                                title={t('report.byCategory')}
                                description={t('report.byCategoryDesc')}
                                data={categoryPoints}
                                categoryLabel={t('report.byCategory')}
                                valueLabel={t('report.revenue')}
                                centreLabel={t('report.total')}
                                centreValue={money(totals.total, EUR)}
                            />
                        </CardBody>
                    </Card>

                    <Card>
                        <CardHeader title={t('report.topProducts')} />
                        <CardBody>
                            <BarChart
                                horizontal
                                title={t('report.topProducts')}
                                description={t('report.topProductsDesc')}
                                data={productPoints}
                                categoryLabel={t('nav.products')}
                                valueLabel={t('report.revenue')}
                            />
                        </CardBody>
                    </Card>
                </div>

                <Card>
                    <CardBody>
                        <Tabs items={tabs} active={tab} onChange={setTab} label={t('report.salesDetails')}>
                            {tab === 'product' ? (
                                <ProductTable rows={byProduct} search={search} onSearch={setSearch} />
                            ) : null}
                            {tab === 'category' ? <CategoryTable rows={byCategory} /> : null}
                            {tab === 'tax' ? <TaxTable rows={byTax} /> : null}
                            {tab === 'payment' ? <PaymentTable rows={byPaymentMethod} /> : null}
                        </Tabs>
                    </CardBody>
                </Card>

                <div className="grid gap-4 lg:grid-cols-2">
                    <Notice tone="info" title={t('report.byEmployee')}>
                        {t('report.employeeMissing')}
                    </Notice>
                    <Notice tone="info" title={t('report.byHour')}>
                        {t('report.hourMissing')}
                    </Notice>
                </div>
            </div>
        </AppLayout>
    );
}

// ───────────────────────────────────────────────────────────── tables

function ProductTable({
    rows,
    search,
    onSearch,
}: {
    rows: SalesByProduct[];
    search: string;
    onSearch: (value: string) => void;
}): JSX.Element {
    const t = useT();

    const columns: Column<SalesByProduct>[] = [
        {
            id: 'product',
            header: t('nav.products'),
            locked: true,
            cell: (row) => row.product_name ?? `#${row.product_id ?? '?'}`,
            sortValue: (row) => row.product_name,
            searchValue: (row) => row.product_name,
            exportValue: (row) => row.product_name,
        },
        {
            id: 'quantity',
            header: t('report.quantity'),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{quantity(row.quantity)}</span>,
            sortValue: (row) => Number(toDecimal(row.quantity).toString()),
            exportValue: (row) => row.quantity,
        },
        {
            id: 'base_amount',
            header: t('report.base'),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{money(row.base_amount, EUR)}</span>,
            sortValue: (row) => Number(toDecimal(row.base_amount).toString()),
            exportValue: (row) => row.base_amount,
        },
        {
            id: 'tax_amount',
            header: t('report.taxAmount'),
            align: 'end',
            defaultHidden: true,
            cell: (row) => <span className="tabular-nums">{money(row.tax_amount, EUR)}</span>,
            sortValue: (row) => Number(toDecimal(row.tax_amount).toString()),
            exportValue: (row) => row.tax_amount,
        },
        {
            id: 'total_amount',
            header: t('report.total'),
            align: 'end',
            cell: (row) => <span className="font-semibold tabular-nums">{money(row.total_amount, EUR)}</span>,
            sortValue: (row) => Number(toDecimal(row.total_amount).toString()),
            exportValue: (row) => row.total_amount,
        },
        {
            id: 'cost_amount',
            header: t('report.cost'),
            align: 'end',
            defaultHidden: true,
            cell: (row) => <span className="tabular-nums text-slate-600">{money(row.cost_amount, EUR)}</span>,
            sortValue: (row) => Number(toDecimal(row.cost_amount).toString()),
            exportValue: (row) => row.cost_amount,
        },
        {
            id: 'margin',
            header: t('report.margin'),
            align: 'end',
            cell: (row) => (
                <span className="tabular-nums">
                    {money(subtractMoney(row.base_amount, row.cost_amount), EUR)}
                </span>
            ),
            sortValue: (row) =>
                Number(toDecimal(subtractMoney(row.base_amount, row.cost_amount)).toString()),
            exportValue: (row) => subtractMoney(row.base_amount, row.cost_amount),
        },
    ];

    return (
        <DataTable
            columns={columns}
            rows={rows}
            getRowId={(row) => `${row.product_id ?? 'null'}`}
            storageKey="report-sales-product"
            caption={t('report.byProduct')}
            search={{ value: search, onChange: onSearch }}
            exportFilename="ventes-par-produit"
            perPage={25}
            emptyTitle={t('chart.noData')}
        />
    );
}

function CategoryTable({ rows }: { rows: SalesByCategory[] }): JSX.Element {
    const t = useT();
    const total = useMemo(() => sumMoney(rows.map((row) => row.total_amount)), [rows]);

    return (
        <SimpleTable
            caption={t('report.byCategory')}
            filename="ventes-par-categorie"
            rows={rows}
            headers={[t('report.byCategory'), t('report.quantity'), t('report.total'), '%']}
            empty={t('chart.noData')}
            render={(row) => [
                row.category_name ?? t('state.none'),
                quantity(row.quantity),
                money(row.total_amount, EUR),
                share(row.total_amount, total),
            ]}
            exportRow={(row) => [row.category_name ?? '', String(row.quantity ?? ''), String(row.total_amount ?? ''), '']}
            footer={[t('report.total'), '', money(total, EUR), '100 %']}
        />
    );
}

function TaxTable({ rows }: { rows: SalesByTax[] }): JSX.Element {
    const t = useT();

    return (
        <SimpleTable
            caption={t('report.byTax')}
            filename="ventes-par-taxe"
            rows={rows}
            headers={[t('nav.taxes'), t('report.base'), t('report.taxAmount')]}
            empty={t('chart.noData')}
            render={(row) => [
                row.tax_name ?? `#${row.tax_id}`,
                money(row.base_amount, EUR),
                money(row.tax_amount, EUR),
            ]}
            exportRow={(row) => [row.tax_name ?? '', String(row.base_amount ?? ''), String(row.tax_amount ?? '')]}
            footer={[
                t('report.total'),
                money(sumMoney(rows.map((row) => row.base_amount)), EUR),
                money(sumMoney(rows.map((row) => row.tax_amount)), EUR),
            ]}
        />
    );
}

function PaymentTable({ rows }: { rows: SalesByPaymentMethod[] }): JSX.Element {
    const t = useT();

    return (
        <SimpleTable
            caption={t('report.byPaymentMethod')}
            filename="ventes-par-paiement"
            rows={rows}
            headers={[t('payment.title'), t('report.expected'), t('report.difference')]}
            empty={t('chart.noData')}
            render={(row) => [
                row.method_name ?? `#${row.payment_method_id}`,
                money(row.expected_amount, EUR),
                money(row.difference_amount, EUR),
            ]}
            exportRow={(row) => [
                row.method_name ?? '',
                String(row.expected_amount ?? ''),
                String(row.difference_amount ?? ''),
            ]}
            footer={[
                t('report.total'),
                money(sumMoney(rows.map((row) => row.expected_amount)), EUR),
                money(sumMoney(rows.map((row) => row.difference_amount)), EUR),
            ]}
        />
    );
}

function share(part: string | number | null | undefined, whole: string): string {
    const total = toDecimal(whole);
    if (total.isZero()) return '—';
    return `${toDecimal(part).div(total, 4).mul('100').withScale(1).toString().replace('.', ',')} %`;
}

/**
 * A small summary table with a CSV export.
 *
 * `DataTable` would be overkill for three columns that are never sorted or paged, and the report
 * pages need the export more than they need column visibility.
 */
function SimpleTable<T>({
    caption,
    filename,
    rows,
    headers,
    render,
    exportRow,
    footer,
    empty,
}: {
    caption: string;
    filename: string;
    rows: readonly T[];
    headers: string[];
    render: (row: T) => string[];
    exportRow: (row: T) => string[];
    footer?: string[];
    empty: string;
}): JSX.Element {
    const t = useT();

    if (rows.length === 0) {
        return <p className="px-2 py-8 text-center text-sm text-slate-500">{empty}</p>;
    }

    return (
        <div className="space-y-3">
            <div className="flex justify-end">
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                        downloadCsv(
                            filename,
                            rows,
                            headers.map((header, index) => ({
                                header,
                                value: (row: T) => exportRow(row)[index] ?? '',
                            })),
                        )
                    }
                >
                    {t('action.export')}
                </Button>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                    <caption className="sr-only">{caption}</caption>
                    <thead className="bg-slate-50">
                        <tr>
                            {headers.map((header, index) => (
                                <th
                                    key={header}
                                    scope="col"
                                    className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600 ${
                                        index === 0 ? 'text-start' : 'text-end'
                                    }`}
                                >
                                    {header}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {rows.map((row, rowIndex) => (
                            <tr key={rowIndex}>
                                {render(row).map((cell, index) => (
                                    <td
                                        key={index}
                                        className={`px-3 py-2 ${index === 0 ? '' : 'text-end tabular-nums'}`}
                                    >
                                        {cell}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                    {footer ? (
                        <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                            <tr>
                                {footer.map((cell, index) => (
                                    <td
                                        key={index}
                                        className={`px-3 py-2 ${index === 0 ? '' : 'text-end tabular-nums'}`}
                                    >
                                        {cell}
                                    </td>
                                ))}
                            </tr>
                        </tfoot>
                    ) : null}
                </table>
            </div>
        </div>
    );
}
