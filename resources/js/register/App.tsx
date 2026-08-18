import { useSessionStore } from '@shared/auth';
import { useEcho, useIdle } from '@shared/store';
import { Button, useToast } from '@shared/ui';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { syncNow } from './boot';
import { DialogHost } from './components/DialogHost';
import { StatusStrip } from './components/StatusStrip';
import { tryRuntime } from './data/runtime';
import { REGISTER_EVENTS, reverbConfig, sessionChannel } from './realtime';
import { publishDisplay } from './domain/customer-display-bus';
import { applySessionClosedBroadcast } from './domain/session-actions';
import { fireCourseAndSend, sendToKitchen } from './domain/kitchen-send';
import { splitRemainder } from './domain/split-order';
import { cleanCourses, createOrder, markPrinted } from './domain/order-actions';
import { print } from './domain/printing';
import { buildBill } from './domain/receipt';
import { orderTotals } from './domain/totals';
import { useT } from './i18n';
import { useCatalog, useSelectedOrderUuid } from './hooks/use-register';
import { BootScreen } from './screens/BootScreen';
import { FloorEditorScreen } from './screens/FloorEditorScreen';
import { FloorScreen } from './screens/FloorScreen';
import { LoginScreen } from './screens/LoginScreen';
import { PairingScreen } from './screens/PairingScreen';
import { PaymentScreen } from './screens/PaymentScreen';
import { ProductScreen } from './screens/ProductScreen';
import { ReceiptScreen } from './screens/ReceiptScreen';
import { SessionScreen } from './screens/SessionScreen';
import { SplitScreen } from './screens/SplitScreen';
import { TicketScreen } from './screens/TicketScreen';
import { useBootStore, useSyncStore } from './state/boot-store';
import { linesOf, unsyncedCount, useOrderStore } from './state/order-store';
import { usePosSessionStore } from './state/session-store';
import { useUiStore } from './state/ui-store';

/**
 * The shell: chrome, routing and the cross-cutting behaviours that have nowhere else to live.
 *
 * "Routing" is a screen enum rather than a URL router on purpose — the PWA shell is propless and
 * byte-identical for every tenant so the service worker can precache it, and a deep link into a
 * half-restored order is a worse experience than landing on the floor plan.
 */

