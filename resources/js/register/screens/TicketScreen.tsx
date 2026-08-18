import { isElectronicMethod } from '@domain/enums';
import { Decimal } from '@domain/money/decimal';
import type { OrderRow } from '@domain/types';
import { useCan, useSessionStore } from '@shared/auth';
import { browserOnline } from '@shared/sync';
import { Button, SearchInput, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchOrderGraphs, lookupOrders, type OrderIndexRecord } from '../data/order-lookup';
import { tryRuntime } from '../data/runtime';
import { canOpenOrder, foreignOrder } from '../domain/foreign-order';
import { useT } from '../i18n';
import {
    clampRefundQuantity,
    createRefundOrder,
    refundEverything,
    refundableQuantity,
    discardOrder,
    hydrateOrders,
    markPrinted,
    setTip,
} from '../domain/order-actions';
import { print } from '../domain/printing';
import { buildReceipt } from '../domain/receipt';
import { orderTotals } from '../domain/totals';
import { useCatalog, useMoney, useOrderLines } from '../hooks/use-register';
import { draftOrders, useOrderStore, paymentsOf } from '../state/order-store';
import { mergeOrders, transferOrder, transferTargets } from '../domain/table-transfer';
import {
    DEFAULT_PAGE_SIZE,
    PAGE_SIZE_OPTIONS,
    canDeleteOrder,
    mergeTicketRows,
    type TicketRow,
} from './ticket-rules';

/**
 * The order list (REG-290 … REG-300) and tip settlement (RST-127).
 *
 * Filters are derived from what the client actually knows: `state` for open/paid and `syncState`
 * for "did this reach the server". The second one is the important one — it is the screen a manager
 * opens when they want to know whether the shift's money is safe, and it answers per order rather
 * than with an aggregate badge.
 *
 * The **paid** filter is the one that reaches the server (REG-293). Everything else is a question
 * about this till's working set and is answered from memory; "find the order I took this morning"
 * is a question about the session, and after a reload — or from the second till — the answer was
 * simply not here. That filter runs the two-step cache diff in `../data/order-lookup`: pull the
 * cheap index, hydrate only what is missing or stale.
 *
 * Offline it degrades to exactly the old behaviour, with a notice. A till that cannot reach the
 * server can still reprint what it holds, and an error state would be a lie — the local list is a
 * correct answer to a smaller question.
 */

type Filter = 'all' | 'draft' | 'paid' | 'unsynced' | 'synced' | 'tips';

/** Only the paid filter has a server behind it; the rest describe local sync state. */
function isServerBacked(filter: Filter): boolean {
    return filter === 'paid';
}

type ServerState = {
    records: OrderIndexRecord[];
    cursor: number | null;
    total: number;
    loading: boolean;
    offline: boolean;
};

const IDLE_SERVER_STATE: ServerState = {
    records: [],
    cursor: null,
    total: 0,
    loading: false,
    offline: false,
};

/** The typing pause before a search reaches the server. Long enough not to fire per keystroke. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Run the two-step lookup when the filter or the search term settles, and expose "load more".
 *
 * Every request carries a generation number. A cashier typing "sm" then "smith" produces two
 * in-flight requests, and without the check the slower one can land last and paint the results for
 * a term that is no longer in the box.
 */
