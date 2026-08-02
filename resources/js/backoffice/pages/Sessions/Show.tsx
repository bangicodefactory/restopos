/**
 * `Sessions/Show` — `GET /sessions/{session}` (BOF-141…BOF-159).
 *
 * The Z-report a manager signs, plus the force-close control.
 *
 * **Where each number comes from is the whole point of this screen**, so it is stated on it. A
 * *closed* session reads the frozen tables (`session_payment_totals`, `session_sales_summaries`,
 * `session_tax_summaries`) and its own frozen columns; it must render identically forever, even
 * after a later correction to one of its orders. An *open* session has no frozen tables yet, so
 * the cash strip reads `closingData`, the live projection the closing popup uses. Mixing the two
 * silently is how a report drifts from the ledger, so the source is labelled rather than assumed.
 *
 * The cash chain is shown as an equation, left to right, because that is how it is checked in
 * real life: opening + cash sales + cash in − cash out = expected, expected vs counted =
 * difference. Every term is a stored decimal string; the one derived value (cash sales) is
 * computed with `@domain/money`, never with a float.
 *
 * **Contract gaps, surfaced not faked:** `session_cash_counts` / `session_cash_count_lines` are
 * not passed to this page, so the denomination breakdown cannot be rendered; and the session's
 * orders are not passed either, and `GET /orders` accepts no `session_id` filter, so there is no
 * honest link to a filtered order list. Both say so in place.
 */

import { Head, useForm } from '@inertiajs/react';
import { Button, cn } from '@shared/ui';
import { useMemo, useState, type JSX, type ReactNode } from 'react';

import { AppLayout } from '../../components/layout/AppLayout';
import { MoneyField, TextareaField } from '../../components/form/fields';
import { ConfirmAction } from '../../components/ui/ConfirmAction';
import { Tabs, type TabItem } from '../../components/ui/Tabs';
import {
    Badge,
    Card,
    CardBody,
    CardHeader,
    DeferredRegion,
    DefinitionList,
    EmptyState,
    Notice,
    Stat,
} from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { date, dateTime, integer } from '../../lib/format';
import { EUR, money, percent, quantity, signOf, subtractMoney, sumMoney, toDecimal } from '../../lib/money';
import { routes } from '../../lib/routes';

import {
    MOVEMENT_LABEL,
    SESSION_STATE_TONE,
    type CashMovementRow,
    type SessionPaymentTotal,
    type SessionRecord,
    type SessionSalesSummary,
    type SessionShowProps,
    type SessionTaxSummary,
} from './types';

const TH = 'px-3 py-2 text-start text-xs font-semibold uppercase tracking-wide text-slate-600';
const TD = 'px-3 py-2 align-top';

