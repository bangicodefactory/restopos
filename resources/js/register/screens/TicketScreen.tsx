import { Decimal } from '@domain/money/decimal';
import type { OrderRow } from '@domain/types';
import { useCan, useSessionStore } from '@shared/auth';
import { Button, SearchInput, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import { tryRuntime } from '../data/runtime';
import { useT } from '../i18n';
import { createRefundOrder, discardOrder, markPrinted, setTip } from '../domain/order-actions';
import { print } from '../domain/printing';
import { buildReceipt } from '../domain/receipt';
import { orderTotals } from '../domain/totals';
import { useCatalog, useMoney, useOrderLines } from '../hooks/use-register';
import { useOrderStore } from '../state/order-store';

/**
 * The order list (REG-290 … REG-300) and tip settlement (RST-127).
 *
 * Filters are derived from what the client actually knows: `state` for open/paid and `syncState`
 * for "did this reach the server". The second one is the important one — it is the screen a manager
 * opens when they want to know whether the shift's money is safe, and it answers per order rather
 * than with an aggregate badge.
 */

type Filter = 'all' | 'draft' | 'paid' | 'unsynced' | 'synced' | 'tips';

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

    const rows = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return Object.values(orders)
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
            })
            .sort((a, b) => b.updatedAtLocal - a.updatedAtLocal)
            .slice(0, 200);
    }, [catalog, filter, orders, query]);

    const detailLines = useOrderLines(selected);
    const detail = selected !== null ? (orders[selected] ?? null) : null;

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

                <ul className="min-h-0 flex-1 overflow-auto divide-y divide-slate-200">
                    {rows.length === 0 ? <li className="p-4 text-slate-500">{t('reg.tickets.none')}</li> : null}
                    {rows.map((order) => (
                        <li key={order.uuid}>
                            <button
                                type="button"
                                onClick={() => setSelected(order.uuid)}
                                className={cn(
                                    'flex w-full items-center gap-2 p-3 text-start',
                                    selected === order.uuid && 'bg-brand-50',
                                )}
                            >
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate font-semibold">
                                        {order.name ?? order.floating_order_name ?? order.receipt_number}
                                    </span>
                                    <span className="block text-sm text-slate-500">
                                        {order.state} · {new Date(order.updatedAtLocal).toLocaleTimeString()}
                                    </span>
                                </span>
                                <span className="tabular-nums font-semibold">
                                    {money(orderTotals(order.uuid).roundedTotal)}
                                </span>
                                <span
                                    className={cn(
                                        'h-2.5 w-2.5 rounded-full',
                                        order.syncState === 'synced'
                                            ? 'bg-ok'
                                            : order.syncState === 'quarantined'
                                              ? 'bg-danger'
                                              : 'bg-warn',
                                    )}
                                    aria-label={order.syncState}
                                />
                            </button>
                        </li>
                    ))}
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
                                        {line.quantity - line.refunded_quantity} / {line.quantity}
                                    </span>
                                    {detail.state !== 'draft' && can('refund.create') ? (
                                        <input
                                            type="number"
                                            min={0}
                                            max={line.quantity - line.refunded_quantity}
                                            className="min-h-touch w-20 rounded-pos border border-slate-300 px-2 text-right"
                                            value={refundQty[line.uuid] ?? 0}
                                            onChange={(event) =>
                                                setRefundQty((current) => ({
                                                    ...current,
                                                    [line.uuid]: Number.parseFloat(event.target.value || '0'),
                                                }))
                                            }
                                            aria-label={t('reg.tickets.refundQty')}
                                        />
                                    ) : null}
                                </li>
                            ))}
                        </ul>

                        <div className="grid grid-cols-2 gap-2">
                            <Button variant="secondary" onClick={() => onOpenOrder(detail.uuid)}>
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
                                disabled={!can('refund.create') || detail.state === 'draft'}
                                onClick={async () => {
                                    const refundUuid = await createRefundOrder(detail.uuid, refundQty);
                                    setRefundQty({});
                                    if (refundUuid) onOpenOrder(refundUuid);
                                }}
                            >
                                {t('reg.tickets.refund')}
                            </Button>
                            <Button
                                variant="danger"
                                disabled={detail.state !== 'draft' || !can('order.delete_draft')}
                                onClick={() => {
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