function useServerLookup({
    filter,
    query,
    pageSize,
    server,
    setServer,
}: {
    filter: Filter;
    query: string;
    pageSize: number;
    server: ServerState;
    setServer: (update: (current: ServerState) => ServerState) => void;
}): { loadMore: () => void } {
    const generation = useRef(0);

    const run = useCallback(
        async (cursor: number | null): Promise<void> => {
            const runtime = tryRuntime();

            if (!isServerBacked(filter)) {
                setServer(() => IDLE_SERVER_STATE);
                return;
            }

            if (!runtime || !browserOnline()) {
                setServer((current) => ({ ...current, loading: false, offline: true }));
                return;
            }

            const mine = ++generation.current;
            setServer((current) => ({ ...current, loading: true, offline: false }));

            try {
                const { page, fetched } = await lookupOrders(
                    runtime.api,
                    {
                        updatedAtOf: (uuid) => useOrderStore.getState().orders[uuid]?.serverUpdatedAt ?? undefined,
                        isDirty: (uuid) => (useOrderStore.getState().orders[uuid]?.syncState ?? 'synced') !== 'synced',
                    },
                    {
                        state: 'paid',
                        search: query.trim() === '' ? null : query.trim(),
                        cursor,
                        limit: pageSize,
                    },
                );

                if (mine !== generation.current) return;

                if (fetched.orders.length > 0) {
                    hydrateOrders(fetched);
                    // Persist so the next reload starts from the replica rather than the network.
                    for (const order of fetched.orders) runtime.persistence.persist(order.uuid);
                }

                setServer((current) => ({
                    records: cursor === null ? page.records : [...current.records, ...page.records],
                    cursor: page.next_cursor,
                    // null on a cursor page: the server does not recount, so keep page one's answer.
                    total: page.total ?? current.total,
                    loading: false,
                    offline: false,
                }));
            } catch {
                if (mine !== generation.current) return;
                // The local replica is still a correct answer to a smaller question.
                setServer((current) => ({ ...current, loading: false, offline: true }));
            }
        },
        [filter, pageSize, query, setServer],
    );

    useEffect(() => {
        if (!isServerBacked(filter)) {
            setServer(() => IDLE_SERVER_STATE);
            return;
        }

        const timer = setTimeout(() => void run(null), query === '' ? 0 : SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [filter, query, pageSize, run, setServer]);

    return {
        // Reads the rendered state rather than peeking inside a `setServer` updater. Updaters must
        // be pure: React double-invokes them under StrictMode, which fired this page request twice.
        loadMore: () => {
            if (server.cursor !== null && !server.loading) void run(server.cursor);
        },
    };
}

export function TicketScreen({ onOpenOrder }: { onOpenOrder: (uuid: string) => void }): JSX.Element {
    const t = useT();
    const money = useMoney();
    const can = useCan();
    const catalog = useCatalog();
    const cashier = useSessionStore((state) => state.cashier);
    const orders = useOrderStore((state) => state.orders);

    const [filter, setFilter] = useState<Filter>('all');
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState<string | null>(null);
    const [refundQty, setRefundQty] = useState<Record<string, number>>({});
    const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
    const [server, setServer] = useState<ServerState>(IDLE_SERVER_STATE);

    const lookup = useServerLookup({ filter, query, pageSize, server, setServer });

    const rows = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const local = Object.values(orders)
            .filter((order) => {
                if (filter === 'draft') return order.state === 'draft';
                if (filter === 'paid') return order.state === 'paid' || order.state === 'done';
                if (filter === 'unsynced') return order.syncState !== 'synced';
                if (filter === 'synced') return order.syncState === 'synced';
                if (filter === 'tips') return order.state === 'paid' && !order.is_tipped;
                return true;
            })
            .filter((order) => {
                if (needle === '') return true;
                const table =
                    order.restaurant_table_id != null
                        ? (catalog.tablesById.get(order.restaurant_table_id)?.table_number ?? '')
                        : '';
                return [order.receipt_number, order.name ?? '', order.floating_order_name ?? '', table]
                    .join(' ')
                    .toLowerCase()
                    .includes(needle);
            });

        // On a server-backed filter the server decided the result set; `mergeTicketRows` explains
        // why its records are not re-filtered locally, and renders an index record whose body did
        // not arrive as a stub rather than dropping it.
        if (isServerBacked(filter) && server.records.length > 0) {
            return mergeTicketRows(
                server.records,
                orders,
                local.filter((order) => order.syncState !== 'synced'),
            );
        }

        return local
            .sort((a, b) => b.updatedAtLocal - a.updatedAtLocal)
            .slice(0, pageSize)
            .map((order): TicketRow => ({ kind: 'order', uuid: order.uuid, order }));
    }, [catalog, filter, orders, pageSize, query, server.records]);

    /**
     * Fetch one order's body on demand — the retry behind a stub row.
     *
     * Stubs come from a body fetch that failed while its page succeeded, so the useful recovery is
     * per row and on the cashier's initiative, not another sweep of the whole page.
     */
    const hydrateOne = useCallback(async (uuid: string): Promise<void> => {
        const runtime = tryRuntime();
        if (!runtime) return;

        const graph = await fetchOrderGraphs(runtime.api, [uuid]);
        if (graph.orders.length === 0) return;

        hydrateOrders(graph);
        for (const order of graph.orders) runtime.persistence.persist(order.uuid);
    }, []);

    const moveTargets = useMemo(
        () =>
            selected === null
                ? []
                : transferTargets(
                      catalog.tables,
                      draftOrders(useOrderStore.getState()).map((order) => ({
                          uuid: order.uuid,
                          restaurant_table_id: order.restaurant_table_id,
                      })),
                      selected,
                  ),
        [catalog.tables, selected],
    );

    const detailLines = useOrderLines(selected);
    const detail = selected !== null ? (orders[selected] ?? null) : null;

    // REG-295 — a draft can hold a card payment the terminal already captured. Deleting it would
    // erase the till's only record of money that has moved.
    const deletable = useMemo(() => {
        if (detail === null) return false;
        const methodType = (id: number): boolean => {
            const method = catalog.paymentMethods.find((candidate) => candidate.id === id);
            return method !== undefined && isElectronicMethod(method.method_type);
        };
        return canDeleteOrder(detail, paymentsOf(useOrderStore.getState(), detail.uuid), {
            isElectronic: methodType,
        });
    }, [catalog, detail]);

    const reprint = async (order: OrderRow): Promise<void> => {
        const runtime = tryRuntime();
        if (!runtime) return;
        const table =
            order.restaurant_table_id != null ? catalog.tablesById.get(order.restaurant_table_id) : undefined;
        const doc = buildReceipt(useOrderStore.getState(), order.uuid, {
            cashierName: cashier?.name ?? null,
            tableName: table?.table_number ?? null,
            copy: order.print_count + 1,
        });
        if (!doc) return;
        await print(runtime.printer, doc, { role: 'receipt' });
        markPrinted(order.uuid);
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3 till:flex-row">
            <section className="flex min-h-0 flex-1 flex-col gap-2">
                <SearchInput value={query} onChange={setQuery} placeholder={t('reg.tickets.search')} />

                <div className="flex flex-wrap gap-1">
                    {(
                        [
                            ['all', t('reg.tickets.all')],
                            ['draft', t('reg.tickets.draft')],
                            ['paid', t('reg.tickets.paid')],
                            ['unsynced', t('reg.tickets.unsynced')],
                            ['synced', t('reg.tickets.synced')],
                            ['tips', t('reg.tickets.tips')],
                        ] as Array<[Filter, string]>
                    ).map(([key, label]) => (
                        <Button
                            key={key}
                            size="sm"
                            variant={filter === key ? 'primary' : 'secondary'}
                            onClick={() => setFilter(key)}
                        >
                            {label}
                        </Button>
                    ))}
                </div>

                {isServerBacked(filter) ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
                        {server.offline ? (
                            <span className="rounded-pos bg-warn/10 px-2 py-1 text-warn-800">
                                {t('reg.tickets.offline')}
                            </span>
                        ) : null}
                        {server.loading ? <span>{t('reg.tickets.loading')}</span> : null}
                        {!server.offline && !server.loading && server.total > 0 ? (
                            <span>{t('reg.tickets.serverCount', { n: String(server.total) })}</span>
                        ) : null}
                        <label className="ms-auto flex items-center gap-1">
                            <span className="sr-only">{t('reg.tickets.pageSize')}</span>
                            <select
                                className="min-h-touch rounded-pos border border-slate-300 px-2"
                                value={pageSize}
                                onChange={(event) => setPageSize(Number.parseInt(event.target.value, 10))}
                            >
                                {PAGE_SIZE_OPTIONS.map((option) => (
                                    <option key={option} value={option}>
                                        {option}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                ) : null}

                <ul className="min-h-0 flex-1 overflow-auto divide-y divide-slate-200">
                    {rows.length === 0 ? <li className="p-4 text-slate-500">{t('reg.tickets.none')}</li> : null}
                    {rows.map((row) =>
                        row.kind === 'stub' ? (
                            <li key={row.uuid}>
                                {/*
                                 * The body did not arrive. Everything shown here comes from the
                                 * index, which is why the row can exist at all — dropping it would
                                 * tell a cashier holding the receipt that the order does not exist.
                                 * Tapping retries just this one.
                                 */}
                                <button
                                    type="button"
                                    onClick={() => void hydrateOne(row.uuid)}
                                    className="flex w-full items-center gap-2 p-3 text-start"
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate font-semibold text-slate-500">
                                            {row.record.name ?? row.record.receipt_number}
                                        </span>
                                        <span className="block text-sm text-slate-400">
                                            {row.record.state} · {t('reg.tickets.notLoaded')}
                                        </span>
                                    </span>
                                    <span className="tabular-nums font-semibold text-slate-500">
                                        {money(row.record.amount_total)}
                                    </span>
                                    <span
                                        className="h-2.5 w-2.5 rounded-full bg-slate-300"
                                        aria-label={t('reg.tickets.notLoaded')}
                                    />
                                </button>
                            </li>
                        ) : (
                        <li key={row.uuid}>
                            <button
                                type="button"
                                onClick={() => setSelected(row.uuid)}
                                className={cn(
                                    'flex w-full items-center gap-2 p-3 text-start',
                                    selected === row.uuid && 'bg-brand-50',
                                )}
                            >
                                <span className="min-w-0 flex-1">
                                    {/* REG-374 — whose bill this is. A trusted peer's orders arrive
                                        looking exactly like local ones, and a waiter editing one
                                        should know they are on somebody else's till's sale. */}
                                    {foreignOrder(row.order, catalog.config) !== null ? (
                                        <span
                                            className="mb-1 inline-block rounded-pos bg-slate-200 px-1 text-xs font-semibold text-slate-700"
                                            data-testid="ticket-foreign"
                                        >
                                            {foreignOrder(row.order, catalog.config)?.registerName
                                                ? t('reg.tickets.otherRegister', {
                                                      name: foreignOrder(row.order, catalog.config)?.registerName ?? '',
                                                  })
                                                : t('reg.tickets.unknownRegister')}
                                        </span>
                                    ) : null}
                                    <span className="block truncate font-semibold">
                                        {row.order.name ?? row.order.floating_order_name ?? row.order.receipt_number}
                                    </span>
                                    <span className="block text-sm text-slate-500">
                                        {row.order.state} ·{' '}
                                        {new Date(row.order.updatedAtLocal).toLocaleTimeString()}
                                    </span>
                                </span>
                                <span className="tabular-nums font-semibold">
                                    {money(orderTotals(row.uuid).roundedTotal)}
                                </span>
                                <span
                                    className={cn(
                                        'h-2.5 w-2.5 rounded-full',
                                        row.order.syncState === 'synced'
                                            ? 'bg-ok'
                                            : row.order.syncState === 'quarantined'
                                              ? 'bg-danger'
                                              : 'bg-warn',
                                    )}
                                    aria-label={row.order.syncState}
                                />
                            </button>
                        </li>
                        ),
                    )}
                    {isServerBacked(filter) && server.cursor !== null ? (
                        <li className="p-2">
                            <Button block variant="secondary" disabled={server.loading} onClick={lookup.loadMore}>
                                {t('reg.tickets.loadMore')}
                            </Button>
                        </li>
                    ) : null}
                </ul>
            </section>

            <aside className="w-full shrink-0 space-y-2 rounded-pos bg-slate-50 p-3 till:w-96">
                {detail === null ? (
                    <p className="text-slate-500">{t('reg.tickets.detail')}</p>
                ) : (
                    <>
                        <h2 className="text-lg font-bold">
                            {detail.name ?? detail.floating_order_name ?? detail.receipt_number}
                        </h2>

                        <ul className="max-h-64 overflow-auto divide-y divide-slate-200">
                            {detailLines.map((line) => (
                                <li key={line.uuid} className="flex items-center gap-2 py-1.5">
                                    <span className="min-w-0 flex-1 truncate">{line.full_product_name}</span>
                                    <span className="tabular-nums text-slate-500">
                                        {refundableQuantity(line)} / {line.quantity}
                                    </span>
                                    {detail.state !== 'draft' && can('refund.create') ? (
                                        <input
                                            type="number"
                                            min={0}
                                            max={refundableQuantity(line)}
                                            data-testid="refund-qty"
                                            data-line-uuid={line.uuid}
                                            className="min-h-touch w-20 rounded-pos border border-slate-300 px-2 text-right"
                                            value={refundQty[line.uuid] ?? 0}
                                            onChange={(event) =>
                                                setRefundQty((current) => ({
                                                    ...current,
                                                    // Clamped here, not left to the `max` attribute:
                                                    // `max` constrains the spinner and nothing else,
                                                    // so a pasted value sails straight past it and
                                                    // the cashier learns about it from a rejected
                                                    // push instead of from the field (REG-273).
                                                    [line.uuid]: clampRefundQuantity(
                                                        line,
                                                        Number.parseFloat(event.target.value || '0'),
                                                    ),
                                                }))
                                            }
                                            aria-label={t('reg.tickets.refundQty')}
                                        />
                                    ) : null}
                                </li>
                            ))}
                        </ul>

                        {detail.state !== 'draft' && can('refund.create') ? (
                            <Button
                                block
                                variant="secondary"
                                data-testid="refund-everything"
                                disabled={detailLines.every((line) => refundableQuantity(line) === 0)}
                                onClick={() => setRefundQty(refundEverything(detail.uuid))}
                            >
                                {t('reg.tickets.refundEverything')}
                            </Button>
                        ) : null}

                        {/* REG-373 — a peer on another currency. The amounts on this row are in a
                            unit this till does not use, so opening it would offer local tenders
                            against foreign figures and balance to a number that was never the price.
                            Nothing downstream can catch that: the arithmetic is all internally
                            consistent. Said out loud rather than a button that does nothing. */}
                        {!canOpenOrder(detail, catalog.config) ? (
                            <p
                                className="mb-2 rounded-pos bg-warn-soft p-2 text-sm font-semibold text-warn-fg"
                                data-testid="ticket-foreign-blocked"
                            >
                                {foreignOrder(detail, catalog.config)?.registerName
                                    ? t('reg.tickets.otherCurrency', {
                                          name: foreignOrder(detail, catalog.config)?.registerName ?? '',
                                      })
                                    : t('reg.tickets.unknownRegister')}
                            </p>
                        ) : null}

                        <div className="grid grid-cols-2 gap-2">
                            <Button
                                variant="secondary"
                                disabled={!canOpenOrder(detail, catalog.config)}
                                data-testid="ticket-open"
                                onClick={() => onOpenOrder(detail.uuid)}
                            >
                                {t('reg.tickets.openOrder')}
                            </Button>
                            <Button
                                variant="secondary"
                                disabled={!can('receipt.reprint')}
                                onClick={() => void reprint(detail)}
                            >
                                {t('reg.tickets.reprint')}
                            </Button>
                            <Button
                                variant="secondary"
                                data-testid="refund"
                                disabled={
                                    !can('refund.create') ||
                                    detail.state === 'draft' ||
                                    Object.values(refundQty).every((quantity) => quantity <= 0)
                                }
                                onClick={async () => {
                                    const refundUuid = await createRefundOrder(detail.uuid, refundQty);
                                    setRefundQty({});
                                    if (refundUuid) onOpenOrder(refundUuid);
                                }}
                            >
                                {t('reg.tickets.refund')}
                            </Button>
                            {/* RST-057 — move the order from here, not only from the floor plan.
                                The gesture there needs a table to arm on, which is no help to the
                                case that needs it most: an order that is not on a table yet. */}
                            {detail.state === 'draft' && can('table.transfer') ? (
                                <select
                                    aria-label={t('reg.tickets.moveTo')}
                                    data-testid="ticket-transfer-target"
                                    className="min-h-touch rounded-pos border border-slate-300 px-2"
                                    value=""
                                    onChange={async (event) => {
                                        const tableId = Number(event.target.value);
                                        if (!Number.isFinite(tableId) || tableId === 0) return;

                                        const target = moveTargets.find((candidate) => candidate.tableId === tableId);
                                        if (!target) return;

                                        // Whether this is a move or a merge is a consequence of the
                                        // destination, not a separate choice the waiter makes.
                                        if (target.occupiedByUuid !== null) {
                                            await mergeOrders(detail.uuid, target.occupiedByUuid);
                                        } else {
                                            await transferOrder(detail.uuid, tableId);
                                        }

                                        setSelected(null);
                                    }}
                                >
                                    <option value="">{t('reg.tickets.moveTo')}</option>
                                    {moveTargets.map((target) => (
                                        <option key={target.tableId} value={target.tableId}>
                                            {target.occupiedByUuid === null
                                                ? target.label
                                                : t('reg.tickets.mergeInto', { table: target.label })}
                                        </option>
                                    ))}
                                </select>
                            ) : null}
                            <Button
                                variant="danger"
                                disabled={!deletable || !can('order.delete_draft')}
                                title={
                                    detail.state === 'draft' && !deletable
                                        ? t('reg.tickets.deleteBlockedPaid')
                                        : undefined
                                }
                                onClick={() => {
                                    // `discardOrder` cancels rather than forgets when the order has
                                    // reached the server, and the server withdraws the kitchen
                                    // ticket on both paths (REG-295) — so the pass hears about this.
                                    discardOrder(detail.uuid);
                                    setSelected(null);
                                }}
                            >
                                {t('reg.tickets.delete')}
                            </Button>
                        </div>

                        {filter === 'tips' ? (
                            <TipSettlement
                                orderUuid={detail.uuid}
                                total={orderTotals(detail.uuid).roundedTotal}
                            />
                        ) : null}
                    </>
                )}
            </aside>
        </div>
    );
}

/** RST-127 — settle a shift's tips from the list rather than one receipt at a time. */
function TipSettlement({ orderUuid, total }: { orderUuid: string; total: string }): JSX.Element {
    const t = useT();
    const money = useMoney();
    const [amount, setAmount] = useState('');

    return (
        <div className="rounded-pos bg-white p-3 ring-1 ring-slate-200">
            <p className="mb-2 font-semibold">{t('reg.tickets.tipAmount')}</p>
            <div className="flex gap-2">
                {['15', '20', '25'].map((percent) => (
                    <Button
                        key={percent}
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                            setAmount(Decimal.of(total).mul(percent).div('100', 2).withScale(2).toString())
                        }
                    >
                        {percent} %
                    </Button>
                ))}
                <input
                    type="text"
                    inputMode="decimal"
                    className="min-h-touch w-24 rounded-pos border border-slate-300 px-2 text-right"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                />
            </div>
            <Button
                block
                className="mt-2"
                disabled={amount === ''}
                onClick={() => {
                    setTip(orderUuid, Decimal.of(amount).withScale(2).toString());
                    setAmount('');
                }}
            >
                {t('reg.tickets.settleTip')} · {money(amount === '' ? '0' : amount)}
            </Button>
        </div>
    );
}