export default function SessionShow({
    session,
    paymentTotals,
    salesSummaries,
    taxSummaries,
    cashMovements,
    closingData,
    can,
}: SessionShowProps): JSX.Element {
    const t = useT();
    const [tab, setTab] = useState('cash');

    const closed = session.state === 'closed';
    const title = t('session.detail', { name: session.name });

    /**
     * Cash sales are not stored — they are what is left of the expected drawer once the opening
     * float and the manual movements are taken out. `expectedCash` is
     * `opening + cash sales + Σ movements` (SessionService::expectedCash), and movements are
     * **signed** in the schema (in = +, out = −), so both totals subtract here and only the
     * *display* of the out term flips to a positive number behind a minus sign. Derived from
     * decimal strings throughout; no float ever touches a drawer figure.
     */
    const openingBalance = closingData?.opening_balance ?? session.cash_balance_opening;
    const cashIn = closingData?.cash_in ?? session.cash_in_total;
    const cashOut = closingData?.cash_out ?? session.cash_out_total;
    const expectedCash = closingData?.expected_cash ?? session.cash_balance_closing_expected;
    const cashSales = useMemo(
        () => subtractMoney(expectedCash, sumMoney([openingBalance, cashIn, cashOut])),
        [cashIn, cashOut, expectedCash, openingBalance],
    );

    const tabs: TabItem[] = [
        { id: 'cash', label: t('session.cashControl') },
        { id: 'payments', label: t('session.paymentTotals'), badge: <Badge>{paymentTotals.length}</Badge> },
        { id: 'sales', label: t('session.salesSummary') },
        { id: 'taxes', label: t('session.taxSummary') },
        { id: 'movements', label: t('session.movements') },
        { id: 'closing', label: t('session.closingReview') },
    ];

    return (
        <AppLayout
            title={title}
            description={closed ? t('session.frozenHint') : t('session.liveHint')}
            breadcrumbs={[{ label: t('session.title'), href: routes.sessions.index() }]}
            actions={
                <>
                    <Badge tone={SESSION_STATE_TONE[session.state] ?? 'neutral'}>{session.state}</Badge>
                    {session.is_rescue ? <Badge tone="danger">{t('session.rescue')}</Badge> : null}
                    {session.closing_forced ? <Badge tone="warn">{t('session.forced')}</Badge> : null}
                    <Button variant="secondary" size="md" onClick={() => globalThis.print()}>
                        {t('action.print')}
                    </Button>
                </>
            }
        >
            <Head title={title} />

            <div className="space-y-6">
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <Stat label={t('session.orders')} value={integer(session.order_count)} icon="#" tone="info" />
                    <Stat label={t('report.revenue')} value={money(session.order_amount_total, EUR)} icon="€" tone="ok" />
                    <Stat label={t('report.refunds')} value={money(session.refund_amount_total, EUR)} tone="warn" />
                    <Stat
                        label={t('session.difference')}
                        value={money(session.cash_difference, EUR)}
                        tone={signOf(session.cash_difference) === 0 ? 'neutral' : 'danger'}
                        hint={closed ? undefined : t('session.differencePending')}
                    />
                </div>

                <SessionHeader session={session} />

                <Card>
                    <CardBody>
                        <Tabs items={tabs} active={tab} onChange={setTab} label={title}>
                            {tab === 'cash' ? (
                                <CashControl
                                    session={session}
                                    openingBalance={openingBalance}
                                    cashSales={cashSales}
                                    cashIn={cashIn}
                                    cashOut={cashOut}
                                    expectedCash={expectedCash}
                                    live={closingData !== null}
                                />
                            ) : null}

                            {tab === 'payments' ? (
                                <PaymentTotals
                                    totals={paymentTotals}
                                    names={nameLookup(closingData)}
                                    cashFlags={cashLookup(closingData)}
                                />
                            ) : null}

                            {tab === 'sales' ? (
                                <DeferredRegion value={salesSummaries} label={t('session.salesSummary')} rows={4}>
                                    {(rows) => <SalesSummaries rows={rows} />}
                                </DeferredRegion>
                            ) : null}

                            {tab === 'taxes' ? (
                                <DeferredRegion value={taxSummaries} label={t('session.taxSummary')} rows={3}>
                                    {(rows) => <TaxSummaries rows={rows} />}
                                </DeferredRegion>
                            ) : null}

                            {tab === 'movements' ? (
                                <DeferredRegion value={cashMovements} label={t('session.movements')} rows={3}>
                                    {(rows) => <Movements rows={rows} />}
                                </DeferredRegion>
                            ) : null}

                            {tab === 'closing' ? (
                                <ClosingReview
                                    session={session}
                                    closingData={closingData}
                                    expectedCash={expectedCash}
                                    canClose={can.close}
                                />
                            ) : null}
                        </Tabs>
                    </CardBody>
                </Card>
            </div>
        </AppLayout>
    );
}

function nameLookup(closingData: SessionShowProps['closingData']): Map<number, string> {
    return new Map((closingData?.payment_totals ?? []).map((row) => [row.payment_method_id, row.name]));
}

function cashLookup(closingData: SessionShowProps['closingData']): Map<number, boolean> {
    return new Map((closingData?.payment_totals ?? []).map((row) => [row.payment_method_id, row.is_cash_count]));
}

// ───────────────────────────────────────────────────────────── header

