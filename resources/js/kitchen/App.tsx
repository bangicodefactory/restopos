import { useEcho, useOnline, usePollingFallback } from '@shared/store';
import { LoadingPane } from '@shared/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { Board } from './components/Board';
import { FilterBar, RecallBar, SummaryBar } from './components/Chrome';
import { DisplayPicker, PairingScreen, RevokedScreen } from './components/Setup';
import { useAlertSound, useNow } from './components/hooks';
import { useT, type Locale } from './i18n';
import { EMPTY_FILTER, boardLayoutOf, buildBoard, nextLayout, type BoardFilter } from './logic/board';
import { summarize, thresholdsFor } from './logic/elapsed';
import { boardStale } from './logic/offline';
import {
    HEARTBEAT_INTERVAL_MS,
    KITCHEN_EVENTS,
    POLL_INTERVAL_MS,
    kitchenChannel,
    reverbConfig,
} from './realtime';
import { useKitchenStore } from './store';
import type { KitchenDisplay, KitchenTicket, KitchenTicketUpdate } from './types';

/**
 * The kitchen display.
 *
 * Boot order matters and is deliberate: paint the cached board first, *then* talk to the network.
 * A wall screen coming back from a power cut must show the line's work in the first frame.
 *
 * Note the selector discipline throughout — every value and every action is pulled with its own
 * `useKitchenStore(selector)`. Subscribing to the whole store and listing it as an effect
 * dependency would make any state write re-run every effect, and an effect that writes state would
 * then spin forever. Zustand action identities are stable for the lifetime of the store, so
 * selecting them individually is both correct and free.
 */
export function App(): JSX.Element {
    const t = useT();
    const now = useNow(1_000);
    const browserOnline = useOnline();

    const phase = useKitchenStore((state) => state.phase);
    const loading = useKitchenStore((state) => state.loading);
    const pairError = useKitchenStore((state) => state.pairError);
    const deviceToken = useKitchenStore((state) => state.pairing?.deviceToken ?? null);
    const display = useKitchenStore((state) => state.display);
    const displayConfig = useKitchenStore((state) => state.displayConfig);
    const availableDisplays = useKitchenStore((state) => state.availableDisplays);
    const prefs = useKitchenStore((state) => state.prefs);
    const degraded = useKitchenStore((state) => state.degraded);
    const alert = useKitchenStore((state) => state.alert);

    const boot = useKitchenStore((state) => state.boot);
    const pair = useKitchenStore((state) => state.pair);
    const chooseDisplay = useKitchenStore((state) => state.chooseDisplay);
    const unpair = useKitchenStore((state) => state.unpair);
    const refresh = useKitchenStore((state) => state.refresh);
    const setOnline = useKitchenStore((state) => state.setOnline);
    const setDegraded = useKitchenStore((state) => state.setDegraded);
    const setRealtime = useKitchenStore((state) => state.setRealtime);
    const updatePrefs = useKitchenStore((state) => state.updatePrefs);
    const ingestTicket = useKitchenStore((state) => state.ingestTicket);
    const ingestUpdate = useKitchenStore((state) => state.ingestUpdate);

    const [filter, setFilter] = useState<BoardFilter>(EMPTY_FILTER);
    const booted = useRef(false);

    useEffect(() => {
        if (booted.current) return;
        booted.current = true;
        void boot();
    }, [boot]);

    // Persisted filter preferences win once the store has loaded them from IndexedDB.
    useEffect(() => {
        setFilter((current) => ({
            ...current,
            categoryIds: prefs.categoryIds,
            lateOnly: prefs.lateOnly,
        }));
    }, [prefs.categoryIds, prefs.lateOnly]);

    useEffect(() => {
        setOnline(browserOnline);
    }, [browserOnline, setOnline]);

    // ── realtime, with the polling fallback that makes it optional (KDS-015) ─
    const reverb = useMemo(() => reverbConfig(deviceToken), [deviceToken]);
    const channel = display ? kitchenChannel(display.token) : null;

    const events = useMemo(
        () => ({
            [KITCHEN_EVENTS.ticketCreated]: (payload: unknown) => {
                const ticket = (payload as { ticket?: KitchenTicket }).ticket;
                if (ticket) ingestTicket(ticket);
            },
            [KITCHEN_EVENTS.ticketUpdated]: (payload: unknown) => {
                ingestUpdate(payload as KitchenTicketUpdate);
            },
        }),
        [ingestTicket, ingestUpdate],
    );

    const echoStatus = useEcho({
        config: reverb,
        channel,
        visibility: 'private',
        events,
        onDegraded: setDegraded,
    });

    useEffect(() => {
        setRealtime(echoStatus === 'connected' ? 'connected' : reverb ? 'degraded' : 'off');
    }, [echoStatus, reverb, setRealtime]);

    const poll = useCallback(() => void refresh(), [refresh]);
    // Socket down → poll hard. Socket up → still re-pull on a slow heartbeat, because a websocket
    // guarantees nothing about the frames sent while the tab was throttled or the radio asleep.
    usePollingFallback(degraded || echoStatus !== 'connected', poll, POLL_INTERVAL_MS);
    usePollingFallback(echoStatus === 'connected', poll, HEARTBEAT_INTERVAL_MS);

    // ── audible + visible alerts (KDS-014) ──────────────────────────────────
    const soundOff = prefs.muted || displayConfig?.sound_on_new_order === false;
    const beep = useAlertSound(soundOff);
    const lastAlert = useRef(0);
    useEffect(() => {
        if (!alert || alert.id === lastAlert.current) return;
        lastAlert.current = alert.id;
        if (alert.kind === 'new-ticket') beep('new');
        if (alert.kind === 'refused') beep('warn');
    }, [alert, beep]);

    const setLocale = useCallback((locale: Locale) => updatePrefs({ locale }), [updatePrefs]);

    if (phase === 'booting') return <LoadingPane label={t('kds.board.loading')} />;
    if (phase === 'revoked') return <RevokedScreen onUnpair={() => void unpair()} />;
    if (phase === 'pairing') {
        return (
            <PairingScreen
                loading={loading}
                error={pairError}
                onPair={(code, name) => void pair(code, name)}
                onLocale={setLocale}
            />
        );
    }
    if (phase === 'choosing' || !display) {
        return (
            <DisplayPicker
                displays={availableDisplays}
                loading={loading}
                onChoose={(chosen) =>
                    void chooseDisplay({ token: chosen.token, id: chosen.id, name: chosen.name })
                }
                onUnpair={() => void unpair()}
                onLocale={setLocale}
            />
        );
    }

    return <BoardScreen filter={filter} onFilter={setFilter} now={now} />;
}

