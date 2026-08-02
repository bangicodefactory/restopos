/**
 * `Orders/Index` — `GET /orders` (BOF-130…BOF-139).
 *
 * The filter bar is split in two, visibly, because the contract splits it in two.
 *
 * `GET /orders` validates exactly five parameters — `search`, `state`, `config_id`, `from`,
 * `to` — and those go through `useServerQuery`: they are in the URL, they re-run the query and
 * they page across the whole result set. The other three an operator asks for (session, amount
 * range, origin) are not in the contract, so they are applied to **the page that is loaded**, in
 * a separate group labelled as such (`order.clientFilterHint`). A control that silently searches
 * only fifty of nine thousand orders, and looks identical to one that searches all of them, is
 * how a manager concludes a refund never happened.
 *
 * When a client filter is active the server paginator is withheld from the table: showing
 * "1–50 sur 9 214" above thirty locally-filtered rows would be a lie. The table pages the
 * filtered rows itself and the notice explains why.
 *
 * **Contract gaps, surfaced rather than faked:** the page carries no `configs[]` list (so the
 * point-of-sale filter is a numeric field), and order rows carry no payment information at all,
 * so a payment-method filter is impossible here — it is named in the notice instead of being
 * rendered as a control that cannot work.
 */

import { Head, Link } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { useMemo, useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { useServerQuery } from '../../components/data-table/use-server-table';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { dateTime } from '../../lib/format';
import { EUR, money, toDecimal } from '../../lib/money';
import { routes } from '../../lib/routes';

import { ORDER_SOURCE_LABEL, ORDER_STATE_TONE, type OrderListRow, type OrdersIndexProps } from './types';

type ClientFilters = {
    sessionId: string;
    source: string;
    amountMin: string;
    amountMax: string;
};

const EMPTY_CLIENT_FILTERS: ClientFilters = { sessionId: '', source: '', amountMin: '', amountMax: '' };

export default function OrdersIndex({ orders, filters, states }: OrdersIndexProps): JSX.Element {
    const t = useT();
    const [client, setClient] = useState<ClientFilters>(EMPTY_CLIENT_FILTERS);

    const query = useServerQuery({
        url: routes.orders.index(),
        only: ['orders', 'filters'],
        initial: {
            search: filters.search ?? undefined,
            state: filters.state ?? undefined,
            config_id: filters.config_id ?? undefined,
            from: filters.from ?? undefined,
            to: filters.to ?? undefined,
        },
    });

    const clientActive =
        client.sessionId !== '' || client.source !== '' || client.amountMin !== '' || client.amountMax !== '';

    /** Sessions present on the loaded page — the only ones a page-local filter can honestly offer. */
    const sessionIds = useMemo(
        () => [...new Set(orders.data.map((row) => row.pos_session_id))].sort((a, b) => b - a),
        [orders.data],
    );

    const sources = useMemo(() => [...new Set(orders.data.map((row) => row.source))].sort(), [orders.data]);

    const rows = useMemo(() => {
        if (!clientActive) return orders.data;

        const min = client.amountMin === '' ? null : toDecimal(client.amountMin);
        const max = client.amountMax === '' ? null : toDecimal(client.amountMax);

        return orders.data.filter((row) => {
            if (client.sessionId !== '' && String(row.pos_session_id) !== client.sessionId) return false;
            if (client.source !== '' && row.source !== client.source) return false;

            const amount = toDecimal(row.amount_total);
            if (min !== null && amount.lt(min)) return false;
            if (max !== null && amount.gt(max)) return false;
            return true;
        });
    }, [client, clientActive, orders.data]);

    const columns: Column<OrderListRow>[] = [
        {
            id: 'name',
            header: t('order.title'),
            locked: true,
            cell: (row) => (
                <span className="flex flex-col">
                    <span className="font-medium text-slate-900">{row.name ?? `#${row.id}`}</span>
                    {row.receipt_number ? (
                        <span className="font-mono text-xs text-slate-500">{row.receipt_number}</span>
                    ) : null}
                </span>
            ),
            sortValue: (row) => row.name ?? String(row.id),
            searchValue: (row) => `${row.name ?? ''} ${row.receipt_number ?? ''}`,
            exportValue: (row) => row.name ?? String(row.id),
        },
        {
            id: 'ordered_at',
            header: t('report.period'),
            cell: (row) => <span className="tabular-nums">{dateTime(row.ordered_at)}</span>,
            sortValue: (row) => row.ordered_at,
            exportValue: (row) => row.ordered_at,
        },
        {
            id: 'state',
            header: t('order.filterState'),
            cell: (row) => (
                <Badge tone={ORDER_STATE_TONE[row.state] ?? 'neutral'}>
                    {states.find((state) => state.value === row.state)?.label ?? row.state}
                </Badge>
            ),
            sortValue: (row) => row.state,
            exportValue: (row) => row.state,
        },
        {
            id: 'source',
            header: t('order.source'),
            cell: (row) => <Badge>{ORDER_SOURCE_LABEL[row.source] ?? row.source}</Badge>,
            sortValue: (row) => row.source,
            exportValue: (row) => row.source,
        },
        {
            id: 'session',
            header: t('order.filterSession'),
            align: 'end',
            cell: (row) =>
                row.pos_session_uuid === null ? (
                    <span className="px-1 tabular-nums text-slate-500">#{row.pos_session_id}</span>
                ) : (
                    <Link
                        href={routes.sessions.show(row.pos_session_uuid)}
                        className={cn('rounded-pos px-1 tabular-nums text-brand-700 hover:underline', FOCUS_RING)}
                    >
                        #{row.pos_session_id}
                    </Link>
                ),
            sortValue: (row) => row.pos_session_id,
            exportValue: (row) => row.pos_session_id,
        },
        {
            id: 'is_refund',
            header: t('report.refunds'),
            align: 'center',
            defaultHidden: true,
            cell: (row) => (row.is_refund ? <Badge tone="danger">{t('state.yes')}</Badge> : <span>—</span>),
            sortValue: (row) => row.is_refund,
            exportValue: (row) => (row.is_refund ? '1' : '0'),
        },
        {
            id: 'amount_total',
            header: t('report.total'),
            align: 'end',
            cell: (row) => (
                <span className={cn('font-semibold tabular-nums', row.is_refund && 'text-danger')}>
                    {money(row.amount_total, EUR)}
                </span>
            ),
            sortValue: (row) => Number(toDecimal(row.amount_total).toString()),
            exportValue: (row) => row.amount_total,
        },
        {
            id: 'actions',
            header: '',
            align: 'end',
            cell: (row) => (
                <Link
                    href={routes.orders.show(row.uuid)}
                    className={cn('rounded-pos px-2 py-1 text-sm text-brand-700 hover:underline', FOCUS_RING)}
                >
                    {t('action.details')}
                </Link>
            ),
        },
    ];

    return (
        <AppLayout title={t('order.title')}>
            <Head title={t('order.title')} />

            <div className="space-y-4">
                <DataTable
                    columns={columns}
                    rows={rows}
                    getRowId={(row) => row.id}
                    storageKey="orders"
                    caption={t('order.title')}
                    loading={query.processing}
                    {...(clientActive ? {} : { paginator: orders })}
                    perPage={50}
                    search={{
                        value: String(query.params.search ?? ''),
                        onChange: (value) => query.set('search', value, { debounce: true }),
                        placeholder: t('order.filterSearch'),
                        server: true,
                    }}
                    filters={
                        <ServerFilters
                            from={String(query.params.from ?? '')}
                            to={String(query.params.to ?? '')}
                            state={String(query.params.state ?? '')}
                            configId={String(query.params.config_id ?? '')}
                            states={states}
                            onChange={(key, value) => query.set(key, value === '' ? undefined : value)}
                            onReset={query.dirty ? query.reset : undefined}
                        />
                    }
                    exportFilename="commandes"
                    onRowHref={(row) => routes.orders.show(row.uuid)}
                />

                <ClientFilterBar
                    value={client}
                    onChange={setClient}
                    sessionIds={sessionIds}
                    sources={sources}
                    active={clientActive}
                    shown={rows.length}
                    loaded={orders.data.length}
                />
            </div>
        </AppLayout>
    );
}

// ───────────────────────────────────────────────────────────── server-side filters

const FIELD = 'min-h-touch rounded-pos bg-white px-3 text-sm ring-1 ring-inset ring-slate-300';

function ServerFilters({
    from,
    to,
    state,
    configId,
    states,
    onChange,
    onReset,
}: {
    from: string;
    to: string;
    state: string;
    configId: string;
    states: { value: string; label: string }[];
    onChange: (key: 'from' | 'to' | 'state' | 'config_id', value: string) => void;
    onReset?: () => void;
}): JSX.Element {
    const t = useT();

    return (
        <>
            <label className="flex items-center gap-1 text-xs text-slate-600" htmlFor="order-from">
                {t('order.filterFrom')}
                <input
                    id="order-from"
                    type="date"
                    value={from}
                    onChange={(event) => onChange('from', event.target.value)}
                    className={cn(FIELD, FOCUS_RING)}
                />
            </label>

            <label className="flex items-center gap-1 text-xs text-slate-600" htmlFor="order-to">
                {t('order.filterTo')}
                <input
                    id="order-to"
                    type="date"
                    value={to}
                    min={from === '' ? undefined : from}
                    onChange={(event) => onChange('to', event.target.value)}
                    className={cn(FIELD, FOCUS_RING)}
                />
            </label>

            <label className="sr-only" htmlFor="order-state">
                {t('order.filterState')}
            </label>
            <select
                id="order-state"
                value={state}
                onChange={(event) => onChange('state', event.target.value)}
                className={cn(FIELD, FOCUS_RING)}
            >
                <option value="">
                    {t('order.filterState')} — {t('state.all')}
                </option>
                {states.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>

            <label className="flex items-center gap-1 text-xs text-slate-600" htmlFor="order-config">
                {t('order.filterConfig')}
                <input
                    id="order-config"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={configId}
                    placeholder="id"
                    onChange={(event) => onChange('config_id', event.target.value)}
                    className={cn(FIELD, 'w-24 tabular-nums', FOCUS_RING)}
                />
            </label>

            {onReset ? (
                <Button variant="ghost" size="md" onClick={onReset}>
                    {t('action.clearFilters')}
                </Button>
            ) : null}
        </>
    );
}

// ───────────────────────────────────────────────────────────── page-local filters

function ClientFilterBar({
    value,
    onChange,
    sessionIds,
    sources,
    active,
    shown,
    loaded,
}: {
    value: ClientFilters;
    onChange: (value: ClientFilters) => void;
    sessionIds: number[];
    sources: string[];
    active: boolean;
    shown: number;
    loaded: number;
}): JSX.Element {
    const t = useT();

    return (
        <Notice tone={active ? 'warn' : 'info'} title={t('order.clientFilterHint')}>
            <div className="mt-2 flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-xs font-medium" htmlFor="order-session">
                    {t('order.filterSession')}
                    <select
                        id="order-session"
                        value={value.sessionId}
                        onChange={(event) => onChange({ ...value, sessionId: event.target.value })}
                        className={cn(FIELD, FOCUS_RING)}
                    >
                        <option value="">{t('state.all')}</option>
                        {sessionIds.map((id) => (
                            <option key={id} value={String(id)}>
                                #{id}
                            </option>
                        ))}
                    </select>
                </label>

                <label className="flex flex-col gap-1 text-xs font-medium" htmlFor="order-source">
                    {t('order.source')}
                    <select
                        id="order-source"
                        value={value.source}
                        onChange={(event) => onChange({ ...value, source: event.target.value })}
                        className={cn(FIELD, FOCUS_RING)}
                    >
                        <option value="">{t('state.all')}</option>
                        {sources.map((source) => (
                            <option key={source} value={source}>
                                {ORDER_SOURCE_LABEL[source] ?? source}
                            </option>
                        ))}
                    </select>
                </label>

                <label className="flex flex-col gap-1 text-xs font-medium" htmlFor="order-amount-min">
                    {t('order.filterAmountMin')}
                    <input
                        id="order-amount-min"
                        type="text"
                        inputMode="decimal"
                        value={value.amountMin}
                        onChange={(event) => onChange({ ...value, amountMin: event.target.value })}
                        className={cn(FIELD, 'w-28 text-end tabular-nums', FOCUS_RING)}
                    />
                </label>

                <label className="flex flex-col gap-1 text-xs font-medium" htmlFor="order-amount-max">
                    {t('order.filterAmountMax')}
                    <input
                        id="order-amount-max"
                        type="text"
                        inputMode="decimal"
                        value={value.amountMax}
                        onChange={(event) => onChange({ ...value, amountMax: event.target.value })}
                        className={cn(FIELD, 'w-28 text-end tabular-nums', FOCUS_RING)}
                    />
                </label>

                {active ? (
                    <Button variant="ghost" size="md" onClick={() => onChange(EMPTY_CLIENT_FILTERS)}>
                        {t('action.clearFilters')}
                    </Button>
                ) : null}

                <span className="ms-auto text-xs tabular-nums" aria-live="polite">
                    {t('table.rows', { from: shown === 0 ? 0 : 1, to: shown, total: loaded })}
                </span>
            </div>

            <p className="mt-2 text-xs">{t('order.filterMethod')} — {t('order.paymentFilterMissing')}</p>
        </Notice>
    );
}