function SessionHeader({ session }: { session: SessionRecord }): JSX.Element {
    const t = useT();

    return (
        <Card>
            <CardHeader title={session.name} description={`${t('report.config')} #${session.pos_config_id}`} />
            <CardBody>
                <DefinitionList
                    columns={3}
                    items={[
                        { label: t('session.businessDate'), value: date(session.business_date) },
                        { label: t('session.openedAt'), value: dateTime(session.opened_at) },
                        { label: t('session.closedAt'), value: dateTime(session.closed_at) },
                        { label: t('session.openedBy'), value: session.opened_by_employee_id ?? session.opened_by_user_id ?? '—' },
                        { label: t('session.closedBy'), value: session.closed_by_employee_id ?? session.closed_by_user_id ?? '—' },
                        { label: t('payment.cashCount'), value: session.has_cash_control ? t('state.yes') : t('state.no') },
                        { label: t('session.export'), value: dateTime(session.accounting_exported_at) },
                        ...(session.rescued_from_session_id !== null
                            ? [{ label: t('session.rescue'), value: `#${session.rescued_from_session_id}` }]
                            : []),
                        ...(session.opening_notes
                            ? [{ label: t('session.opening'), value: session.opening_notes, wide: true }]
                            : []),
                        ...(session.closing_notes
                            ? [{ label: t('session.closeNotes'), value: session.closing_notes, wide: true }]
                            : []),
                        ...(session.closing_force_reason
                            ? [{ label: t('session.forced'), value: session.closing_force_reason, wide: true }]
                            : []),
                    ]}
                />
            </CardBody>
        </Card>
    );
}

// ───────────────────────────────────────────────────────────── cash control

function CashControl({
    session,
    openingBalance,
    cashSales,
    cashIn,
    cashOut,
    expectedCash,
    live,
}: {
    session: SessionRecord;
    openingBalance: string;
    cashSales: string;
    cashIn: string;
    cashOut: string;
    expectedCash: string;
    live: boolean;
}): JSX.Element {
    const t = useT();
    const counted = session.cash_balance_closing_counted;

    return (
        <div className="space-y-5">
            <Notice tone={live ? 'warn' : 'info'}>
                {live ? t('session.liveSource') : t('session.frozenSource')}
            </Notice>

            <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <CashTerm label={t('session.opening')} amount={openingBalance} />
                <CashTerm label={t('session.cashSales')} amount={cashSales} operator="+" />
                <CashTerm label={t('session.cashIn')} amount={toDecimal(cashIn).abs().toString()} operator="+" />
                <CashTerm label={t('session.cashOut')} amount={toDecimal(cashOut).abs().toString()} operator="−" />
                <CashTerm label={t('session.expected')} amount={expectedCash} operator="=" emphasis />
            </ol>

            <div className="grid gap-4 sm:grid-cols-3">
                <Stat label={t('session.expected')} value={money(expectedCash, EUR)} />
                <Stat
                    label={t('session.counted')}
                    value={counted === null ? '—' : money(counted, EUR)}
                    hint={counted === null ? t('session.notCountedYet') : undefined}
                />
                <Stat
                    label={t('session.difference')}
                    value={money(session.cash_difference, EUR)}
                    tone={signOf(session.cash_difference) === 0 ? 'ok' : 'danger'}
                />
            </div>

            <Notice tone="info" title={t('session.denominations')}>
                {t('session.denominationsMissing')}
            </Notice>
        </div>
    );
}

function CashTerm({
    label,
    amount,
    operator,
    emphasis = false,
}: {
    label: string;
    amount: string;
    operator?: string;
    emphasis?: boolean;
}): JSX.Element {
    return (
        <li
            className={cn(
                'rounded-pos p-3 ring-1 ring-inset',
                emphasis ? 'bg-brand-50 ring-brand-200' : 'bg-slate-50 ring-slate-200',
            )}
        >
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                {operator ? (
                    <span aria-hidden className="text-base font-bold text-slate-400">
                        {operator}
                    </span>
                ) : null}
                {label}
            </div>
            <div className="mt-1 text-lg font-bold tabular-nums text-slate-900">{money(amount, EUR)}</div>
        </li>
    );
}

