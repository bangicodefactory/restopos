/**
 * `Sessions/Index` — `GET /sessions` (BOF-140…BOF-149).
 *
 * Three server filters (`config_id`, `state`, `rescue_only`) driven through `useServerQuery`, and
 * one column that is the reason this screen exists: **the difference**. A session whose drawer
 * did not reconcile is money nobody has explained yet, so the variance is coloured by sign, sorts
 * like a number, and stays visible when the operator hides everything else.
 *
 * Rescue sessions get a badge rather than a filter-only existence: they were created
 * automatically to receive an order that arrived after its session closed, and each one is an
 * open reconciliation item.
 */

import { Head, Link } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { useServerQuery } from '../../components/data-table/use-server-table';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { date, dateTime, integer } from '../../lib/format';
import { EUR, money, signOf, toDecimal } from '../../lib/money';
import { routes } from '../../lib/routes';

import { SESSION_STATE_TONE, type SessionListRow, type SessionsIndexProps } from './types';

export default function SessionsIndex({ sessions, filters, states }: SessionsIndexProps): JSX.Element {
    const t = useT();

    const query = useServerQuery({
        url: routes.sessions.index(),
        only: ['sessions', 'filters'],
        initial: {
            config_id: filters.config_id ?? undefined,
            state: filters.state ?? undefined,
            rescue_only: filters.rescue_only === true || filters.rescue_only === '1' ? true : undefined,
        },
    });

    const columns: Column<SessionListRow>[] = [
        {
            id: 'name',
            header: t('session.title'),
            locked: true,
            cell: (row) => (
                <span className="flex flex-col">
                    <span className="font-medium text-slate-900">{row.name}</span>
                    <span className="flex flex-wrap gap-1 pt-0.5">
                        {row.is_rescue ? <Badge tone="danger">{t('session.rescue')}</Badge> : null}
                        {row.closing_forced ? <Badge tone="warn">{t('session.forced')}</Badge> : null}
                    </span>
                </span>
            ),
            sortValue: (row) => row.name,
            searchValue: (row) => row.name,
            exportValue: (row) => row.name,
        },
        {
            id: 'state',
            header: t('order.filterState'),
            cell: (row) => (
                <Badge tone={SESSION_STATE_TONE[row.state] ?? 'neutral'}>
                    {states.find((state) => state.value === row.state)?.label ?? row.state}
                </Badge>
            ),
            sortValue: (row) => row.state,
            exportValue: (row) => row.state,
        },
        {
            id: 'pos_config_id',
            header: t('report.config'),
            align: 'end',
            cell: (row) => <span className="tabular-nums text-slate-600">#{row.pos_config_id}</span>,
            sortValue: (row) => row.pos_config_id,
            exportValue: (row) => row.pos_config_id,
        },
        {
            id: 'business_date',
            header: t('session.businessDate'),
            cell: (row) => <span className="tabular-nums">{date(row.business_date)}</span>,
            sortValue: (row) => row.business_date,
            exportValue: (row) => row.business_date,
        },
        {
            id: 'opened_at',
            header: t('session.openedAt'),
            defaultHidden: true,
            cell: (row) => <span className="tabular-nums">{dateTime(row.opened_at)}</span>,
            sortValue: (row) => row.opened_at,
            exportValue: (row) => row.opened_at,
        },
        {
            id: 'closed_at',
            header: t('session.closedAt'),
            cell: (row) => <span className="tabular-nums">{dateTime(row.closed_at)}</span>,
            sortValue: (row) => row.closed_at,
            exportValue: (row) => row.closed_at,
        },
        {
            id: 'order_count',
            header: t('session.orders'),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{integer(row.order_count)}</span>,
            sortValue: (row) => row.order_count,
            exportValue: (row) => row.order_count,
        },
        {
            id: 'order_amount_total',
            header: t('report.revenue'),
            align: 'end',
            cell: (row) => <span className="font-semibold tabular-nums">{money(row.order_amount_total, EUR)}</span>,
            sortValue: (row) => Number(toDecimal(row.order_amount_total).toString()),
            exportValue: (row) => row.order_amount_total,
        },
        {
            id: 'cash_difference',
            header: t('session.difference'),
            align: 'end',
            locked: true,
            cell: (row) => <Difference amount={row.cash_difference} />,
            sortValue: (row) => Number(toDecimal(row.cash_difference).toString()),
            exportValue: (row) => row.cash_difference,
        },
        {
            id: 'actions',
            header: '',
            align: 'end',
            cell: (row) => (
                <Link
                    href={routes.sessions.show(row.uuid)}
                    className={cn('rounded-pos px-2 py-1 text-sm text-brand-700 hover:underline', FOCUS_RING)}
                >
                    {t('action.details')}
                </Link>
            ),
        },
    ];

    return (
        <AppLayout title={t('session.title')} description={t('session.frozenHint')}>
            <Head title={t('session.title')} />

            <DataTable
                columns={columns}
                rows={sessions.data}
                getRowId={(row) => row.id}
                storageKey="sessions"
                caption={t('session.title')}
                loading={query.processing}
                paginator={sessions}
                filters={
                    <>
                        <label className="sr-only" htmlFor="session-state">
                            {t('order.filterState')}
                        </label>
                        <select
                            id="session-state"
                            value={String(query.params.state ?? '')}
                            onChange={(event) => query.set('state', event.target.value || undefined)}
                            className={cn(
                                'min-h-touch rounded-pos bg-white px-3 text-sm ring-1 ring-inset ring-slate-300',
                                FOCUS_RING,
                            )}
                        >
                            <option value="">
                                {t('order.filterState')} — {t('state.all')}
                            </option>
                            {states.map((state) => (
                                <option key={state.value} value={state.value}>
                                    {state.label}
                                </option>
                            ))}
                        </select>

                        <label className="flex items-center gap-1 text-xs text-slate-600" htmlFor="session-config">
                            {t('report.config')}
                            <input
                                id="session-config"
                                type="number"
                                inputMode="numeric"
                                min={1}
                                placeholder="id"
                                value={String(query.params.config_id ?? '')}
                                onChange={(event) => query.set('config_id', event.target.value || undefined)}
                                className={cn(
                                    'min-h-touch w-24 rounded-pos bg-white px-3 text-sm tabular-nums ring-1 ring-inset ring-slate-300',
                                    FOCUS_RING,
                                )}
                            />
                        </label>

                        <label className="flex min-h-touch items-center gap-2 text-sm text-slate-700">
                            <input
                                type="checkbox"
                                checked={query.params.rescue_only === true}
                                onChange={(event) => query.set('rescue_only', event.target.checked || undefined)}
                                className={cn('h-4 w-4 rounded border-slate-300', FOCUS_RING)}
                            />
                            {t('session.filterRescue')}
                        </label>

                        {query.dirty ? (
                            <Button variant="ghost" size="md" onClick={query.reset}>
                                {t('action.clearFilters')}
                            </Button>
                        ) : null}
                    </>
                }
                exportFilename="sessions"
                onRowHref={(row) => routes.sessions.show(row.uuid)}
            />
        </AppLayout>
    );
}

/** Signed variance: zero is quiet, anything else is not. */
function Difference({ amount }: { amount: string }): JSX.Element {
    const sign = signOf(amount);
    return (
        <span
            className={cn(
                'font-semibold tabular-nums',
                sign === 0 ? 'text-slate-400' : sign > 0 ? 'text-ok-fg' : 'text-danger',
            )}
        >
            {sign > 0 ? '+' : ''}
            {money(amount, EUR)}
        </span>
    );
}
