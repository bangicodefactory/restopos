/**
 * `Reports/SessionReport` — `GET /reports/session?session_id=` (BOF-160…BOF-169).
 *
 * One session, end to end: the Z-report a manager signs and files. Same numbers as
 * `Sessions/Show`, laid out to be printed rather than navigated — one column, no tabs, no
 * deferred props, everything on the page at once, with a print stylesheet that drops the
 * controls.
 *
 * `session_id` is a **required** query parameter and the controller does not resolve it to a
 * model: an id that matches nothing comes back as an *empty object*, not a 404. So the page
 * checks for `session.id` and, when it is absent, says "no session selected" and offers the
 * picker rather than rendering a report full of dashes that looks like a session with no sales.
 *
 * **Contract gap:** no session list is passed to this page, so the picker is a numeric id with
 * the reason attached, alongside a link to `Sessions/Index` where the ids are.
 */

import { Head, Link, router } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { useMemo, useState, type JSX } from 'react';

import { AppLayout } from '../../components/layout/AppLayout';
import {
    Badge,
    Card,
    CardBody,
    CardHeader,
    DefinitionList,
    EmptyState,
    Notice,
    Stat,
} from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { date, dateTime, integer } from '../../lib/format';
import { EUR, money, percent, quantity, signOf, sumMoney } from '../../lib/money';
import { routes } from '../../lib/routes';
import { withQuery } from '../../lib/query';

import { count, truthy, type SessionReportProps } from './types';

const TH = 'px-3 py-2 text-start text-xs font-semibold uppercase tracking-wide text-slate-600';
const TD = 'px-3 py-2';