export function App(): JSX.Element {
    const t = useT();
    const toast = useToast();
    const catalog = useCatalog();
    const phase = useBootStore((state) => state.phase);
    const cashier = useSessionStore((state) => state.cashier);
    const session = usePosSessionStore((state) => state.session);
    const screen = useUiStore((state) => state.screen);
    const setScreen = useUiStore((state) => state.setScreen);
    const startTransfer = useUiStore((state) => state.startTransfer);
    const openDialog = useUiStore((state) => state.openDialog);
    const setReceiptOrder = useUiStore((state) => state.setReceiptOrder);
    const receiptOrderUuid = useUiStore((state) => state.receiptOrderUuid);
    const selectedOrderUuid = useSelectedOrderUuid();
    const selectOrder = useOrderStore((state) => state.selectOrder);

    // A session closed on another till (REG-024). The register subscribes to nothing else — the
    // outbox carries everything that originates *here* — but a session ending somewhere else is a
    // fact this device cannot derive, and a till still ringing sales into frozen summaries is a
    // reconciliation problem that surfaces days later.
    const reverb = useMemo(() => reverbConfig(tryRuntime()?.device?.token ?? null), []);
    const sessionEvents = useMemo(
        () => ({
            [REGISTER_EVENTS.sessionClosed]: (payload: unknown) => {
                if (applySessionClosedBroadcast(payload)) {
                    toast.show({ tone: 'warn', title: t('error.sessionClosed') });
                }
            },
        }),
        [t, toast],
    );

    useEcho({
        config: reverb,
        channel: session !== null && session.state !== 'closed' ? sessionChannel(session.id) : null,
        visibility: 'private',
        events: sessionEvents,
    });

    const [locked, setLocked] = useState(false);
    const [sessionPane, setSessionPane] = useState<'open' | 'close' | null>(null);

    // Leaving the product screen drops trailing empty courses so the next screen and the receipt do
    // not show phantom courses (RST-087).
    const prevScreen = useRef(screen);
    useEffect(() => {
        if (prevScreen.current === 'products' && screen !== 'products' && selectedOrderUuid !== null) {
            cleanCourses(selectedOrderUuid);
        }
        prevScreen.current = screen;
    }, [screen, selectedOrderUuid]);

    // ── idle lock (REG-049 / RST-014) ────────────────────────────────────────
    const idleSeconds = catalog.config?.employee_idle_logout_seconds ?? 300;
    useIdle({
        timeoutMs: Math.max(60, idleSeconds) * 1000,
        enabled: phase === 'ready' && cashier !== null && screen !== 'payment',
        onIdle: () => {
            if (catalog.config?.is_restaurant) setScreen('floor');
            setLocked(true);
        },
    });

    // ── unsynced-orders guard on unload (spec 03 §3.6.6) ─────────────────────
    useEffect(() => {
        const handler = (event: BeforeUnloadEvent): void => {
            if (unsyncedCount(useOrderStore.getState()) === 0) return;
            event.preventDefault();
            event.returnValue = t('reg.sync.unloadGuard');
        };
        globalThis.addEventListener?.('beforeunload', handler);
        return () => globalThis.removeEventListener?.('beforeunload', handler);
    }, [t]);

    // ── connectivity + outbox stats into the status strip ────────────────────
    useEffect(() => {
        const online = (): void => useSyncStore.getState().setOnline(true);
        const offline = (): void => useSyncStore.getState().setOnline(false);
        globalThis.addEventListener?.('online', online);
        globalThis.addEventListener?.('offline', offline);

        const runtime = tryRuntime();
        const unsubscribe = runtime?.syncer.subscribe((event) => {
            if (event.type === 'stats') useSyncStore.getState().setStats(event.stats);
            if (event.type === 'drain:end' && event.sent > 0) useSyncStore.getState().noteSync();
        });

        const timer = setInterval(() => void runtime?.syncer.stats(), 5_000);
        return () => {
            globalThis.removeEventListener?.('online', online);
            globalThis.removeEventListener?.('offline', offline);
            unsubscribe?.();
            clearInterval(timer);
        };
    }, []);

    // ── mirror the order to the customer display (REG-350 / REG-351) ─────────
    useEffect(() =>
        useOrderStore.subscribe((state) => {
            const uuid = state.selectedOrderUuid;
            if (uuid === null) {
                publishDisplay({ kind: 'idle', venue: catalog.company?.name ?? null, at: Date.now() });
                return;
            }
            const order = state.orders[uuid];
            if (!order) return;
            const totals = orderTotals(uuid, state);
            publishDisplay({
                kind: order.state === 'paid' ? 'paid' : 'order',
                venue: catalog.company?.name ?? null,
                lines: linesOf(state, uuid).map((line) => ({
                    name: line.full_product_name,
                    quantity: line.quantity,
                    unitPrice: line.price_unit,
                    total: totals.perLine[line.uuid]?.priceTotal ?? '0',
                    note: line.customer_note,
                })),
                subtotal: totals.subtotal,
                tax: totals.tax,
                total: totals.roundedTotal,
                paid: totals.paid,
                due: totals.due,
                change: totals.change,
                currency: catalog.currencyFormat,
                at: Date.now(),
            });
        }),
    [catalog.company?.name, catalog.currencyFormat]);

    /**
     * Returns whether the kitchen actually has it now — `sent`, or `nothing` because there was
     * nothing left to send. A refusal (`outdated`, another device fired it first) and a failure are
     * both false, so a caller chaining onto this does not proceed as if the food were on its way
     * (RST-143).
     */
    const onSend = useCallback(async (): Promise<boolean> => {
        if (selectedOrderUuid === null) return false;
        const outcome = await sendToKitchen(selectedOrderUuid);
        if (outcome.status === 'needs_name') {
            // RST-141 — a collection order with no table needs something the pass can call out.
            openDialog('orderName');
            toast.show({ tone: 'warn', title: t('reg.order.nameRequired') });

            return false;
        }
        if (outcome.status === 'needs_guests') {
            // RST-072 — this service mode plates to a cover count, and the order has none. Ask for
            // it rather than sending a ticket the kitchen cannot work from; the same dialog the
            // guests button opens, so there is one place the number is entered.
            openDialog('guests');
            toast.show({ tone: 'warn', title: t('reg.order.guestsRequired') });
            return false;
        }
        if (outcome.status === 'outdated') {
            toast.show({ tone: 'warn', title: t('reg.order.sentOutdated') });
            return false;
        }
        if (outcome.status === 'sent') {
            toast.show({ tone: 'success', title: t('reg.order.sentOk') });
        }
        return outcome.status === 'sent' || outcome.status === 'nothing';
    }, [openDialog, selectedOrderUuid, t, toast]);

    const onFireCourse = useCallback(
        async (courseUuid: string) => {
            if (selectedOrderUuid === null) return;
            const outcome = await fireCourseAndSend(selectedOrderUuid, courseUuid);
            if (outcome.status === 'outdated') {
                toast.show({ tone: 'warn', title: t('reg.order.sentOutdated') });
                return;
            }
            if (outcome.status === 'sent') {
                toast.show({ tone: 'success', title: t('reg.order.sentOk') });
            }
        },
        [selectedOrderUuid, t, toast],
    );

    const onBill = useCallback(async () => {
        const runtime = tryRuntime();
        if (!runtime || selectedOrderUuid === null) return;
        const doc = buildBill(useOrderStore.getState(), selectedOrderUuid, {
            cashierName: cashier?.name ?? null,
        });
        if (!doc) return;
        // RST-110 — the pro forma never increments `nb_print`.
        await print(runtime.printer, doc, { role: 'receipt' });
        toast.show({ tone: 'info', title: t('reg.receipt.proforma') });
    }, [cashier?.name, selectedOrderUuid, t, toast]);

    if (phase === 'pairing') return <PairingScreen />;
    if (phase === 'starting' || phase === 'bootstrapping' || phase === 'error' || phase === 'reloading') {
        return <BootScreen />;
    }
    if (cashier === null) return <LoginScreen onDone={() => setLocked(false)} />;
    if (locked) return <LoginScreen mode="lock" onDone={() => setLocked(false)} />;

    if (sessionPane !== null) {
        return <SessionScreen mode={sessionPane} onDone={() => setSessionPane(null)} />;
    }
    if (session === null || session.state === 'closed' || session.state === 'opening_control') {
        return <SessionScreen mode="open" onDone={() => setSessionPane(null)} />;
    }

    return (
        <div className="flex h-dvh flex-col bg-slate-100">
            <StatusStrip />

            <nav className="flex shrink-0 gap-1 border-b border-slate-200 bg-white px-2 py-1">
                {catalog.config?.is_restaurant ? (
                    <NavButton active={screen === 'floor'} onClick={() => setScreen('floor')}>
                        {t('reg.nav.floor')}
                    </NavButton>
                ) : null}
                <NavButton active={screen === 'products'} onClick={() => setScreen('products')}>
                    {t('reg.nav.products')}
                </NavButton>
                <NavButton active={screen === 'tickets'} onClick={() => setScreen('tickets')}>
                    {t('reg.nav.tickets')}
                </NavButton>

                <span className="ms-auto flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openDialog('cashMove')}>
                        {t('reg.nav.cashMove')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void syncNow()}>
                        {t('reg.sync.now')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setLocked(true)}>
                        {t('reg.login.lockNow')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setSessionPane('close')}>
                        {t('reg.nav.closeSession')}
                    </Button>
                </span>
            </nav>

            <main className="flex min-h-0 flex-1 flex-col">
                {screen === 'floor' ? (
                    <FloorScreen
                        onOpenOrder={(uuid) => {
                            selectOrder(uuid);
                            setScreen('products');
                        }}
                        onEditRoom={() => setScreen('floorEditor')}
                    />
                ) : null}

                {screen === 'floorEditor' ? <FloorEditorScreen onExit={() => setScreen('floor')} /> : null}

                {screen === 'products' ? (
                    <ProductScreen
                        onPay={() => {
                            if (selectedOrderUuid !== null) setScreen('payment');
                        }}
                        onFastPaid={() => {
                            setReceiptOrder(selectedOrderUuid);
                            setScreen('receipt');
                        }}
                        onSend={() => void onSend()}
                        onFireCourse={(courseUuid) => void onFireCourse(courseUuid)}
                        onBill={() => void onBill()}
                        onSplit={() => setScreen('split')}
                        onTransfer={() => startTransfer(selectedOrderUuid)}
                    />
                ) : null}

                {screen === 'payment' && selectedOrderUuid !== null ? (
                    <PaymentScreen
                        orderUuid={selectedOrderUuid}
                        onBack={() => setScreen('products')}
                        onValidated={() => {
                            setReceiptOrder(selectedOrderUuid);
                            setScreen('receipt');
                        }}
                    />
                ) : null}

                {screen === 'receipt' && receiptOrderUuid !== null ? (
                    <ReceiptScreen
                        orderUuid={receiptOrderUuid}
                        remainder={splitRemainder(receiptOrderUuid)}
                        onContinueSplit={(uuid) => {
                            markPrinted(receiptOrderUuid);
                            selectOrder(uuid);
                            setScreen('payment');
                        }}
                        onBack={() => setScreen('products')}
                        onNewOrder={async () => {
                            markPrinted(receiptOrderUuid);
                            const uuid = await createOrder();
                            selectOrder(uuid);
                            setScreen(catalog.config?.is_restaurant ? 'floor' : 'products');
                        }}
                    />
                ) : null}

                {screen === 'tickets' ? (
                    <TicketScreen
                        onOpenOrder={(uuid) => {
                            selectOrder(uuid);
                            setScreen('products');
                        }}
                    />
                ) : null}

                {screen === 'split' && selectedOrderUuid !== null ? (
                    <SplitScreen
                        orderUuid={selectedOrderUuid}
                        onCancel={() => setScreen('products')}
                        onDone={(splitUuid) => {
                            selectOrder(splitUuid);
                            setScreen('payment');
                        }}
                    />
                ) : null}
            </main>

            <DialogHost
                onSend={onSend}
                onPay={() => {
                    if (selectedOrderUuid !== null) setScreen('payment');
                }}
            />
        </div>
    );
}

function NavButton({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
}): JSX.Element {
    return (
        <Button size="md" variant={active ? 'primary' : 'ghost'} onClick={onClick}>
            {children}
        </Button>
    );
}