const FALLBACK_DISPLAY: KitchenDisplay = {
    id: 0,
    name: '',
    layout: 'columns',
    average_prep_minutes: 10,
    late_threshold_minutes: 15,
    done_retention_minutes: 60,
    sound_on_new_order: true,
};

/**
 * The board itself, exported for testing.
 *
 * `App` cannot be rendered in a unit test — it boots the store, opens IndexedDB and attaches a
 * websocket on mount. `BoardScreen` reads state and renders, which is where the layout decision
 * lives, and that decision is exactly what silently discarded a `grid` display for as long as it
 * was a private ternary nothing could reach (BAN-436a).
 */
export function BoardScreen({
    filter,
    onFilter,
    now,
}: {
    filter: BoardFilter;
    onFilter: (next: BoardFilter) => void;
    now: number;
}): JSX.Element {
    const t = useT();

    const orders = useKitchenStore((state) => state.orders);
    const stages = useKitchenStore((state) => state.stages);
    const categories = useKitchenStore((state) => state.categories);
    const productCategory = useKitchenStore((state) => state.productCategory);
    const firstSeen = useKitchenStore((state) => state.firstSeen);
    const queued = useKitchenStore((state) => state.queue.length);
    const online = useKitchenStore((state) => state.online);
    const lastSyncAt = useKitchenStore((state) => state.lastSyncAt);

    // Stale board (BAN-450): dark long enough (or queue at the cap) that what's on screen may no
    // longer match the pass. Ticks with `now`, so the banner appears on its own after the window.
    const staleBoard = boardStale({ online, lastSyncAt, queueLength: queued }, now);
    const realtime = useKitchenStore((state) => state.realtime);
    const prefs = useKitchenStore((state) => state.prefs);
    const selected = useKitchenStore((state) => state.display);
    const config = useKitchenStore((state) => state.displayConfig);

    const advanceOrder = useKitchenStore((state) => state.advanceOrder);
    const recallOrder = useKitchenStore((state) => state.recallOrder);
    const completeOrder = useKitchenStore((state) => state.completeOrder);
    const toggleLine = useKitchenStore((state) => state.toggleLine);
    const changeDisplay = useKitchenStore((state) => state.changeDisplay);
    const updatePrefs = useKitchenStore((state) => state.updatePrefs);

    const display = useMemo<KitchenDisplay>(
        () => config ?? { ...FALLBACK_DISPLAY, id: selected?.id ?? 0, name: selected?.name ?? '' },
        [config, selected],
    );

    const thresholds = useMemo(() => thresholdsFor(display), [display]);
    // `grid` used to fall into the `columns` arm of a ternary here, which is why a display
    // configured as "Grille" in the back office rendered the card wall (BAN-436a). One normaliser
    // now handles both the operator's override and the configured value.
    const layout = boardLayoutOf(prefs.layout ?? display.layout);

    const categoryOf = useMemo(() => {
        return (productId: number | null | undefined): number | null =>
            typeof productId === 'number' ? (productCategory[productId] ?? null) : null;
    }, [productCategory]);

    const view = useMemo(
        () =>
            buildBoard({
                orders,
                stages,
                filter,
                categoryOf,
                thresholds,
                now,
                doneRetentionMinutes: display.done_retention_minutes,
            }),
        [orders, stages, filter, categoryOf, thresholds, now, display.done_retention_minutes],
    );

    const summary = useMemo(() => summarize(orders, now, thresholds), [orders, now, thresholds]);

    // Only offer categories that are actually on the board — a forty-chip filter row on a wall
    // screen is unusable, and a category with nothing in it is not a filter anyone wants.
    const activeCategories = useMemo(() => {
        const present = new Set<number>();
        for (const order of orders) {
            for (const line of order.lines) {
                const id = line.pos_category_id ?? categoryOf(line.product_id);
                if (id !== null) present.add(id);
            }
        }
        return categories.filter((category) => present.has(category.id));
    }, [orders, categories, categoryOf]);

    const activeCourses = useMemo(() => {
        const present = new Set<number>();
        for (const order of orders) {
            for (const line of order.lines) if (line.course_index !== null) present.add(line.course_index);
        }
        return [...present].sort((a, b) => a - b);
    }, [orders]);

    /**
     * Service modes actually on the board (KDS-012).
     *
     * Derived from what is here rather than from the venue's configured presets: a chip for
     * "Delivery" on a board with no deliveries is a filter whose only outcome is an empty screen.
     */
    const activePresets = useMemo(() => {
        const present = new Set<string>();
        for (const order of orders) {
            if (order.preset_label) present.add(order.preset_label);
        }

        return [...present].sort((a, b) => a.localeCompare(b));
    }, [orders]);

    const applyFilter = (patch: Partial<BoardFilter>): void => {
        const next = { ...filter, ...patch };
        onFilter(next);
        updatePrefs({ categoryIds: [...next.categoryIds], lateOnly: next.lateOnly });
    };

    return (
        <div className="flex h-full flex-col bg-kitchen-bg text-kitchen-text">
            <SummaryBar
                displayName={display.name}
                summary={summary}
                queued={queued}
                online={online}
                realtime={realtime}
                muted={prefs.muted}
                layout={layout}
                locale={prefs.locale ?? 'fr'}
                onToggleMute={() => updatePrefs({ muted: !prefs.muted })}
                onToggleLayout={() => updatePrefs({ layout: nextLayout(layout) })}
                onChangeLocale={(locale) => updatePrefs({ locale })}
                onChangeDisplay={changeDisplay}
            />

            <FilterBar
                categories={activeCategories}
                courses={activeCourses}
                presets={activePresets}
                filter={filter}
                onChange={applyFilter}
            />

            {staleBoard ? (
                <p
                    role="alert"
                    className="bg-kitchen-late px-3 py-1 text-center text-lg font-bold text-white"
                >
                    {t('kds.net.stale')}
                </p>
            ) : !online ? (
                <p
                    role="status"
                    className="bg-kitchen-late/25 px-3 py-1 text-center text-lg font-bold text-kitchen-late"
                >
                    {t('kds.net.queued')}
                </p>
            ) : null}

            <main className="min-h-0 flex-1 pt-3">
                <Board
                    view={view}
                    display={display}
                    layout={layout}
                    now={now}
                    firstSeen={firstSeen}
                    onAdvance={advanceOrder}
                    onRecall={recallOrder}
                    onComplete={completeOrder}
                    onToggleLine={toggleLine}
                />
            </main>

            <RecallBar orders={view.recallable} onRecall={recallOrder} />
        </div>
    );
}
