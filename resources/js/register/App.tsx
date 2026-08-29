import { useSessionStore } from '@shared/auth';
import { useEcho, useIdle } from '@shared/store';
import { Button, useToast } from '@shared/ui';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { pullDelta, syncNow } from './boot';
import { DialogHost } from './components/DialogHost';
import { StatusStrip } from './components/StatusStrip';
import { tryRuntime } from './data/runtime';
import {
    REGISTER_EVENTS,
    configChannel,
    isSelfEcho,
    realtimeBadge,
    reverbConfig,
    sessionChannel,
    startDeltaScheduler,
} from './realtime';
import { createDisplayRelay, publishDisplay, setDisplayRelay } from './domain/customer-display-bus';
import { applySessionClosedBroadcast } from './domain/session-actions';
import { canOpenOrder, foreignOrder } from './domain/foreign-order';
import {
    explicitReprint,
    fireCourseAndSend,
    sendToKitchen,
    type SendCategoryCount,
} from './domain/kitchen-send';
import { splitRemainder } from './domain/split-order';
import { cleanCourses, createOrder, markPrinted } from './domain/order-actions';
import { print } from './domain/printing';
import { buildBill } from './domain/receipt';
import { orderTotals } from './domain/totals';
import { useT } from './i18n';
import { useCatalog, useSelectedOrderUuid } from './hooks/use-register';
import type { Screen } from './state/ui-store';
import { BootScreen } from './screens/BootScreen';
import { FloorEditorScreen } from './screens/FloorEditorScreen';
import { FloorScreen } from './screens/FloorScreen';
import { LoginScreen } from './screens/LoginScreen';
import { SecondTabScreen } from './screens/SecondTabScreen';
import { PairingScreen } from './screens/PairingScreen';
import { PaymentScreen } from './screens/PaymentScreen';
import { ProductScreen } from './screens/ProductScreen';
import { ReceiptScreen } from './screens/ReceiptScreen';
import { SessionScreen } from './screens/SessionScreen';
import { SplitScreen } from './screens/SplitScreen';
import { TipScreen } from './screens/TipScreen';
import { TicketScreen } from './screens/TicketScreen';
import { useBootStore, useSyncStore } from './state/boot-store';
import { linesOf, unsyncedCount, useOrderStore } from './state/order-store';
import { usePosSessionStore } from './state/session-store';
import { useUiStore } from './state/ui-store';
import { useTabRole } from './state/use-tab-role';

/**
 * The shell: chrome, routing and the cross-cutting behaviours that have nowhere else to live.
 *
 * "Routing" is a screen enum rather than a URL router on purpose — the PWA shell is propless and
 * byte-identical for every tenant so the service worker can precache it, and a deep link into a
 * half-restored order is a worse experience than landing on the floor plan.
 */

/** `1.5` prints as `1.5`, `2.000` as `2` — a weighed item keeps its decimals, a countable one does not. */
function countText(count: number): string {
    return Number.isInteger(count) ? String(count) : String(Number(count.toFixed(3)));
}

/**
 * KDS-061 — "3 Plats · 2 Boissons" under the send confirmation.
 *
 * Returns a spread-able fragment rather than a string so an order with a single uncategorised line
 * produces no second line at all: a toast that reads "Sent / 1 Other" is noise, and a toast with an
 * empty body is a layout bug.
 */
