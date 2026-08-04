import { useEcho, useOnline, usePollingFallback } from '@shared/store';
import { LoadingPane } from '@shared/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { Notice, useVenueTheme } from './components/Brand';
import { CartScreen } from './components/Cart';
import { AttractScreen, IdleDialog, InstallPrompt, useKioskIdle } from './components/Kiosk';
import { Landing, PresetPicker } from './components/Landing';
import { MenuScreen } from './components/Menu';
import { ProductSheet } from './components/ProductSheet';
import { CheckoutScreen, HistoryScreen, StatusScreen } from './components/Status';
import { useT, type Locale } from './i18n';
import { canOrder, isConsultation, isKiosk } from './logic/availability';
import { cartCount, cartTotals, type CartDraft } from './logic/cart';
import { toSimpleCartLine } from './logic/combo';
import { STATUS_POLL_MS, SELF_ORDER_EVENTS, menuChannel, orderChannel, reverbConfig } from './realtime';
import { getCatalog, readPendingReference, useSelfOrderStore } from './store';
import type { MenuProduct } from './catalog';

/**
 * The self-order app.
 *
 * One component tree serving consultation, mobile and kiosk. The differences are three booleans
 * derived from the venue's config — `ordering`, `kiosk`, `consultation` — rather than three routers,
 * because they are three *configurations* of one product and a customer who scans a QR at a venue
 * that flipped from consultation to mobile this morning must simply get the ordering buttons.
 */
