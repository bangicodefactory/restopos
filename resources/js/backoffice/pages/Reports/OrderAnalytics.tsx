/**
 * `Reports/OrderAnalytics` — `GET /reports/order-analytics` (BOF-170…BOF-189).
 *
 * Trends rather than ledger: orders per day, revenue per day, average ticket, spend per guest,
 * refund rate, and the split by origin (caisse / mobile / borne / back-office / API).
 *
 * Unlike `Reports/SalesDetails`, this page reads **`pos_orders` directly**, filtered to `paid` and
 * `done`. That is the right source for a trend — it includes today's still-open session, which
 * the frozen summaries do not — and the wrong source for a ledger figure, which is why the two
 * pages can disagree by the value of an open session and why that is stated here rather than left
 * to be discovered.
 *
 * **Derived figures are computed from decimal strings.** The average ticket is
 * `revenue ÷ order_count` through `@domain/money`, not `Number(revenue) / count`: a mean of nine
 * thousand orders is exactly where binary floating point starts showing its work.
 *
 * Charts are the existing SVG components; each carries a hidden data table, so a screen reader
 * gets the series and not a description of a picture.
 *
 * **Contract gap:** this endpoint returns no product breakdown, so "top products" for the period
 * lives on `Reports/SalesDetails` and is linked rather than approximated here.
 */

import { Head, Link } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { useMemo, useState, type JSX } from 'react';

import { BarChart, LineChart, type ChartPoint } from '../../components/charts';
import { useServerQuery } from '../../components/data-table/use-server-table';
import { AppLayout } from '../../components/layout/AppLayout';
import { PeriodFilter, type PeriodValue } from '../../components/report/PeriodFilter';
import { Card, CardBody, CardHeader, EmptyState, Notice, Stat } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { date, integer } from '../../lib/format';
import { downloadCsv } from '../../lib/csv';
import { EUR, money, toDecimal } from '../../lib/money';
import { routes } from '../../lib/routes';
import { withQuery } from '../../lib/query';

import { ORDER_SOURCE_LABEL } from '../Orders/types';

import { count, type AnalyticsByDay, type OrderAnalyticsProps } from './types';