// ───────────────────────────────────────────────────────────── payment totals

function PaymentTotals({
    totals,
    names,
    cashFlags,
}: {
    totals: SessionPaymentTotal[];
    names: Map<number, string>;
    cashFlags: Map<number, boolean>;
}): JSX.Element {
    const t = useT();

    if (totals.length === 0) return <EmptyState title={t('state.empty')} hint={t('session.paymentTotalsEmpty')} />;

    return (
        <div className="overflow-x-auto">
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
                        <th scope="col" className={cn(TH, 'text-end')}>
                            {t('report.refunds')}
                        </th>
                        <th scope="col" className={cn(TH, 'text-end')}>
                            {t('order.change')}
                        </th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                    {totals.map((row) => (
                        <tr key={row.id}>
                            <td className={TD}>
                                <span className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium">
                                        {names.get(row.payment_method_id) ?? `#${row.payment_method_id}`}
                                    </span>
                                    {cashFlags.get(row.payment_method_id) === true ? (
                                        <Badge tone="brand">{t('payment.cashCount')}</Badge>
                                    ) : null}
                                    {row.ledger_code ? (
                                        <span className="font-mono text-xs text-slate-500">{row.ledger_code}</span>
                                    ) : null}
                                </span>
                            </td>
                            <td className={cn(TD, 'text-end tabular-nums')}>{integer(row.payment_count)}</td>
                            <td className={cn(TD, 'text-end tabular-nums')}>{money(row.expected_amount, EUR)}</td>
                            <td className={cn(TD, 'text-end tabular-nums')}>
                                {row.counted_amount === null ? '—' : money(row.counted_amount, EUR)}
                            </td>
                            <td
                                className={cn(
                                    TD,
                                    'text-end font-semibold tabular-nums',
                                    signOf(row.difference_amount) === 0 ? 'text-slate-400' : 'text-danger',
                                )}
                            >
                                {money(row.difference_amount, EUR)}
                            </td>
                            <td className={cn(TD, 'text-end tabular-nums')}>{money(row.refund_amount, EUR)}</td>
                            <td className={cn(TD, 'text-end tabular-nums')}>{money(row.change_amount, EUR)}</td>
                        </tr>
                    ))}
                </tbody>
                <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                    <tr>
                        <td className={TD}>{t('report.total')}</td>
                        <td className={cn(TD, 'text-end tabular-nums')}>
                            {integer(totals.reduce((sum, row) => sum + row.payment_count, 0))}
                        </td>
                        <td className={cn(TD, 'text-end tabular-nums')}>
                            {money(sumMoney(totals.map((row) => row.expected_amount)), EUR)}
                        </td>
                        <td className={cn(TD, 'text-end tabular-nums')}>
                            {money(sumMoney(totals.map((row) => row.counted_amount)), EUR)}
                        </td>
                        <td className={cn(TD, 'text-end tabular-nums')}>
                            {money(sumMoney(totals.map((row) => row.difference_amount)), EUR)}
                        </td>
                        <td className={cn(TD, 'text-end tabular-nums')}>
                            {money(sumMoney(totals.map((row) => row.refund_amount)), EUR)}
                        </td>
                        <td className={cn(TD, 'text-end tabular-nums')}>
                            {money(sumMoney(totals.map((row) => row.change_amount)), EUR)}
                        </td>
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}

// ───────────────────────────────────────────────────────────── frozen sales

function SalesSummaries({ rows }: { rows: SessionSalesSummary[] }): JSX.Element {
    const t = useT();

    if (rows.length === 0) return <EmptyState title={t('state.empty')} hint={t('session.frozenEmpty')} />;

    return (
        <div className="overflow-x-auto">
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
                        <th scope="col" className={cn(TH, 'text-end')}>
                            {t('report.cost')}
                        </th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                    {rows.map((row) => (
                        <tr key={row.id} className={cn(truthy(row.is_refund) && 'bg-danger-soft/30')}>
                            <td className={TD}>
                                {row.product_id === null ? '—' : `#${row.product_id}`}
                                {truthy(row.is_refund) ? (
                                    <Badge tone="danger" className="ms-2">
                                        {t('report.refunds')}
                                    </Badge>
                                ) : null}
                            </td>
                            <td className={TD}>{row.pos_category_id === null ? '—' : `#${row.pos_category_id}`}</td>
                            <td className={cn(TD, 'text-end tabular-nums')}>{quantity(row.quantity)}</td>
                            <td className={cn(TD, 'text-end tabular-nums')}>{money(row.base_amount, EUR)}</td>
                            <td className={cn(TD, 'text-end tabular-nums')}>{money(row.tax_amount, EUR)}</td>
                            <td className={cn(TD, 'text-end font-semibold tabular-nums')}>
                                {money(row.total_amount, EUR)}
                            </td>
                            <td className={cn(TD, 'text-end tabular-nums text-slate-600')}>
                                {money(row.cost_amount, EUR)}
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
                            {money(sumMoney(rows.map((row) => row.base_amount)), EUR)}
                        </td>
                        <td className={cn(TD, 'text-end tabular-nums')}>
                            {money(sumMoney(rows.map((row) => row.tax_amount)), EUR)}
                        </td>
                        <td className={cn(TD, 'text-end tabular-nums')}>
                            {money(sumMoney(rows.map((row) => row.total_amount)), EUR)}
                        </td>
                        <td className={cn(TD, 'text-end tabular-nums')}>
                            {money(sumMoney(rows.map((row) => row.cost_amount)), EUR)}
                        </td>
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}

function TaxSummaries({ rows }: { rows: SessionTaxSummary[] }): JSX.Element {
    const t = useT();

    if (rows.length === 0) return <EmptyState title={t('state.empty')} hint={t('session.frozenEmpty')} />;

    return (
        <div className="overflow-x-auto">
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
                    {rows.map((row) => (
                        <tr key={row.id}>
                            <td className={TD}>
                                #{row.tax_id}
                                <span className="ms-2 text-xs text-slate-500">{t('tax.groups')} #{row.tax_group_id}</span>
                                {truthy(row.is_refund) ? (
                                    <Badge tone="danger" className="ms-2">
                                        {t('report.refunds')}
                                    </Badge>
                                ) : null}
                            </td>
                            <td className={cn(TD, 'text-end tabular-nums')}>{percent(row.tax_rate)}</td>
                            <td className={cn(TD, 'text-end tabular-nums')}>{money(row.base_amount, EUR)}</td>
                            <td className={cn(TD, 'text-end font-semibold tabular-nums')}>
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
                            {money(sumMoney(rows.map((row) => row.base_amount)), EUR)}
                        </td>
                        <td className={cn(TD, 'text-end tabular-nums')}>
                            {money(sumMoney(rows.map((row) => row.tax_amount)), EUR)}
                        </td>
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}

function Movements({ rows }: { rows: CashMovementRow[] }): JSX.Element {
    const t = useT();

    if (rows.length === 0) return <EmptyState title={t('session.movementsEmpty')} />;

    return (
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
                {rows.map((row) => (
                    <tr key={row.id}>
                        <td className={cn(TD, 'tabular-nums')}>{dateTime(row.moved_at)}</td>
                        <td className={TD}>
                            <Badge tone={signOf(row.amount) < 0 ? 'warn' : 'ok'}>
                                {MOVEMENT_LABEL[row.movement_type] ?? row.movement_type}
                            </Badge>
                        </td>
                        <td className={cn(TD, 'text-slate-600')}>{row.reason ?? '—'}</td>
                        <td
                            className={cn(
                                TD,
                                'text-end font-semibold tabular-nums',
                                signOf(row.amount) < 0 ? 'text-danger' : 'text-ok-fg',
                            )}
                        >
                            {money(row.amount, EUR)}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

// ───────────────────────────────────────────────────────────── closing review

function ClosingReview({
    session,
    closingData,
    expectedCash,
    canClose,
}: {
    session: SessionRecord;
    closingData: SessionShowProps['closingData'];
    expectedCash: string;
    canClose: boolean;
}): JSX.Element {
    const t = useT();
    const closed = session.state === 'closed';

    const form = useForm<{ counted_cash: string; notes: string }>({
        counted_cash: expectedCash,
        notes: '',
    });

    const difference = subtractMoney(form.data.counted_cash, expectedCash);
    const overThreshold =
        closingData?.enforces_maximum_difference === true &&
        toDecimal(difference).abs().gt(toDecimal(closingData.amount_authorized_diff));

    if (closed) {
        return (
            <div className="space-y-4">
                <Notice tone="ok" title={t('session.closedTitle')}>
                    {t('session.frozenHint')}
                </Notice>
                <DefinitionList
                    columns={3}
                    items={[
                        { label: t('session.expected'), value: money(session.cash_balance_closing_expected, EUR) },
                        {
                            label: t('session.counted'),
                            value: money(session.cash_balance_closing_counted, EUR),
                        },
                        { label: t('session.difference'), value: money(session.cash_difference, EUR) },
                        { label: t('session.closedAt'), value: dateTime(session.closed_at) },
                        { label: t('report.orders'), value: integer(session.order_count) },
                        { label: t('report.total'), value: money(session.payments_total, EUR) },
                    ]}
                />
            </div>
        );
    }

    return (
        <div className="space-y-5">
            <Notice tone="warn" title={t('session.close')}>
                {t('session.closeWarning')}
            </Notice>

            {closingData !== null && closingData.draft_order_count > 0 ? (
                <Notice tone="danger" title={t('session.drafts')}>
                    {t('session.draftsBlock', { count: closingData.draft_order_count })}
                </Notice>
            ) : null}

            <div className="grid gap-6 lg:grid-cols-2">
                <div className="space-y-4">
                    <MoneyField
                        label={t('session.countedCash')}
                        hint={`${t('session.expected')} ${money(expectedCash, EUR)}`}
                        value={form.data.counted_cash}
                        error={form.errors.counted_cash}
                        onChange={(value) => form.setData('counted_cash', value)}
                    />

                    <TextareaField
                        label={t('session.closeNotes')}
                        rows={3}
                        value={form.data.notes}
                        error={form.errors.notes}
                        onChange={(value) => form.setData('notes', value)}
                    />
                </div>

                <div className="space-y-4">
                    <Stat
                        label={t('session.difference')}
                        value={money(difference, EUR)}
                        tone={signOf(difference) === 0 ? 'ok' : overThreshold ? 'danger' : 'warn'}
                        hint={
                            closingData?.enforces_maximum_difference === true
                                ? t('session.authorizedDiff', {
                                      amount: money(closingData.amount_authorized_diff, EUR),
                                  })
                                : undefined
                        }
                    />

                    {overThreshold ? <Notice tone="danger">{t('session.overThreshold')}</Notice> : null}

                    <ConfirmAction
                        label={t('session.close')}
                        title={t('session.close')}
                        message={
                            <ClosingConfirmation
                                expected={expectedCash}
                                counted={form.data.counted_cash}
                                difference={difference}
                            />
                        }
                        confirmPhrase={session.name}
                        disabled={!canClose}
                        busy={form.processing}
                        onConfirm={() =>
                            form.post(routes.sessions.close(session.uuid), { preserveScroll: true })
                        }
                    />

                    {canClose ? null : <Notice tone="info">{t('session.closeForbidden')}</Notice>}
                </div>
            </div>
        </div>
    );
}

function ClosingConfirmation({
    expected,
    counted,
    difference,
}: {
    expected: string;
    counted: string;
    difference: string;
}): ReactNode {
    const t = useT();
    return (
        <div className="space-y-1 text-sm">
            <p>{t('session.closeWarning')}</p>
            <p className="tabular-nums">
                {t('session.expected')} {money(expected, EUR)} · {t('session.counted')} {money(counted, EUR)} ·{' '}
                {t('session.difference')} <strong>{money(difference, EUR)}</strong>
            </p>
        </div>
    );
}

/** SQLite hands booleans back as 0/1 through the raw query builder; Postgres as real booleans. */
function truthy(value: boolean | number): boolean {
    return value === true || value === 1;
}
