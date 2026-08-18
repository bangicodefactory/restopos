import type { RestaurantTableRow } from '@domain/types';
import { useCan } from '@shared/auth';
import { Button, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../i18n';
import { currentDelta } from '../domain/kitchen-send';
import { createOrder, setTable } from '../domain/order-actions';
import { billTableFor, canLink, linkTable, linkedChildren, unlinkTable } from '../domain/table-link';
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
 *
 * Linking is the other gesture (RST-050, BAN-463): **hold** a table for 400 ms and drag it onto
 * another to push them together. Hold rather than tap, because a tap already means "open this
 * table", and the room is worked at speed on a screen being carried — a drag that armed instantly
 * would rearrange the room every time a thumb slid on the way to a bill. Movement cancels the
 * hold too, so scrolling a long room never arms anything.
 */

export function FloorScreen({
    onOpenOrder,
    onEditRoom,
}: {
    onOpenOrder: (uuid: string) => void;
    /** Absent on a surface with no editor to open — the screen simply shows no toggle. */
    onEditRoom?: () => void;
}): JSX.Element {
    const t = useT();
    const money = useMoney();
    const catalog = useCatalog();
    const orders = useOrderStore((state) => state.orders);
    const transferUuid = useUiStore((state) => state.transferOrderUuid);
    const startTransfer = useUiStore((state) => state.startTransfer);
    const can = useCan();

    const [floorId, setFloorId] = useState<number | null>(catalog.floors[0]?.id ?? null);
    const [transferError, setTransferError] = useState<string | null>(null);
    const [linkError, setLinkError] = useState<string | null>(null);

    // The table being dragged, and the one currently under the finger. Ids rather than rows, so a
    // catalog refresh mid-drag cannot leave a stale copy on screen.
    const [armedId, setArmedId] = useState<number | null>(null);
    const [hoverId, setHoverId] = useState<number | null>(null);

    // A pointer sequence that armed a drag must not also register as a tap on the way up — the
    // waiter meant to move the table, not open it.
    const draggedRef = useRef(false);

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
        if (draggedRef.current) {
            draggedRef.current = false;
            return;
        }

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

        // A child of a linked group has no bill of its own — the link moved it onto the parent —
        // so tapping it opens the group's bill rather than an empty screen (RST-050).
        const billTable = billTableFor(table, catalog.tables);
        const targetId = billTable.id;
        const existing = orderOnTable(state, targetId);
        if (existing) {
            onOpenOrder(existing.uuid);
            return;
        }

        // The covers of the whole group, not of the one table that was tapped. Two fours pushed
        // together seat eight, and the tile says so — opening the bill for four would disagree with
        // the screen it was opened from, and the guest count is what per-cover reporting and course
        // pacing are counted against (review of #70).
        const seats = linkedChildren(billTable, catalog.tables).reduce(
            (total, row) => total + row.seats,
            billTable.seats,
        );

        const created = await createOrder({ tableId: targetId, guestCount: seats });
        setTable(created, targetId);
        onOpenOrder(created);
    };

    const cancelDrag = useCallback((): void => {
        setArmedId(null);
        setHoverId(null);
    }, []);

    // Escape is the keyboard's version of dropping on empty canvas.
    useEffect(() => {
        if (armedId === null) return;

        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') cancelDrag();
        };

        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [armedId, cancelDrag]);

    const armed = armedId === null ? null : (catalog.tablesById.get(armedId) ?? null);

    const dropOn = async (target: RestaurantTableRow | null): Promise<void> => {
        const child = armed;
        cancelDrag();

        // A drop that landed on a tile is followed by that tile's click, and opening the table the
        // waiter just dropped onto is not what they asked for. Set here rather than when the drag
        // armed, so a drag that ended in a cancel leaves nothing behind: it produces no click to
        // swallow, and the flag survived to eat the *next* real tap — change your mind about moving
        // a table, then tap one to take an order, and nothing happened (review of #70).
        //
        // Set even when the drop is refused below: dropping on an illegal target should still not
        // open it.
        if (target !== null) draggedRef.current = true;

        // Dropped on empty canvas, or on a table the link rules refuse. Being able to change your
        // mind without a dialog is most of why this is a drag and not a two-tap gesture.
        if (!child || !target || !canLink(child, target)) return;

        setLinkError(null);
        try {
            const orderUuid = await linkTable(child, target);
            if (orderUuid) onOpenOrder(orderUuid);
        } catch (error) {
            setLinkError(
                error instanceof TableActionError && error.code === 'offline'
                    ? t('reg.floor.linkOffline')
                    : t('reg.floor.linkFailed'),
            );
        }
    };

    const onUnlink = async (table: RestaurantTableRow): Promise<void> => {
        setLinkError(null);
        try {
            await unlinkTable(table);
        } catch (error) {
            setLinkError(
                error instanceof TableActionError && error.code === 'offline'
                    ? t('reg.floor.linkOffline')
                    : t('reg.floor.linkFailed'),
            );
        }
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
                    {/* RST-030 — the room is rearranged by whoever is standing in it, which is why
                        the toggle lives here and not only in the back office. `config.manage` is a
                        manager ability, so a cashier never sees it; the server checks again. */}
                    {onEditRoom !== undefined && can('config.manage') ? (
                        <Button size="sm" variant="secondary" onClick={onEditRoom} data-testid="floor-edit-toggle">
                            {t('reg.floorEdit.enter')}
                        </Button>
                    ) : null}
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

            {armed !== null ? (
                <p className="bg-brand-50 px-3 py-2 font-semibold text-brand-700" data-testid="link-armed">
                    {t('reg.floor.linkArmed', { number: armed.table_number })} —{' '}
                    <button type="button" className="underline" onClick={cancelDrag}>
                        {t('common.cancel')}
                    </button>
                </p>
            ) : null}

            {linkError !== null ? (
                <p className="bg-danger-soft px-3 py-2 font-semibold text-danger-fg" data-testid="link-error">
                    {linkError} —{' '}
                    <button type="button" className="underline" onClick={() => setLinkError(null)}>
                        {t('common.close')}
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
                <div
                    className="relative"
                    style={{ minHeight: 480, minWidth: 640 }}
                    // Dropping anywhere that is not a table cancels — including the gaps between
                    // them, which is where a waiter aims once they have changed their mind.
                    onPointerUp={armedId === null ? undefined : () => void dropOn(null)}
                    data-testid="floor-canvas"
                >
                    {tables.map((table) => (
                        <TableTile
                            key={table.id}
                            table={table}
                            money={money}
                            group={linkedChildren(table, catalog.tables)}
                            onTap={() => void onTableTap(table)}
                            canUnlink={can('table.unmerge')}
                            onUnlink={() => void onUnlink(table)}
                            armed={armedId === table.id}
                            dragging={armedId !== null}
                            // Only tables the server would accept light up, so the gesture never
                            // offers a drop that is about to come back as a 422.
                            droppable={armed !== null && canLink(armed, table)}
                            hovered={hoverId === table.id}
                            onArm={() => setArmedId(table.id)}
                            onHover={() => {
                                if (armedId !== null && armedId !== table.id) setHoverId(table.id);
                            }}
                            onDrop={() => void dropOn(table)}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

/** How long a finger must rest on a table before the drag arms (RST-050). */
const HOLD_MS = 400;

/** Movement past this many pixels during the hold means the room is being scrolled, not a table dragged. */
const HOLD_SLOP_PX = 10;

function TableTile({
    table,
    money,
    group,
    onTap,
    canUnlink,
    onUnlink,
    armed,
    dragging,
    droppable,
    hovered,
    onArm,
    onHover,
    onDrop,
}: {
    table: RestaurantTableRow;
    money: (value: string) => string;
    /** The tables linked *under* this one — empty for a plain table or a child. */
    group: readonly RestaurantTableRow[];
    onTap: () => void;
    canUnlink: boolean;
    onUnlink: () => void;
    armed: boolean;
    dragging: boolean;
    droppable: boolean;
    hovered: boolean;
    onArm: () => void;
    onHover: () => void;
    onDrop: () => void;
}): JSX.Element {
    const t = useT();
    const orders = useOrderStore((state) => state.orders);
    const order = useMemo(
        () => (orders ? orderOnTable(useOrderStore.getState(), table.id) : null),
        [orders, table.id],
    );

    const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const originRef = useRef<{ x: number; y: number } | null>(null);

    const clearHold = useCallback((): void => {
        if (holdRef.current !== null) {
            clearTimeout(holdRef.current);
            holdRef.current = null;
        }
        originRef.current = null;
    }, []);

    // A tile that unmounts mid-hold (a floor switch, a catalog refresh) must not arm a drag on a
    // table that is no longer on screen.
    useEffect(() => clearHold, [clearHold]);

    const totals = order ? orderTotals(order.uuid) : null;
    const changes = order ? currentDelta(order.uuid).nbrOfChanges : 0;
    const minutes = order?.last_prep_sent_at
        ? Math.floor((Date.now() - new Date(order.last_prep_sent_at).getTime()) / 60_000)
        : null;

    const occupied = order !== null;
    const stale = minutes !== null && minutes >= 15;
    const isChild = table.parent_id !== null;

    // The group's covers and its bill both sit on the parent, because that is where the link put
    // them — so the parent tile is the one unit the waiter reads, and the children hang off it.
    const groupNumbers = group.length > 0 ? [table, ...group].map((row) => row.table_number).join(' & ') : null;
    const groupSeats = group.reduce((sum, row) => sum + row.seats, table.seats);

    return (
        // The tile is a positioned wrapper rather than one big button, because unlink has to be a
        // control of its own. Nested inside the button it was invalid HTML, and a screen reader
        // reaches it by walking into a control it has already been told is a single button — so the
        // one action on this tile that cannot be undone by tapping again was the least reachable.
        <div
            style={{
                position: 'absolute',
                left: table.position_h,
                top: table.position_v,
                width: Math.max(64, table.width),
                height: Math.max(64, table.height),
            }}
        >
            <button
                type="button"
                onClick={onTap}
                onPointerDown={(event) => {
                    originRef.current = { x: event.clientX, y: event.clientY };
                    holdRef.current = setTimeout(() => {
                        holdRef.current = null;
                        onArm();
                    }, HOLD_MS);
                }}
                onPointerMove={(event) => {
                    const origin = originRef.current;
                    if (holdRef.current === null || !origin) return;

                    const moved = Math.abs(event.clientX - origin.x) + Math.abs(event.clientY - origin.y);
                    if (moved > HOLD_SLOP_PX) clearHold();
                }}
                onPointerEnter={dragging ? onHover : undefined}
                onPointerUp={() => {
                    clearHold();
                    if (dragging) onDrop();
                }}
                onPointerCancel={clearHold}
                // A table's only accessible name is "<number> <n> places" — localised, and it
                // changes with the cover count. Specs address it by these instead (BAN-505).
                data-testid="table-tile"
                data-table-number={table.table_number}
                data-occupied={occupied ? 'true' : 'false'}
                data-armed={armed ? 'true' : 'false'}
                data-droppable={dragging && droppable ? 'true' : 'false'}
                style={{
                    borderRadius: table.shape === 'round' ? '9999px' : undefined,
                    backgroundColor: table.color ?? undefined,
                    // Without this the browser claims the gesture for scrolling and the hold never
                    // completes on a touch screen — which is every screen this runs on.
                    touchAction: dragging ? 'none' : undefined,
                }}
                className={cn(
                    'absolute inset-0 flex flex-col items-center justify-center rounded-pos p-1 text-center shadow-pos ring-2',
                    isChild && 'opacity-60',
                    armed && 'z-10 scale-105 ring-4 ring-brand-600',
                    dragging && droppable && !armed && 'ring-4 ring-brand-400',
                    dragging && hovered && droppable && 'ring-brand-600',
                    occupied
                        ? stale
                            ? 'bg-danger-soft ring-danger text-danger-fg'
                            : 'bg-warn-soft ring-warn text-warn-fg'
                        : 'bg-ok-soft ring-ok text-ok-fg',
                )}
                aria-label={`${t('order.table')} ${groupNumbers ?? table.table_number}`}
            >
                <span className="text-lg font-bold">{groupNumbers ?? table.table_number}</span>
                {occupied && totals ? (
                    <>
                        <span className="text-sm font-semibold tabular-nums">{money(totals.roundedTotal)}</span>
                        {minutes !== null ? (
                            <span className="text-xs">{t('reg.floor.minutes', { count: minutes })}</span>
                        ) : null}
                    </>
                ) : (
                    <span className="text-xs">{t('reg.floor.seats', { count: groupSeats })}</span>
                )}
                {changes > 0 ? (
                    <span className="absolute end-1 top-1 min-w-5 rounded-full bg-warn px-1 text-xs font-bold text-white">
                        {changes}
                    </span>
                ) : null}
                {isChild ? (
                    <span className="absolute start-1 top-1 text-xs" aria-hidden>
                        🔗
                    </span>
                ) : null}
            </button>

            {/* Unlink sits on the child, because the child is the table that was pushed over.
                Separating the furniture leaves the bill on the parent; splitting the money is a
                different action (RST-052). */}
            {isChild && canUnlink ? (
                <button
                    type="button"
                    data-testid="table-unlink"
                    className="absolute end-1 bottom-1 z-20 rounded-pos bg-white/80 px-1 text-xs font-semibold text-slate-700"
                    onClick={onUnlink}
                    aria-label={`${t('reg.floor.unlink')} ${table.table_number}`}
                >
                    {t('reg.floor.unlink')}
                </button>
            ) : null}
        </div>
    );
}