export default function OrderAnalytics({
    filters,
    totals,
    bySource,
    byDay,
}: OrderAnalyticsProps): JSX.Element {
    const t = useT();

    const query = useServerQuery({
        url: routes.reports.orderAnalytics(),
        only: ['filters', 'totals', 'bySource', 'byDay'],
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

    const orderCount = count(totals.order_count);
    const refundCount = count(totals.refund_count);
    const guests = count(totals.guests);

    /** Averages, in decimal arithmetic: a mean over thousands of rows is not a float job. */
    const averageTicket = useMemo(
        () => (orderCount === 0 ? '0' : toDecimal(totals.revenue).div(String(orderCount), 4).toString()),
        [orderCount, totals.revenue],
    );
    const perGuest = useMemo(
        () => (guests === 0 ? '0' : toDecimal(totals.revenue).div(String(guests), 4).toString()),
        [guests, totals.revenue],
    );
    const refundRate = orderCount === 0 ? 0 : Math.round((refundCount / orderCount) * 1000) / 10;

    const revenuePoints = useMemo<ChartPoint[]>(
        () =>
            byDay.map((row) => ({
                label: date(row.day),
                value: Number(toDecimal(row.revenue).toString()),
                display: money(row.revenue, EUR),
            })),
        [byDay],
    );

    const orderPoints = useMemo<ChartPoint[]>(
        () =>
            byDay.map((row) => ({
                label: date(row.day),
                value: count(row.order_count),
                display: integer(count(row.order_count)),
            })),
        [byDay],
    );

    const sourcePoints = useMemo<ChartPoint[]>(
        () =>
            bySource.map((row) => ({
                label: ORDER_SOURCE_LABEL[row.source] ?? row.source,
                value: Number(toDecimal(row.revenue).toString()),
                display: money(row.revenue, EUR),
            })),
        [bySource],
    );

    const busiest = useMemo(
        () =>
            byDay.reduce<AnalyticsByDay | null>(
                (best, row) => (best === null || count(row.order_count) > count(best.order_count) ? row : best),
                null,
            ),
        [byDay],
    );

    return (
        <AppLayout
            fullWidth
            title={t('report.orderAnalytics')}
            description={t('report.liveSourceHint')}
            actions={
                <Button variant="secondary" size="md" onClick={() => globalThis.print()}>
                    {t('action.print')}
                </Button>
            }
        >
            <Head title={t('report.orderAnalytics')} />

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

                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                    <Stat label={t('report.orders')} value={integer(orderCount)} icon="#" tone="info" />
                    <Stat label={t('report.revenue')} value={money(totals.revenue, EUR)} icon="€" tone="ok" />
                    <Stat
                        label={t('report.averageTicket')}
                        value={money(averageTicket, EUR)}
                        hint={t('report.averageTicketHint')}
                    />
                    <Stat
                        label={t('report.perGuest')}
                        value={money(perGuest, EUR)}
                        hint={t('report.guests') + ` ${integer(guests)}`}
                    />
                    <Stat
                        label={t('report.refundRate')}
                        value={`${String(refundRate).replace('.', ',')} %`}
                        tone={refundCount === 0 ? 'neutral' : 'warn'}
                        hint={`${integer(refundCount)} / ${integer(orderCount)}`}
                    />
                </div>

                <Card>
                    <CardHeader
                        title={t('report.revenueOverTime')}
                        description={
                            busiest === null
                                ? undefined
                                : t('report.busiestDay', {
                                      day: date(busiest.day),
                                      count: count(busiest.order_count),
                                  })
                        }
                        actions={
                            byDay.length === 0 ? null : (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() =>
                                        downloadCsv('analyse-commandes', byDay, [
                                            { header: t('chart.day'), value: (row) => row.day },
                                            { header: t('report.orders'), value: (row) => count(row.order_count) },
                                            { header: t('report.revenue'), value: (row) => String(row.revenue ?? '') },
                                        ])
                                    }
                                >
                                    {t('action.export')}
                                </Button>
                            )
                        }
                    />
                    <CardBody className="space-y-8">
                        <LineChart
                            title={t('report.revenueOverTime')}
                            description={t('report.revenueOverTimeDesc')}
                            data={revenuePoints}
                            categoryLabel={t('chart.day')}
                            valueLabel={t('report.revenue')}
                            height={220}
                        />

                        <BarChart
                            title={t('report.ordersOverTime')}
                            description={t('report.ordersOverTimeDesc')}
                            data={orderPoints}
                            categoryLabel={t('chart.day')}
                            valueLabel={t('report.orders')}
                            height={180}
                        />
                    </CardBody>
                </Card>

                <div className="grid gap-6 xl:grid-cols-2">
                    <Card>
                        <CardHeader title={t('report.bySource')} />
                        <CardBody>
                            {bySource.length === 0 ? (
                                <EmptyState title={t('chart.noData')} />
                            ) : (
                                <>
                                    <BarChart
                                        horizontal
                                        title={t('report.bySource')}
                                        description={t('report.bySourceDesc')}
                                        data={sourcePoints}
                                        categoryLabel={t('order.source')}
                                        valueLabel={t('report.revenue')}
                                    />

                                    <table className="mt-6 w-full border-collapse text-sm">
                                        <caption className="sr-only">{t('report.bySource')}</caption>
                                        <thead className="bg-slate-50">
                                            <tr>
                                                <th
                                                    scope="col"
                                                    className="px-3 py-2 text-start text-xs uppercase text-slate-600"
                                                >
                                                    {t('order.source')}
                                                </th>
                                                <th
                                                    scope="col"
                                                    className="px-3 py-2 text-end text-xs uppercase text-slate-600"
                                                >
                                                    {t('report.orders')}
                                                </th>
                                                <th
                                                    scope="col"
                                                    className="px-3 py-2 text-end text-xs uppercase text-slate-600"
                                                >
                                                    {t('report.revenue')}
                                                </th>
                                                <th
                                                    scope="col"
                                                    className="px-3 py-2 text-end text-xs uppercase text-slate-600"
                                                >
                                                    {t('report.averageTicket')}
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-100">
                                            {bySource.map((row) => {
                                                const rowCount = count(row.order_count);
                                                return (
                                                    <tr key={row.source}>
                                                        <td className="px-3 py-2">
                                                            {ORDER_SOURCE_LABEL[row.source] ?? row.source}
                                                        </td>
                                                        <td className="px-3 py-2 text-end tabular-nums">
                                                            {integer(rowCount)}
                                                        </td>
                                                        <td className="px-3 py-2 text-end tabular-nums">
                                                            {money(row.revenue, EUR)}
                                                        </td>
                                                        <td className="px-3 py-2 text-end tabular-nums">
                                                            {rowCount === 0
                                                                ? '—'
                                                                : money(
                                                                      toDecimal(row.revenue)
                                                                          .div(String(rowCount), 4)
                                                                          .toString(),
                                                                      EUR,
                                                                  )}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </>
                            )}
                        </CardBody>
                    </Card>

                    <Card>
                        <CardHeader title={t('report.topProducts')} />
                        <CardBody className="space-y-3">
                            <Notice tone="info">{t('report.topProductsMissing')}</Notice>
                            <Link
                                href={withQuery(routes.reports.salesDetails(), {
                                    from: filters.from,
                                    to: filters.to,
                                    config_id: filters.config_id ?? undefined,
                                })}
                                className={cn(
                                    'inline-flex min-h-touch items-center rounded-pos bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700',
                                    FOCUS_RING,
                                )}
                            >
                                {t('report.salesDetails')}
                            </Link>
                        </CardBody>
                    </Card>
                </div>

                <Notice tone="warn" title={t('report.sourceMismatchTitle')}>
                    {t('report.sourceMismatch')}
                </Notice>
            </div>
        </AppLayout>
    );
}