export default function SessionReport({
    session,
    paymentTotals,
    salesSummaries,
    taxSummaries,
    cashMovements,
}: SessionReportProps): JSX.Element {
    const t = useT();
    const [sessionId, setSessionId] = useState(session.id === undefined ? '' : String(session.id));

    const found = session.id !== undefined;

    const salesTotals = useMemo(
        () => ({
            base: sumMoney(salesSummaries.map((row) => row.base_amount)),
            tax: sumMoney(salesSummaries.map((row) => row.tax_amount)),
            total: sumMoney(salesSummaries.map((row) => row.total_amount)),
            discount: sumMoney(salesSummaries.map((row) => row.discount_amount)),
        }),
        [salesSummaries],
    );

    return (
        <AppLayout
            title={t('report.sessionReport')}
            description={found ? session.name : t('report.noSession')}
            actions={
                found ? (
                    <Button variant="secondary" size="md" onClick={() => globalThis.print()}>
                        {t('action.print')}
                    </Button>
                ) : null
            }
        >
            <Head title={t('report.sessionReport')} />

            <div className="space-y-6">
                <div className="rounded-pos-lg bg-white p-4 shadow-pos ring-1 ring-slate-200 print:hidden">
                    <div className="flex flex-wrap items-end gap-3">
                        <label
                            className="flex flex-col gap-1 text-xs font-medium text-slate-600"
                            htmlFor="report-session-id"
                        >
                            {t('report.selectSession')}
                            <input
                                id="report-session-id"
                                type="number"
                                inputMode="numeric"
                                min={1}
                                placeholder="id"
                                value={sessionId}
                                onChange={(event) => setSessionId(event.target.value)}
                                className={cn(
                                    'min-h-touch w-32 rounded-pos bg-white px-3 text-sm tabular-nums ring-1 ring-inset ring-slate-300',
                                    FOCUS_RING,
                                )}
                            />
                        </label>

                        <Button
                            size="md"
                            disabled={sessionId.trim() === ''}
                            onClick={() =>
                                router.get(
                                    withQuery(routes.reports.session(), { session_id: sessionId.trim() }),
                                    {},
                                    { preserveState: true, preserveScroll: true },
                                )
                            }
                        >
                            {t('action.apply')}
                        </Button>

                        <Link
                            href={routes.sessions.index()}
                            className={cn('rounded-pos px-2 py-1 text-sm text-brand-700 hover:underline', FOCUS_RING)}
                        >
                            {t('session.title')}
                        </Link>
                    </div>

                    <p className="mt-2 text-xs text-slate-500">{t('report.sessionIdHint')}</p>
                </div>

                {!found ? (
                    <Card>
                        <EmptyState title={t('report.noSession')} hint={t('report.sessionIdHint')} />
                    </Card>
                ) : (
                    <>
                        <Card>
                            <CardHeader
                                title={session.name ?? `#${session.id}`}
                                description={`${t('report.config')} #${session.pos_config_id ?? '?'}`}
                                actions={
                                    <>
                                        <Badge>{session.state ?? '—'}</Badge>
                                        {truthy(session.is_rescue) ? (
                                            <Badge tone="danger">{t('session.rescue')}</Badge>
                                        ) : null}
                                        {truthy(session.closing_forced) ? (
                                            <Badge tone="warn">{t('session.forced')}</Badge>
                                        ) : null}
                                        <Link
                                            href={routes.sessions.show(session.id ?? 0)}
                                            className={cn(
                                                'rounded-pos px-2 py-1 text-sm text-brand-700 hover:underline print:hidden',
                                                FOCUS_RING,
                                            )}
                                        >
                                            {t('action.details')}
                                        </Link>
                                    </>
                                }
                            />
                            <CardBody>
                                <DefinitionList
                                    columns={3}
                                    items={[
                                        { label: t('session.businessDate'), value: date(session.business_date) },
                                        { label: t('session.openedAt'), value: dateTime(session.opened_at) },
                                        { label: t('session.closedAt'), value: dateTime(session.closed_at) },
                                        { label: t('report.orders'), value: integer(session.order_count ?? 0) },
                                        {
                                            label: t('report.revenue'),
                                            value: money(session.order_amount_total, EUR),
                                        },
                                        {
                                            label: t('report.refunds'),
                                            value: money(session.refund_amount_total, EUR),
                                        },
                                        ...(session.closing_notes
                                            ? [
                                                  {
                                                      label: t('session.closeNotes'),
                                                      value: session.closing_notes,
                                                      wide: true,
                                                  },
                                              ]
                                            : []),
                                    ]}
                                />
                            </CardBody>
                        </Card>

                        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                            <Stat label={t('session.opening')} value={money(session.cash_balance_opening, EUR)} />
                            <Stat
                                label={t('session.expected')}
                                value={money(session.cash_balance_closing_expected, EUR)}
                            />
                            <Stat
                                label={t('session.counted')}
                                value={
                                    session.cash_balance_closing_counted === null ||
                                    session.cash_balance_closing_counted === undefined
                                        ? '—'
                                        : money(session.cash_balance_closing_counted, EUR)
                                }
                            />
                            <Stat
                                label={t('session.difference')}
                                value={money(session.cash_difference, EUR)}
                                tone={signOf(session.cash_difference ?? '0') === 0 ? 'ok' : 'danger'}
                            />
                        </div>

                        <Card>
                            <CardHeader title={t('session.paymentTotals')} />
                            <CardBody className="p-0">
                                {paymentTotals.length === 0 ? (
                                    <EmptyState title={t('state.empty')} />
                                ) : (
                                    <table className="w-full border-collapse text-sm">
                                        <caption className="sr-only">{t('session.paymentTotals')}</caption>
                                        <thead className="bg-slate-50">
                                            <tr>
                                                <th scope="col" className={TH}>
                                                    {t('payment.title')}
                                                </th>
                                                <th scope="col" className={cn(TH, 'text-end')}>
                                                    {t('report.orders')}
                                                </th>
                                                <th scope="col" className={cn(TH, 'text-end')}>
                                                    {t('report.expected')}
                                                </th>
                                                <th scope="col" className={cn(TH, 'text-end')}>
                                                    {t('session.counted')}
                                                </th>
                                                <th scope="col" className={cn(TH, 'text-end')}>
                                                    {t('report.difference')}
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-100">
                                            {paymentTotals.map((row) => (
                                                <tr key={row.id}>
                                                    <td className={TD}>
                                                        #{row.payment_method_id}
                                                        {row.ledger_code ? (
                                                            <span className="ms-2 font-mono text-xs text-slate-500">
                                                                {row.ledger_code}
                                                            </span>
                                                        ) : null}
                                                    </td>
                                                    <td className={cn(TD, 'text-end tabular-nums')}>
                                                        {integer(count(row.payment_count))}
                                                    </td>
                                                    <td className={cn(TD, 'text-end tabular-nums')}>
                                                        {money(row.expected_amount, EUR)}
                                                    </td>
                                                    <td className={cn(TD, 'text-end tabular-nums')}>
                                                        {row.counted_amount === null ? '—' : money(row.counted_amount, EUR)}
                                                    </td>
                                                    <td className={cn(TD, 'text-end tabular-nums')}>
                                                        {money(row.difference_amount, EUR)}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                        <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                                            <tr>
                                                <td className={TD} colSpan={2}>
                                                    {t('report.total')}
                                                </td>
                                                <td className={cn(TD, 'text-end tabular-nums')}>
                                                    {money(
                                                        sumMoney(paymentTotals.map((row) => row.expected_amount)),
                                                        EUR,
                                                    )}
                                                </td>
                                                <td className={cn(TD, 'text-end tabular-nums')}>
                                                    {money(
                                                        sumMoney(paymentTotals.map((row) => row.counted_amount)),
                                                        EUR,
                                                    )}
                                                </td>
                                                <td className={cn(TD, 'text-end tabular-nums')}>
                                                    {money(
                                                        sumMoney(paymentTotals.map((row) => row.difference_amount)),
                                                        EUR,
                                                    )}
                                                </td>
                                            </tr>
                                        </tfoot>
                                    </table>
                                )}
                            </CardBody>
                        </Card>

                        <Card>
                            <CardHeader
                                title={t('session.taxSummary')}
                                description={t('report.taxFrozenHint')}
                            />
                            <CardBody className="p-0">
                                {taxSummaries.length === 0 ? (
                                    <EmptyState title={t('state.empty')} />
                                ) : (
                                    <table className="w-full border-collapse text-sm">
                                        <caption className="sr-only">{t('session.taxSummary')}</caption>
                                        <thead className="bg-slate-50">
                                            <tr>
                                                <th scope="col" className={TH}>
                                                    {t('nav.taxes')}
                                                </th>
                                                <th scope="col" className={cn(TH, 'text-end')}>
                                                    Taux
                                                </th>
                                                <th scope="col" className={cn(TH, 'text-end')}>
                                                    {t('report.base')}
                                                </th>
                                                <th scope="col" className={cn(TH, 'text-end')}>
                                                    {t('report.taxAmount')}
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-100">
                                            {taxSummaries.map((row) => (
                                                <tr key={row.id}>
                                                    <td className={TD}>
                                                        #{row.tax_id}
                                                        {truthy(row.is_refund) ? (
                                                            <Badge tone="danger" className="ms-2">
                                                                {t('report.refunds')}
                                                            </Badge>
                                                        ) : null}
                                                    </td>
                                                    <td className={cn(TD, 'text-end tabular-nums')}>
                                                        {percent(row.tax_rate)}
                                                    </td>
                                                    <td className={cn(TD, 'text-end tabular-nums')}>
                                                        {money(row.base_amount, EUR)}
                                                    </td>
                                                    <td className={cn(TD, 'text-end tabular-nums')}>
                                                        {money(row.tax_amount, EUR)}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                        <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                                            <tr>
                                                <td className={TD} colSpan={2}>
                                                    {t('report.total')}
                                                </td>
                                                <td className={cn(TD, 'text-end tabular-nums')}>
                                                    {money(sumMoney(taxSummaries.map((row) => row.base_amount)), EUR)}
                                                </td>
                                                <td className={cn(TD, 'text-end tabular-nums')}>
                                                    {money(sumMoney(taxSummaries.map((row) => row.tax_amount)), EUR)}
                                                </td>
                                            </tr>
                                        </tfoot>
                                    </table>
                                )}
                            </CardBody>
                        </Card>

                        <Card>
                            <CardHeader
                                title={t('session.salesSummary')}
                                description={`${t('order.discount')} ${money(salesTotals.discount, EUR)}`}
                            />
                            <CardBody className="p-0">
                                {salesSummaries.length === 0 ? (
                                    <EmptyState title={t('state.empty')} />
                                ) : (
                                    <table className="w-full border-collapse text-sm">
                                        <caption className="sr-only">{t('session.salesSummary')}</caption>
                                        <thead className="bg-slate-50">
                                            <tr>
                                                <th scope="col" className={TH}>
                                                    {t('nav.products')}
                                                </th>
                                                <th scope="col" className={TH}>
                                                    {t('product.categories')}
                                                </th>
                                                <th scope="col" className={cn(TH, 'text-end')}>
                                                    {t('report.quantity')}
                                                </th>
                                                <th scope="col" className={cn(TH, 'text-end')}>
                                                    {t('report.base')}
                                                </th>
                                                <th scope="col" className={cn(TH, 'text-end')}>
                                                    {t('report.taxAmount')}
                                                </th>
                                                <th scope="col" className={cn(TH, 'text-end')}>
                                                    {t('report.total')}
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-100">
                                            {salesSummaries.map((row) => (
                                                <tr key={row.id}>
                                                    <td className={TD}>
                                                        {row.product_id === null ? '—' : `#${row.product_id}`}
                                                        {truthy(row.is_refund) ? (
                                                            <Badge tone="danger" className="ms-2">
                                                                {t('report.refunds')}
                                                            </Badge>
                                                        ) : null}
                                                    </td>
                                                    <td className={TD}>
                                                        {row.pos_category_id === null ? '—' : `#${row.pos_category_id}`}
                                                    </td>
                                                    <td className={cn(TD, 'text-end tabular-nums')}>
                                                        {quantity(row.quantity)}
                                                    </td>
                                                    <td className={cn(TD, 'text-end tabular-nums')}>
                                                        {money(row.base_amount, EUR)}
                                                    </td>
                                                    <td className={cn(TD, 'text-end tabular-nums')}>
                                                        {money(row.tax_amount, EUR)}
                                                    </td>
                                                    <td className={cn(TD, 'text-end font-semibold tabular-nums')}>
                                                        {money(row.total_amount, EUR)}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                        <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                                            <tr>
                                                <td className={TD} colSpan={3}>
                                                    {t('report.total')}
                                                </td>
                                                <td className={cn(TD, 'text-end tabular-nums')}>
                                                    {money(salesTotals.base, EUR)}
                                                </td>
                                                <td className={cn(TD, 'text-end tabular-nums')}>
                                                    {money(salesTotals.tax, EUR)}
                                                </td>
                                                <td className={cn(TD, 'text-end tabular-nums')}>
                                                    {money(salesTotals.total, EUR)}
                                                </td>
                                            </tr>
                                        </tfoot>
                                    </table>
                                )}
                            </CardBody>
                        </Card>

                        <Card>
                            <CardHeader title={t('session.movements')} />
                            <CardBody className="p-0">
                                {cashMovements.length === 0 ? (
                                    <EmptyState title={t('session.movementsEmpty')} />
                                ) : (
                                    <table className="w-full border-collapse text-sm">
                                        <caption className="sr-only">{t('session.movements')}</caption>
                                        <thead className="bg-slate-50">
                                            <tr>
                                                <th scope="col" className={TH}>
                                                    {t('report.period')}
                                                </th>
                                                <th scope="col" className={TH}>
                                                    {t('device.type')}
                                                </th>
                                                <th scope="col" className={TH}>
                                                    Motif
                                                </th>
                                                <th scope="col" className={cn(TH, 'text-end')}>
                                                    {t('report.total')}
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-100">
                                            {cashMovements.map((row) => (
                                                <tr key={row.id}>
                                                    <td className={cn(TD, 'tabular-nums')}>{dateTime(row.moved_at)}</td>
                                                    <td className={TD}>{row.movement_type}</td>
                                                    <td className={cn(TD, 'text-slate-600')}>{row.reason ?? '—'}</td>
                                                    <td className={cn(TD, 'text-end tabular-nums')}>
                                                        {money(row.amount, EUR)}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                )}
                            </CardBody>
                        </Card>

                        <Notice tone="info" className="print:hidden">
                            {t('session.frozenHint')}
                        </Notice>
                    </>
                )}
            </div>
        </AppLayout>
    );
}
