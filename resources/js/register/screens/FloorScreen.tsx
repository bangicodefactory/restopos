import type { RestaurantTableRow } from '@domain/types';
import { useCan } from '@shared/auth';
import { Button, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import { useT } from '../i18n';
import { currentDelta } from '../domain/kitchen-send';
import { createOrder, setTable } from '../domain/order-actions';
import { TableActionError, transferOrder } from '../domain/table-transfer';
import { orderTotals } from '../domain/totals';
import { useCatalog, useMoney } from '../hooks/use-register';
import { draftOrders, orderOnTable, useOrderStore } from '../state/order-store';
import { useUiStore } from '../state/ui-store';

/**
 * The floor plan (RST-002 … RST-016, RST-050 … RST-056).
 *
 * Tables are positioned in pixels exactly as the back-office editor placed them, and the tile
 * carries the three signals a waiter actually reads across a room: **colour** for state, **amount**
 * for how far along the table is, and **minutes since the last kitchen fire** for who has been
 * waiting. Odoo 19 dropped the last two; they are restored here (RST-016) because the change-count
 * badge alone does not tell you which table is about to complain.
 *
 * Transfer is a two-step gesture: arm it on the order, then tap the destination. If that table
 * already holds a draft the two orders merge, which is what keeps "one draft order per table" true
 * (RST-058).
 */

export function FloorScreen({ onOpenOrder }: { onOpenOrder: (uuid: string) => void }): JSX.Element {
    const t = useT();
    const money = useMoney();
    const catalog = useCatalog();
    const orders = useOrderStore((state) => state.orders);
    const transferUuid = useUiStore((state) => state.transferOrderUuid);
    const startTransfer = useUiStore((state) => state.startTransfer);
    const can = useCan();

    const [floorId, setFloorId] = useState<number | null>(catalog.floors[0]?.id ?? null);
    const [transferError, setTransferError] = useState<string | null>(null);

    const tables = useMemo(
        () => catalog.tables.filter((table) => table.active && table.floor_id === floorId),
        [catalog.tables, floorId],
    );

    const perFloorChanges = useMemo(() => {
        const out = new Map<number, number>();
        if (!orders) return out;
        for (const order of draftOrders(useOrderStore.getState())) {
            if (order.restaurant_table_id === null) continue;
            const table = catalog.tablesById.get(order.restaurant_table_id);
            if (!table) continue;
            out.set(table.floor_id, (out.get(table.floor_id) ?? 0) + currentDelta(order.uuid).nbrOfChanges);
        }
        return out;
    }, [catalog.tablesById, orders]);

    const onTableTap = async (table: RestaurantTableRow): Promise<void> => {
        const state = useOrderStore.getState();

        if (transferUuid !== null) {
            const source = state.orders[transferUuid];
            if (source && source.restaurant_table_id === table.id) {
                startTransfer(null);
                return;
            }
            startTransfer(null);
            setTransferError(null);
            try {
                // Server-authoritative (BAN-437): the merge record, prep-snapshot move and
                // unique-index resolution all happen on the server, then we rebuild locally.
                const result = await transferOrder(transferUuid, table.id);
                onOpenOrder(result.orderUuid);
            } catch (error) {
                setTransferError(
                    error instanceof TableActionError && error.code === 'offline'
                        ? t('reg.floor.transferOffline')
                        : t('reg.floor.transferFailed'),
                );
            }
            return;
        }

        // A child of a physically merged pair opens the parent's order (RST-050).
        const targetId = table.parent_id ?? table.id;
        const existing = orderOnTable(state, targetId);
        if (existing) {
            onOpenOrder(existing.uuid);
            return;
        }

        const created = await createOrder({ tableId: targetId, guestCount: table.seats });
        setTable(created, targetId);
        onOpenOrder(created);
    };

    if (catalog.floors.length === 0) {
        return (
            <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
                <p className="text-slate-600">{t('reg.floor.noFloors')}</p>
                <Button onClick={() => void createOrder().then(onOpenOrder)}>{t('reg.floor.newDirectSale')}</Button>
            </main>
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 overflow-x-auto border-b border-slate-200 p-2">
                {catalog.floors.map((floor) => {
                    const changes = perFloorChanges.get(floor.id) ?? 0;
                    return (
                        <button
                            key={floor.id}
                            type="button"
                            onClick={() => setFloorId(floor.id)}
                            className={cn(
                                'relative min-h-touch-lg shrink-0 rounded-pos px-4 font-semibold ring-1 ring-inset',
                                floor.id === floorId
                                    ? 'bg-brand-600 text-white ring-brand-700'
                                    : 'bg-white ring-slate-300',
                            )}
                        >
                            {floor.name}
                            {changes > 0 ? (
                                <span className="absolute -end-1 -top-1 min-w-5 rounded-full bg-warn px-1 text-xs font-bold text-white">
                                    {changes}
                                </span>
                            ) : null}
                        </button>
                    );
                })}

                <span className="ms-auto flex gap-2">
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void createOrder().then(onOpenOrder)}
                    >
                        {t('reg.floor.newDirectSale')}
                    </Button>
                </span>
            </div>

            {transferUuid !== null ? (
                <p className="bg-warn-soft px-3 py-2 font-semibold text-warn-fg">
                    {t('reg.floor.transferPrompt')} —{' '}
                    <button type="button" className="underline" onClick={() => startTransfer(null)}>
                        {t('common.cancel')}
                    </button>
                </p>
            ) : null}

            {transferError !== null ? (
                <p className="bg-danger-soft px-3 py-2 font-semibold text-danger-fg">
                    {transferError} —{' '}
                    <button type="button" className="underline" onClick={() => setTransferError(null)}>
                        {t('common.close')}
                    </button>
                </p>
            ) : null}

            <div className="relative min-h-0 flex-1 overflow-auto p-3">
                <div className="relative" style={{ minHeight: 480, minWidth: 640 }}>
                    {tables.map((table) => (
                        <TableTile
                            key={table.id}
                            table={table}
                            money={money}
                            onTap={() => void onTableTap(table)}
                            canUnlink={can('table.unmerge')}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

function TableTile({
    table,
    money,
    onTap,
    canUnlink,
}: {
    table: RestaurantTableRow;
    money: (value: string) => string;
    onTap: () => void;
    canUnlink: boolean;
}): JSX.Element {
    const t = useT();
    const orders = useOrderStore((state) => state.orders);
    const order = useMemo(
        () => (orders ? orderOnTable(useOrderStore.getState(), table.id) : null),
        [orders, table.id],
    );

    const totals = order ? orderTotals(order.uuid) : null;
    const changes = order ? currentDelta(order.uuid).nbrOfChanges : 0;
    const minutes = order?.last_prep_sent_at
        ? Math.floor((Date.now() - new Date(order.last_prep_sent_at).getTime()) / 60_000)
        : null;

    const occupied = order !== null;
    const stale = minutes !== null && minutes >= 15;

    return (
        <button
            type="button"
            onClick={onTap}
            // A table's only accessible name is "<number> <n> places" — localised, and it changes
            // with the cover count. Specs address it by these instead (BAN-505).
            data-testid="table-tile"
            data-table-number={table.table_number}
            data-occupied={occupied ? 'true' : 'false'}
            style={{
                position: 'absolute',
                left: table.position_h,
                top: table.position_v,
                width: Math.max(64, table.width),
                height: Math.max(64, table.height),
                borderRadius: table.shape === 'round' ? '9999px' : undefined,
                backgroundColor: table.color ?? undefined,
            }}
            className={cn(
                'flex flex-col items-center justify-center rounded-pos p-1 text-center shadow-pos ring-2',
                table.parent_id !== null && 'opacity-60',
                occupied
                    ? stale
                        ? 'bg-danger-soft ring-danger text-danger-fg'
                        : 'bg-warn-soft ring-warn text-warn-fg'
                    : 'bg-ok-soft ring-ok text-ok-fg',
            )}
            aria-label={`${t('order.table')} ${table.table_number}`}
        >
            <span className="text-lg font-bold">{table.table_number}</span>
            {occupied && totals ? (
                <>
                    <span className="text-sm font-semibold tabular-nums">{money(totals.roundedTotal)}</span>
                    {minutes !== null ? (
                        <span className="text-xs">{t('reg.floor.minutes', { count: minutes })}</span>
                    ) : null}
                </>
            ) : (
                <span className="text-xs">{t('reg.floor.seats', { count: table.seats })}</span>
            )}
            {changes > 0 ? (
                <span className="absolute end-1 top-1 min-w-5 rounded-full bg-warn px-1 text-xs font-bold text-white">
                    {changes}
                </span>
            ) : null}
            {table.parent_id !== null && canUnlink ? (
                <span className="absolute start-1 top-1 text-xs" aria-hidden>
                    🔗
                </span>
            ) : null}
        </button>
    );
}
