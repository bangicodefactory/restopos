import { Button, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useMemo } from 'react';

import { useT } from '../i18n';
import { currentDelta } from '../domain/kitchen-send';
import { createOrder } from '../domain/order-actions';
import { useCatalog, useMoney } from '../hooks/use-register';
import { orderTotals } from '../domain/totals';
import { draftOrders, floatingOrders, useOrderStore } from '../state/order-store';
import { useUiStore } from '../state/ui-store';

/**
 * Floating-order tabs (REG-119, REG-120, RST-146).
 *
 * Each tab is a parallel draft order; selecting one restores the screen it was left on, which is
 * stored with the order rather than in the UI store so a mid-payment reload does not lose context
 * (REG-125). The bubble is the unsent-kitchen-changes count for that tab.
 */

export function OrderTabs({ className }: { className?: string }): JSX.Element {
    const t = useT();
    const money = useMoney();
    const orders = useOrderStore((state) => state.orders);
    const selected = useOrderStore((state) => state.selectedOrderUuid);
    const selectOrder = useOrderStore((state) => state.selectOrder);
    const setScreen = useUiStore((state) => state.setScreen);
    const openDialog = useUiStore((state) => state.openDialog);
    const isRestaurant = useCatalog().config?.is_restaurant === true;

    // `orders` is the subscription; the snapshot is read once so the selector stays referentially
    // stable (a selector that built this array would re-render the bar on every keystroke).
    // In restaurant mode the tabs are the *floating* orders only — seated-table drafts live on the
    // floor plan, not the tab bar (REG-119); in retail mode every draft is floating.
    const tabs = useMemo(
        () => (orders ? (isRestaurant ? floatingOrders : draftOrders)(useOrderStore.getState()) : []),
        [orders, isRestaurant],
    );

    return (
        <div className={cn('flex items-center gap-2 overflow-x-auto border-b border-slate-200 bg-slate-50 px-2 py-1', className)}>
            {tabs.map((order) => {
                const unsent = currentDelta(order.uuid).nbrOfChanges;
                return (
                    <button
                        key={order.uuid}
                        type="button"
                        onDoubleClick={() => openDialog('orderName', { orderUuid: order.uuid })}
                        onClick={() => {
                            selectOrder(order.uuid);

                            // Restore where this order was left (REG-125) — except back into
                            // payment while the kitchen is still owed items. That would step
                            // straight past the send-first prompt (RST-143) and let the table be
                            // settled for food nobody is cooking; the order screen is where the
                            // cashier can see the unsent count and act on it.
                            const screen = order.orderScreen;
                            const restorable =
                                screen === 'payment' && unsent > 0 ? 'products' : screen;

                            if (restorable === 'payment' || restorable === 'receipt' || restorable === 'products') {
                                setScreen(restorable);
                            }
                        }}
                        className={cn(
                            'relative min-h-touch shrink-0 rounded-pos px-3 text-sm font-semibold ring-1 ring-inset',
                            order.uuid === selected
                                ? 'bg-white text-slate-900 ring-brand-400'
                                : 'bg-slate-200 text-slate-700 ring-transparent',
                        )}
                    >
                        {order.floating_order_name ?? order.receipt_number.slice(-4)}
                        <span className="ms-2 text-xs text-slate-500 tabular-nums">
                            {money(orderTotals(order.uuid).roundedTotal)}
                        </span>
                        {unsent > 0 ? (
                            <span className="absolute -end-1 -top-1 min-w-5 rounded-full bg-warn px-1 text-xs font-bold text-white">
                                {unsent}
                            </span>
                        ) : null}
                    </button>
                );
            })}

            <Button size="sm" variant="secondary" onClick={() => void createOrder()}>
                + {t('reg.order.newOrder')}
            </Button>
        </div>
    );
}