function sentSummary(
    summary: readonly SendCategoryCount[],
    t: ReturnType<typeof useT>,
): { message?: string } {
    const message = summary
        .map((entry) => `${countText(entry.count)} ${entry.name || t('reg.order.sentUncategorised')}`)
        .join(' · ');

    return message.length > 0 ? { message } : {};
}

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

    /**
     * Realtime (REG-365…REG-368). Two subscriptions, because they answer two different questions
     * and have two different lifetimes.
     *
     * `pos.session.{id}` is alive only while this till is trading, and carries the one fact the
     * outbox can never deliver: the shift ended somewhere else. `pos.config.{access_token}` is alive
     * for the whole shell and carries the peer traffic — an order another till changed, a table
     * another till seated. Neither event is trusted as data: each one asks for a delta pull, and
     * the pull is what is authoritative.
     */
    // Read every render, and memoised on the token itself rather than on `[]` (BAN-402a).
    //
    // `main.tsx` renders this component and only *then* calls `boot()`, which awaits twice
    // before `setRuntime()`. So at first render `tryRuntime()` is null, and a mount-time memo
    // baked `token: null` and `deviceUuid: null` in for the life of the tab. That is not
    // hypothetical — it is what master does, and it is why the register has never actually
    // received a broadcast: every channel is private, `/broadcasting/auth` 401s without a
    // bearer, and `useEcho` still reported `connected` from the socket state.
    //
    // The runtime lands during boot, `phase` changes, this re-renders, and the token appears.
    // Depending on the token rather than on a proxy signal keeps the dependency honest: it is
    // the value the memo actually uses, so nobody can "tidy up an unnecessary dep" and
    // silently restore the bug.
    const device = tryRuntime()?.device ?? null;
    const deviceToken = device?.token ?? null;
    const deviceUuid = device?.info.uuid ?? null;
    const reverb = useMemo(() => reverbConfig(deviceToken), [deviceToken]);
    const setRealtime = useSyncStore((state) => state.setRealtime);

    const sessionEvents = useMemo(
        () => ({
            [REGISTER_EVENTS.sessionClosed]: (payload: unknown) => {
                // Not filtered on `emitted_by_device_uuid`: the device that closed the session has
                // already moved its own store off an open session, so `applySessionClosedBroadcast`
                // returns false for it anyway — and that check also covers a *user* closing from
                // the back office, where there is no emitting device at all.
                if (applySessionClosedBroadcast(payload)) {
                    toast.show({ tone: 'warn', title: t('error.sessionClosed') });
                }
            },
        }),
        [t, toast],
    );

    const sessionStatus = useEcho({
        config: reverb,
        channel: session !== null && session.state !== 'closed' ? sessionChannel(session.id) : null,
        visibility: 'private',
        events: sessionEvents,
    });

    /**
     * The delta scheduler outlives every event handler, so it is a ref rather than state: a new
     * timer per render would reset the interval on every keystroke and pull far more often than
     * once every 30 s.
     */
    const scheduler = useRef<ReturnType<typeof startDeltaScheduler> | null>(null);

    useEffect(() => {
        const running = startDeltaScheduler({
            pull: pullDelta,
            isOnline: () => useSyncStore.getState().online,
            isPaymentInFlight: () => useSyncStore.getState().paymentInFlight,
        });
        scheduler.current = running;

        return () => {
            scheduler.current = null;
            running.stop();
        };
    }, []);

    const configEvents = useMemo(() => {
        const onPeerChange = (payload: unknown): void => {
            // This till's own write, echoed back. Pulling on it would overwrite the copy the
            // cashier is still looking at with the copy they just sent.
            if (isSelfEcho(payload, deviceUuid)) return;
            scheduler.current?.request();
        };

        return {
            [REGISTER_EVENTS.orderSynced]: onPeerChange,
            [REGISTER_EVENTS.tableState]: onPeerChange,
        };
    }, [deviceUuid]);

    const configToken = catalog.config?.access_token ?? null;

    const configStatus = useEcho({
        config: reverb,
        channel: configToken === null ? null : configChannel(configToken),
        visibility: 'private',
        events: configEvents,
    });

    // The status strip read `off` forever before this: `setRealtime` was declared, read by
    // `StatusStrip`, and called by nobody. The config channel is the one that matters for peer
    // traffic, so it is the one the badge reports.
    useEffect(() => {
        setRealtime(realtimeBadge(configStatus, reverb !== null && configToken !== null));
    }, [configStatus, configToken, reverb, setRealtime]);

    // A reconnect must not wait a whole interval to catch up on what it missed while down.
    useEffect(() => {
        if (configStatus === 'connected' || sessionStatus === 'connected') scheduler.current?.request();
    }, [configStatus, sessionStatus]);

    /**
     * One writer per register (REG-374). Placed with the other shell-level state because the
     * follower state is a whole-screen condition, not a per-button one: a second tab must not be a
     * till with some buttons disabled, or a cashier will find the one that still works.
     */
    const tabRole = useTabRole(catalog.config?.id ?? null);

    const [locked, setLocked] = useState(false);
    const [sessionPane, setSessionPane] = useState<'open' | 'close' | null>(null);
    const [foreignBlocked, setForeignBlocked] = useState<string | null>(null);

    /**
     * The one way into an order (REG-373).
     *
     * A trusted peer's bill in another currency must not be opened — the amounts are in a unit this
     * till does not use, and it would offer local tenders against them. The check sits here rather
     * than on each screen because there are three ways in: the ticket list, the floor plan and the
     * tab bar. A guard on one of them is a guard one of them has, which is what the first version of
     * this was (review of #76).
     *
     * Refused out loud. A tap that silently does nothing reads as a broken till.
     */
    const openOrder = (uuid: string, screen: Screen): void => {
        const order = useOrderStore.getState().orders[uuid];

        if (order && !canOpenOrder(order, catalog.config)) {
            const peer = foreignOrder(order, catalog.config);

            setForeignBlocked(
                peer?.registerName
                    ? t('reg.tickets.otherCurrency', { name: peer.registerName })
                    : t('reg.tickets.unknownRegister'),
            );
            return;
        }

        setForeignBlocked(null);
        selectOrder(uuid);
        setScreen(screen);
    };

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

    /**
     * The display's remote leg (REG-352).
     *
     * `publishDisplay` has always posted to `BroadcastChannel`, which reaches a second monitor on
     * this machine and nothing else. A display on a separate device — the normal restaurant
     * wiring — could not be driven at all. The relay posts the same frame to the server, which
     * broadcasts it on the display's public channel.
     *
     * Installed only when the config carries a display token, because that token is what names the
     * channel *and* what the pairing dialog puts in the URL: no token, no second device to reach,
     * and `BroadcastChannel` carries on alone.
     */
    const displayToken = catalog.config?.customer_display_token ?? null;

    useEffect(() => {
        if (displayToken === null) return;

        setDisplayRelay(
            createDisplayRelay({
                send: (payload) => {
                    // Fire and forget, and swallow the failure. A frame that does not land costs a
                    // display one keystroke behind, and the next frame supersedes it — whereas
                    // retrying would push a stale picture in front of a fresh one, and surfacing it
                    // would put a network toast in front of a cashier for a screen they are not
                    // looking at.
                    void tryRuntime()
                        ?.api.post('pos/customer-display', { payload })
                        .catch(() => {});
                },
            }),
        );

        return () => setDisplayRelay(null);
    }, [displayToken]);

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
            toast.show({ tone: 'success', title: t('reg.order.sentOk'), ...sentSummary(outcome.summary, t) });
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
                toast.show({ tone: 'success', title: t('reg.order.sentOk'), ...sentSummary(outcome.summary, t) });
            }
        },
        [selectedOrderUuid, t, toast],
    );

    /**
     * KDS-059 — put the last kitchen ticket on paper again, and nothing else.
     *
     * Deliberately not routed through `onSend`: by the time a jam is noticed the delta has already
     * been consumed, so a re-send would print an empty ticket, and a re-fire would tell the pass to
     * cook a second time. The reprint replays the retained document.
     */
    const onReprintPrep = useCallback(async () => {
        if (selectedOrderUuid === null) return;
        const outcome = await explicitReprint(selectedOrderUuid);
        if (outcome.status === 'nothing') {
            toast.show({ tone: 'warn', title: t('reg.order.reprintNothing') });
            return;
        }
        if (outcome.status === 'failed' || outcome.printed === 0) {
            toast.show({ tone: 'danger', title: t('reg.order.reprintFailed') });
            return;
        }
        toast.show({ tone: 'success', title: t('reg.order.reprintOk') });
    }, [selectedOrderUuid, t, toast]);

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
    // Before the login gate on purpose: an accidental second tab should say why immediately,
    // rather than asking for a PIN and only then refusing to sell.
    if (tabRole === 'follower') return <SecondTabScreen />;

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
                {/* RST-127 — the shift pass. Reachable on its own, because settling a stack of
                    slips is a job a manager starts, not something they arrive at from a sale. */}
                {catalog.config?.enable_tips ? (
                    <NavButton active={screen === 'tip'} onClick={() => setScreen('tip')}>
                        {t('reg.tip.title')}
                    </NavButton>
                ) : null}
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
                    {/* REG-356 — the display route has existed since the display was built and
                        nothing in the till ever linked to it. */}
                    <Button
                        size="sm"
                        variant="ghost"
                        data-testid="nav-customer-display"
                        onClick={() => openDialog('customerDisplay')}
                    >
                        {t('reg.nav.customerDisplay')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setLocked(true)}>
                        {t('reg.login.lockNow')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setSessionPane('close')}>
                        {t('reg.nav.closeSession')}
                    </Button>
                </span>
            </nav>

            {foreignBlocked !== null ? (
                <p
                    className="bg-warn-soft px-3 py-2 font-semibold text-warn-fg"
                    data-testid="foreign-order-blocked"
                >
                    {foreignBlocked} —{' '}
                    <button type="button" className="underline" onClick={() => setForeignBlocked(null)}>
                        {t('common.close')}
                    </button>
                </p>
            ) : null}

            <main className="flex min-h-0 flex-1 flex-col">
                {screen === 'floor' ? (
                    <FloorScreen
                        onOpenOrder={(uuid) => openOrder(uuid, 'products')}
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
                        onReprintPrep={() => void onReprintPrep()}
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
                            // RST-122 — the sale is settled and the tab is not finished. Straight to
                            // the tip screen, which is the whole point of the mode: the slip prints,
                            // comes back signed, and the number is keyed while the customer is still
                            // at the table.
                            setScreen(
                                catalog.config?.enable_tips && catalog.config?.tip_after_payment
                                    ? 'tip'
                                    : 'receipt',
                            );
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

                {screen === 'tip' ? (
                    <TipScreen orderUuid={receiptOrderUuid} onDone={() => setScreen('tickets')} />
                ) : null}

                {screen === 'tickets' ? (
                    <TicketScreen onOpenOrder={(uuid) => openOrder(uuid, 'products')} />
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