export function App({ configToken, tableToken }: { configToken: string; tableToken: string | null }): JSX.Element {
    const t = useT();
    const browserOnline = useOnline();

    const phase = useSelfOrderStore((state) => state.phase);
    const fatal = useSelfOrderStore((state) => state.fatal);
    const offline = useSelfOrderStore((state) => state.offline);
    const setOffline = useSelfOrderStore((state) => state.setOffline);
    const config = useSelfOrderStore((state) => state.config);
    const table = useSelfOrderStore((state) => state.table);
    const screen = useSelfOrderStore((state) => state.screen);
    const catalogVersion = useSelfOrderStore((state) => state.catalogVersion);
    const cart = useSelfOrderStore((state) => state.cart);
    const cartIssues = useSelfOrderStore((state) => state.cartIssues);
    const detailProductId = useSelfOrderStore((state) => state.detailProductId);
    const editingLineUuid = useSelfOrderStore((state) => state.editingLineUuid);
    const presetId = useSelfOrderStore((state) => state.presetId);
    const standNumber = useSelfOrderStore((state) => state.standNumber);
    const customerNote = useSelfOrderStore((state) => state.customerNote);
    const submitting = useSelfOrderStore((state) => state.submitting);
    const submitError = useSelfOrderStore((state) => state.submitError);
    const activeOrder = useSelfOrderStore((state) => state.activeOrder);
    const trackingStep = useSelfOrderStore((state) => state.trackingStep);
    const paymentPending = useSelfOrderStore((state) => state.paymentPending);
    const knownOrders = useSelfOrderStore((state) => state.knownOrders);
    const prefs = useSelfOrderStore((state) => state.prefs);

    const boot = useSelfOrderStore((state) => state.boot);
    const refreshMenu = useSelfOrderStore((state) => state.refreshMenu);
    const go = useSelfOrderStore((state) => state.go);
    const openProduct = useSelfOrderStore((state) => state.openProduct);
    const closeProduct = useSelfOrderStore((state) => state.closeProduct);
    const addToCart = useSelfOrderStore((state) => state.addToCart);
    const changeQuantity = useSelfOrderStore((state) => state.changeQuantity);
    const removeFromCart = useSelfOrderStore((state) => state.removeFromCart);
    const setPreset = useSelfOrderStore((state) => state.setPreset);
    const setStandNumber = useSelfOrderStore((state) => state.setStandNumber);
    const setCustomerNote = useSelfOrderStore((state) => state.setCustomerNote);
    const dismissIssues = useSelfOrderStore((state) => state.dismissIssues);
    const submit = useSelfOrderStore((state) => state.submit);
    const cancelActiveOrder = useSelfOrderStore((state) => state.cancelActiveOrder);
    const payOnline = useSelfOrderStore((state) => state.payOnline);
    const resumePayment = useSelfOrderStore((state) => state.resumePayment);
    const pollStatus = useSelfOrderStore((state) => state.pollStatus);
    const openKnownOrder = useSelfOrderStore((state) => state.openKnownOrder);
    const setLocale = useSelfOrderStore((state) => state.setLocale);
    const dismissInstall = useSelfOrderStore((state) => state.dismissInstall);
    const resetSession = useSelfOrderStore((state) => state.resetSession);

    const booted = useRef(false);
    useEffect(() => {
        if (booted.current) return;
        booted.current = true;
        void boot(configToken, tableToken);
    }, [boot, configToken, tableToken]);

    // Keep the store's offline flag on the live network state so the online-only guards and the
    // disabled checkout buttons react the instant the connection drops or returns (BAN-450).
    useEffect(() => {
        setOffline(!browserOnline);
    }, [browserOnline, setOffline]);

    useVenueTheme(config);

    // The catalog lives outside the store; the version counter is what makes it reactive.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `catalogVersion` is the cache key.
    const catalog = useMemo(() => getCatalog(), [catalogVersion]);

    const ordering = config ? canOrder(config) : false;
    const kiosk = config ? isKiosk(config) : false;
    const consultation = config ? isConsultation(config) : false;

    // ── realtime (SLF-026, SLF-082) ─────────────────────────────────────────
    const reverb = useMemo(() => reverbConfig(), []);
    const [menuDegraded, setMenuDegraded] = useState(true);

    const menuEvents = useMemo(
        () => ({
            // Thin event: an id and a hint. Re-pull rather than trusting the payload.
            [SELF_ORDER_EVENTS.catalogChanged]: () => void refreshMenu(),
        }),
        [refreshMenu],
    );

    useEcho({
        config: reverb,
        channel: phase === 'ready' ? menuChannel(configToken) : null,
        visibility: 'public',
        events: menuEvents,
        onDegraded: setMenuDegraded,
    });

    const orderEvents = useMemo(
        () => ({
            [SELF_ORDER_EVENTS.orderState]: () => void pollStatus(),
            [SELF_ORDER_EVENTS.paymentStatus]: () => void pollStatus(),
            [SELF_ORDER_EVENTS.selfOrderPlaced]: () => void pollStatus(),
        }),
        [pollStatus],
    );

    const orderStatus = useEcho({
        config: reverb,
        channel: activeOrder ? orderChannel(activeOrder.access_token) : null,
        visibility: 'public',
        events: orderEvents,
    });

    // The status screen polls whenever the socket is not proven healthy. A customer staring at
    // "preparing" while their food goes cold at the pass is the failure this prevents.
    const watchingOrder = screen === 'status' && activeOrder !== null;
    const poll = useCallback(() => void pollStatus(), [pollStatus]);
    usePollingFallback(watchingOrder && orderStatus !== 'connected', poll, STATUS_POLL_MS);

    // A menu that could not subscribe still refreshes, just lazily.
    const refreshMenuNow = useCallback(() => void refreshMenu(), [refreshMenu]);
    usePollingFallback(phase === 'ready' && menuDegraded && browserOnline, refreshMenuNow, 120_000);

    // ── returning from a payment redirect ───────────────────────────────────
    const resumed = useRef(false);
    useEffect(() => {
        if (resumed.current || !activeOrder) return;
        const pending = readPendingReference(configToken);
        if (!pending || pending.orderUuid !== activeOrder.uuid) return;
        resumed.current = true;
        void resumePayment(pending.reference);
    }, [activeOrder, configToken, resumePayment]);

    // ── kiosk idle (SLF-090) ────────────────────────────────────────────────
    const idle = useKioskIdle({
        enabled: kiosk && phase === 'ready' && screen !== 'landing',
        idleSeconds: config?.kiosk_idle_seconds ?? 90,
        confirmSeconds: config?.kiosk_confirmation_seconds ?? 30,
        onReset: resetSession,
    });

    const totals = useMemo(() => (catalog ? cartTotals(cart, catalog) : null), [cart, catalog]);
    const count = cartCount(cart);

    const quickAdd = useCallback(
        (product: MenuProduct) => {
            if (!catalog) return;
            const draft = toSimpleCartLine(catalog, product, [], 1, null);
            if (draft) addToCart(draft, []);
        },
        [catalog, addToCart],
    );

    const onSheetAdd = useCallback(
        (draft: CartDraft, children: readonly CartDraft[]) => addToCart(draft, children),
        [addToCart],
    );

    if (phase === 'booting') return <LoadingPane label={t('common.loading')} />;

    if (phase === 'dead' || !config || !catalog || !totals) {
        return (
            <div className="flex min-h-full items-center justify-center p-8 text-center">
                <p className="text-2xl font-bold text-slate-700">{t(fatal ?? 'so.error.load')}</p>
            </div>
        );
    }

    const detailProduct = detailProductId === null ? null : (catalog.productsById.get(detailProductId) ?? null);

    // A kiosk sitting on the landing screen is an attract screen, not a web page.
    if (kiosk && screen === 'landing') {
        return (
            <AttractScreen
                config={config}
                locale={prefs.locale ?? 'fr'}
                onLocale={(locale: Locale) => setLocale(locale)}
                onStart={() => go(catalog.presets.length > 0 ? 'presets' : 'menu')}
            />
        );
    }

    return (
        <>
            {offline && <Notice tone="warn">{t('so.error.offline')}</Notice>}

            {screen === 'landing' && (
                <Landing
                    config={config}
                    catalog={catalog}
                    table={table}
                    locale={prefs.locale ?? 'fr'}
                    hasOrders={knownOrders.length > 0}
                    onLocale={setLocale}
                    onStart={() => go(catalog.presets.length > 0 && !table ? 'presets' : 'menu')}
                    onBrowse={() => go('menu')}
                    onHistory={() => go('history')}
                />
            )}

            {screen === 'presets' && (
                <PresetPicker
                    catalog={catalog}
                    config={config}
                    hasTable={table !== null}
                    selected={presetId}
                    onSelect={(preset) => {
                        setPreset(preset.id === 0 ? null : preset.id);
                        go('menu');
                    }}
                    onBack={() => go('landing')}
                />
            )}

            {screen === 'menu' && (
                <MenuScreen
                    catalog={catalog}
                    now={new Date()}
                    cartCount={count}
                    cartTotal={totals.display}
                    ordering={ordering}
                    kiosk={kiosk}
                    onOpenProduct={(productId) => openProduct(productId)}
                    onQuickAdd={quickAdd}
                    onCart={() => go('cart')}
                    onBack={() => go('landing')}
                />
            )}

            {screen === 'cart' && (
                <CartScreen
                    catalog={catalog}
                    config={config}
                    cart={cart}
                    totals={totals}
                    issues={cartIssues}
                    standNumber={standNumber}
                    customerNote={customerNote}
                    kiosk={kiosk}
                    submitting={submitting}
                    error={submitError}
                    onQuantity={changeQuantity}
                    onRemove={removeFromCart}
                    onEdit={(productId, uuid) => openProduct(productId, uuid)}
                    onStandNumber={setStandNumber}
                    onCustomerNote={setCustomerNote}
                    onDismissIssues={dismissIssues}
                    onCheckout={() => go('checkout')}
                    onBack={() => go('menu')}
                />
            )}

            {screen === 'checkout' && (
                <CheckoutScreen
                    config={config}
                    total={totals.display}
                    submitting={submitting}
                    offline={offline}
                    error={submitError}
                    onPayCashier={() => void submit()}
                    onPayOnline={() => {
                        void (async () => {
                            if (await submit()) await payOnline();
                        })();
                    }}
                    onBack={() => go('cart')}
                />
            )}

            {screen === 'status' && (
                <StatusScreen
                    order={activeOrder}
                    step={trackingStep}
                    offline={offline}
                    paymentPending={paymentPending}
                    canCancel={activeOrder?.state === 'draft'}
                    onCancel={() => void cancelActiveOrder()}
                    onNewOrder={() => go(kiosk ? 'landing' : 'menu')}
                    onHistory={() => go('history')}
                />
            )}

            {screen === 'history' && (
                <HistoryScreen
                    orders={knownOrders}
                    onOpen={(order) => void openKnownOrder(order)}
                    onBack={() => go('landing')}
                />
            )}

            {detailProduct && (
                <ProductSheet
                    catalog={catalog}
                    product={detailProduct}
                    ordering={ordering && !consultation}
                    kiosk={kiosk}
                    editing={editingLineUuid !== null}
                    onAdd={onSheetAdd}
                    onClose={closeProduct}
                />
            )}

            {kiosk && (
                <IdleDialog
                    open={idle.warning}
                    remaining={idle.remaining}
                    onStay={idle.stay}
                    onReset={resetSession}
                />
            )}

            {!kiosk && (
                <InstallPrompt
                    eligible={!prefs.installDismissed && knownOrders.length > 0}
                    onDismiss={dismissInstall}
                />
            )}
        </>
    );
}
