import { createPosStore } from '@shared/store';

import { KDS_CLIENT_VERSION, KitchenApi, createApiClient, errorCode, isAuthFailure, isOffline } from './api';
import type { KitchenBootstrap } from './api';
import { applyLineStateLocally, applyRecallLocally, applyStageLocally, applyTicketUpdate, effectiveStageId, isLineCancelled, nextLineState, nextStage, replayQueue, sortStages, stageById } from './logic/board';
import type { PendingAction } from './logic/board';
import { MAX_QUEUE, reconnectStrategy } from './logic/offline';
import {
    DEFAULT_PREFS,
    forgetPairing,
    loadBoard,
    loadPairing,
    loadPrefs,
    loadQueue,
    loadSelectedDisplay,
    persistPairing,
    saveBoard,
    savePrefs,
    saveQueue,
    saveSelectedDisplay,
    type KitchenPrefs,
    type SelectedDisplay,
} from './persistence';
import type {
    KitchenDisplay,
    KitchenLineState,
    KitchenOrder,
    KitchenPairing,
    KitchenStage,
    KitchenTicket,
    KitchenTicketUpdate,
    QueuedAction,
} from './types';

/**
 * The display's state machine (KDS-008, KDS-015, KDS-020).
 *
 * Three principles, all of them consequences of "a KDS that blanks when wifi hiccups is worse than
 * paper":
 *
 *  1. **Every action is optimistic.** A cook taps, the card moves, full stop. The network attempt
 *     happens behind that.
 *  2. **The server is the arbiter.** On every refresh the server board replaces the local one, and
 *     only then are the still-unacknowledged actions replayed on top (`replayQueue`). There is no
 *     field-level merge, because a merge is what makes a bumped ticket come back from the dead.
 *  3. **Nothing is ever silently lost.** An action that cannot be sent stays in the queue, is
 *     persisted to IndexedDB, and is retried on reconnect. An action the server *refuses* is
 *     dropped and the board is re-pulled, loudly.
 */

export type KitchenPhase = 'booting' | 'pairing' | 'choosing' | 'ready' | 'revoked';

export type KitchenAlert = { id: number; kind: 'new-ticket' | 'refused' | 'reconciled' | 'revoked' };

export type KitchenState = {
    phase: KitchenPhase;
    bootError: string | null;
    pairError: string | null;
    pairing: KitchenPairing | null;

    /** Displays offered by the picker (from `/api/pos/bootstrap`). */
    availableDisplays: Array<{ id: number; name: string; token: string }>;
    display: SelectedDisplay | null;
    displayConfig: KitchenDisplay | null;
    stages: KitchenStage[];
    orders: KitchenOrder[];

    /** `pos_categories` for the filter chips, and `product_id → pos_category_id` for the filter. */
    categories: Array<{ id: number; name: string; sequence: number }>;
    productCategory: Record<number, number>;

    queue: QueuedAction[];
    prefs: KitchenPrefs;

    online: boolean;
    degraded: boolean;
    realtime: 'connected' | 'degraded' | 'off';
    lastSyncAt: number | null;
    loading: boolean;
    /** prepOrder id → when this screen first saw it, for the arrival flash. */
    firstSeen: Record<number, number>;
    alert: KitchenAlert | null;

    boot: () => Promise<void>;
    pair: (code: string, name: string) => Promise<void>;
    loadDisplays: () => Promise<void>;
    chooseDisplay: (display: SelectedDisplay) => Promise<void>;
    changeDisplay: () => void;
    unpair: () => Promise<void>;

    refresh: () => Promise<void>;
    flush: () => Promise<void>;
    setOnline: (online: boolean) => void;
    setDegraded: (degraded: boolean) => void;
    setRealtime: (status: 'connected' | 'degraded' | 'off') => void;

    advanceOrder: (orderId: number) => void;
    setOrderStage: (orderId: number, stageId: number) => void;
    completeOrder: (orderId: number) => void;
    recallOrder: (orderId: number) => void;
    toggleLine: (orderId: number, lineId: number) => void;

    ingestTicket: (ticket: KitchenTicket) => void;
    ingestUpdate: (update: KitchenTicketUpdate) => void;

    updatePrefs: (patch: Partial<KitchenPrefs>) => void;
    dismissAlert: () => void;
};

const client = createApiClient(() => useKitchenStore.getState().pairing?.deviceToken ?? null);
const api = new KitchenApi(client);

let alertSeq = 0;
let actionSeq = 0;

function nextActionId(): string {
    actionSeq += 1;
    return `${Date.now().toString(36)}-${actionSeq}`;
}

/** Queue entries minus their bookkeeping — what `replayQueue` consumes. */
function asPending(queue: readonly QueuedAction[]): PendingAction[] {
    return queue.map((action) =>
        action.kind === 'line'
            ? { kind: 'line', lineId: action.lineId, state: action.state }
            : action.kind === 'recall'
              ? { kind: 'recall', prepOrderId: action.prepOrderId }
              : { kind: 'stage', prepOrderId: action.prepOrderId, stageId: action.stageId },
    );
}

export const useKitchenStore = createPosStore<KitchenState>((set, get) => {
    /** Persist the queue outside the immer draft — IndexedDB writes must not block a tap. */
    const persistQueue = (): void => {
        const { pairing, display, queue } = get();
        if (!pairing || !display) return;
        void saveQueue(pairing.configId, display.token, queue);
    };

    const enqueue = (action: QueuedAction): void => {
        set((state) => {
            state.queue.push(action);
            // Bound the queue over a long dark period (BAN-450): a display offline for an hour must
            // not accumulate unboundedly. The dropped tail is recovered by the full re-projection
            // that runs on reconnect once the board is stale.
            while (state.queue.length > MAX_QUEUE) {
                state.queue.shift();
            }
        });
        persistQueue();
        void get().flush();
    };

    const raise = (kind: KitchenAlert['kind']): void => {
        alertSeq += 1;
        const id = alertSeq;
        set((state) => {
            state.alert = { id, kind };
        });
    };

    return {
        phase: 'booting',
        bootError: null,
        pairError: null,
        pairing: null,

        availableDisplays: [],
        display: null,
        displayConfig: null,
        stages: [],
        orders: [],

        categories: [],
        productCategory: {},

        queue: [],
        prefs: DEFAULT_PREFS,

        online: globalThis.navigator?.onLine !== false,
        degraded: false,
        realtime: 'off',
        lastSyncAt: null,
        loading: false,
        firstSeen: {},
        alert: null,

        // ── boot ────────────────────────────────────────────────────────────
        async boot() {
            const pairing = await loadPairing();
            if (!pairing) {
                set((state) => {
                    state.phase = 'pairing';
                });
                return;
            }

            const [prefs, display] = await Promise.all([
                loadPrefs(pairing.configId),
                loadSelectedDisplay(pairing.configId),
            ]);

            set((state) => {
                state.pairing = pairing;
                state.prefs = prefs;
                state.display = display;
                state.phase = display ? 'ready' : 'choosing';
            });

            if (display) {
                // Paint from cache first: the wall screen must show the line's work before the
                // network has been consulted, and possibly without a network at all.
                const [cached, queue] = await Promise.all([
                    loadBoard(pairing.configId, display.token),
                    loadQueue(pairing.configId, display.token),
                ]);
                if (cached) {
                    set((state) => {
                        state.displayConfig = cached.display;
                        state.stages = sortStages(cached.stages);
                        state.orders = replayQueue(
                            cached.orders,
                            cached.stages,
                            asPending(queue),
                            new Date().toISOString(),
                        );
                        state.queue = queue;
                    });
                } else if (queue.length > 0) {
                    set((state) => {
                        state.queue = queue;
                    });
                }
            }

            // Catalog and display list are nice-to-have; a failure must not block the board.
            void get().loadDisplays();
            if (get().display) await get().refresh();
        },

        async pair(code, name) {
            set((state) => {
                state.pairError = null;
                state.loading = true;
            });
            try {
                const response = await api.pair(code, name);
                const pairing = await persistPairing(response, KDS_CLIENT_VERSION);
                set((state) => {
                    state.pairing = pairing;
                    state.phase = 'choosing';
                    state.prefs = DEFAULT_PREFS;
                });
                await get().loadDisplays();
            } catch (error) {
                const code = errorCode(error);
                set((state) => {
                    state.pairError = code === 'invalid_pairing_code' ? 'kds.pair.expired' : 'kds.pair.failed';
                });
            } finally {
                set((state) => {
                    state.loading = false;
                });
            }
        },

        async loadDisplays() {
            if (!get().pairing) return;
            let payload: KitchenBootstrap;
            try {
                payload = await api.bootstrap();
            } catch (error) {
                if (isAuthFailure(error)) revoke(set);
                return;
            }

            const displays = (payload.data.prep_displays ?? [])
                .filter((row): row is typeof row & { access_token: string } => typeof row.access_token === 'string')
                .map((row) => ({ id: row.id, name: row.name, token: row.access_token }));

            const categories = (payload.data.pos_categories ?? [])
                .map((row) => ({ id: row.id, name: row.name, sequence: row.sequence }))
                .sort((a, b) => a.sequence - b.sequence || a.id - b.id);

            const productCategory: Record<number, number> = {};
            for (const product of payload.data.products ?? []) {
                const first = product.pos_category_ids?.[0];
                if (typeof first === 'number') productCategory[product.id] = first;
            }

            set((state) => {
                state.availableDisplays = displays;
                state.categories = categories;
                state.productCategory = productCategory;
            });
        },

        async chooseDisplay(display) {
            const pairing = get().pairing;
            if (!pairing) return;
            await saveSelectedDisplay(pairing.configId, display);
            const queue = await loadQueue(pairing.configId, display.token);
            set((state) => {
                state.display = display;
                state.phase = 'ready';
                state.orders = [];
                state.queue = queue;
                state.firstSeen = {};
            });
            await get().refresh();
        },

        changeDisplay() {
            set((state) => {
                state.phase = 'choosing';
            });
            void get().loadDisplays();
        },

        async unpair() {
            const pairing = get().pairing;
            try {
                await api.unpair();
            } catch {
                // A revoked or offline device still forgets locally — that is the point of the button.
            }
            if (pairing) await forgetPairing(pairing.configId);
            set((state) => {
                state.pairing = null;
                state.display = null;
                state.orders = [];
                state.queue = [];
                state.phase = 'pairing';
            });
        },

        // ── sync ────────────────────────────────────────────────────────────
        async refresh() {
            const { pairing, display } = get();
            if (!pairing || !display) return;

            set((state) => {
                state.loading = true;
            });
            try {
                const board = await api.board(display.token);
                const nowIso = new Date().toISOString();
                const queue = get().queue;

                set((state) => {
                    state.displayConfig = board.display;
                    state.stages = sortStages(board.stages);
                    state.orders = replayQueue(board.orders, board.stages, asPending(queue), nowIso);
                    state.lastSyncAt = Date.now();
                    state.online = true;
                    // The picker stores the token; the board response is where the id and the real
                    // name come from.
                    if (state.display) {
                        state.display = {
                            token: state.display.token,
                            id: board.display.id,
                            name: board.display.name,
                        };
                    }
                    markSeen(state, board.orders);
                });

                await saveBoard(pairing.configId, display.token, board);
                if (get().queue.length > 0) void get().flush();
            } catch (error) {
                if (isAuthFailure(error)) {
                    revoke(set);
                } else if (isOffline(error)) {
                    set((state) => {
                        state.online = false;
                    });
                }
            } finally {
                set((state) => {
                    state.loading = false;
                });
            }
        },

        /**
         * Drain the queue, one action at a time and in order.
         *
         * Sequential on purpose: two stage bumps for the same card sent concurrently can be applied
         * by the server in either order, and the loser wins. Kitchen traffic is a handful of writes
         * a minute, so there is nothing to gain from parallelism and a real correctness bug to lose.
         */
        async flush() {
            const { pairing, display } = get();
            if (!pairing || !display || get().queue.length === 0) return;

            let refused = false;
            let sent = false;

            for (const action of [...get().queue]) {
                try {
                    if (action.kind === 'stage') {
                        await api.setStage(display.token, action.prepOrderId, action.stageId);
                    } else if (action.kind === 'recall') {
                        await api.recall(display.token, action.prepOrderId);
                    } else {
                        await api.setLineState(display.token, action.lineId, action.state);
                    }
                    sent = true;
                    set((state) => {
                        state.queue = state.queue.filter((entry) => entry.id !== action.id);
                    });
                } catch (error) {
                    if (isAuthFailure(error)) {
                        revoke(set);
                        return;
                    }
                    if (isOffline(error)) {
                        // Keep it, keep the optimistic board, try again on reconnect.
                        set((state) => {
                            state.online = false;
                            const entry = state.queue.find((item) => item.id === action.id);
                            if (entry) entry.attempts += 1;
                        });
                        persistQueue();
                        return;
                    }
                    // 4xx: the server will never accept this. Drop it and re-pull the truth.
                    refused = true;
                    set((state) => {
                        state.queue = state.queue.filter((entry) => entry.id !== action.id);
                    });
                }
            }

            persistQueue();
            if (refused) {
                raise('refused');
                await get().refresh();
            } else if (sent) {
                set((state) => {
                    state.online = true;
                });
            }
        },

        setOnline(online) {
            if (get().online === online) return;

            // Decide before flipping the flag: was the board stale (dark too long / queue at the cap)?
            const strategy = reconnectStrategy(
                { online: get().online, lastSyncAt: get().lastSyncAt, queueLength: get().queue.length },
                Date.now(),
            );

            set((state) => {
                state.online = online;
            });

            if (!online) return;

            if (strategy === 'reproject') {
                // Stale board: drop the local queue and adopt the pure server board rather than
                // replay decisions the other stations already superseded while we were dark (BAN-450).
                set((state) => {
                    state.queue = [];
                });
                persistQueue();
                void get().refresh();
            } else {
                void get().flush();
                void get().refresh();
            }
        },

        // Both setters are called from render effects, so they must be no-ops when nothing
        // changed — otherwise every write produces a new state object, which re-runs the effect
        // that produced it.
        setDegraded(degraded) {
            if (get().degraded === degraded) return;
            set((state) => {
                state.degraded = degraded;
            });
        },

        setRealtime(status) {
            if (get().realtime === status) return;
            set((state) => {
                state.realtime = status;
            });
        },

        // ── interactions ────────────────────────────────────────────────────
        advanceOrder(orderId) {
            const { orders, stages } = get();
            const order = orders.find((item) => item.id === orderId);
            if (!order) return;
            const target = nextStage(stages, effectiveStageId(order, stages));
            if (!target) return;
            get().setOrderStage(orderId, target.id);
        },

        setOrderStage(orderId, stageId) {
            const stage = stageById(get().stages, stageId);
            if (!stage) return;
            const nowIso = new Date().toISOString();
            set((state) => {
                const index = state.orders.findIndex((item) => item.id === orderId);
                if (index === -1) return;
                state.orders[index] = applyStageLocally(state.orders[index]!, stage, nowIso);
            });
            enqueue({ id: nextActionId(), at: Date.now(), attempts: 0, kind: 'stage', prepOrderId: orderId, stageId });
        },

        /** "All done" — jump straight to the last stage rather than tapping through each one. */
        completeOrder(orderId) {
            const stages = sortStages(get().stages);
            const last = stages[stages.length - 1];
            if (!last) return;
            get().setOrderStage(orderId, last.id);
        },

        recallOrder(orderId) {
            const stages = get().stages;
            set((state) => {
                const index = state.orders.findIndex((item) => item.id === orderId);
                if (index === -1) return;
                state.orders[index] = applyRecallLocally(state.orders[index]!, stages);
            });
            enqueue({ id: nextActionId(), at: Date.now(), attempts: 0, kind: 'recall', prepOrderId: orderId });
        },

        toggleLine(orderId, lineId) {
            const order = get().orders.find((item) => item.id === orderId);
            const line = order?.lines.find((item) => item.id === lineId);
            if (!order || !line) return;
            // A cancelled line is a fact, not a task — tapping it must not "complete" it.
            // `isLineCancelled`, because the server books a cancellation as a *todo* row carrying
            // `change_type: 'cancelled'`; a state-only check let the cook tap it anyway (KDS-016).
            if (isLineCancelled(line)) return;

            const target: KitchenLineState = line.state === 'served' ? 'todo' : nextLineState(line.state);
            const nowIso = new Date().toISOString();
            set((state) => {
                const index = state.orders.findIndex((item) => item.id === orderId);
                if (index === -1) return;
                state.orders[index] = applyLineStateLocally(state.orders[index]!, lineId, target, nowIso);
            });
            enqueue({ id: nextActionId(), at: Date.now(), attempts: 0, kind: 'line', lineId, state: target });
        },

        // ── realtime ────────────────────────────────────────────────────────
        /**
         * `kitchen.ticket.created` carries the whole ticket (spec §11.3's one deliberate exception
         * to thin events) so a card appears instantly. We still schedule a refresh: the broadcast
         * `Ticket` has no per-line `state`/`prep_stage_id`, so the authoritative row is pulled right
         * behind the optimistic paint.
         */
        ingestTicket(ticket) {
            const display = get().display;
            if (display?.id !== null && display?.id !== undefined && ticket.prep_display_id !== display.id) return;
            if (get().orders.some((order) => order.id === ticket.prep_order_id)) {
                void get().refresh();
                return;
            }

            // A ticket with no lines is an amendment — today, an order note added after the send
            // (KDS-053). It changes a card; it never creates one. Falling through here built a
            // *pending* card with zero items for an order this board is not holding, which is what
            // happens once a served card ages past `done_retention_minutes` and the waiter then adds
            // "no onions": the server still upserts the row, because the row is still there, and the
            // pass grew a blank ticket (review of #58).
            //
            // Every ticket that should create a card carries lines, including a course fire —
            // `fireCourse` is note-update *shaped* but lists the course's products.
            if (ticket.lines.length === 0) return;

            const firstStage = sortStages(get().stages)[0];
            const order: KitchenOrder = {
                id: ticket.prep_order_id,
                uuid: ticket.prep_order_uuid,
                prep_display_id: ticket.prep_display_id,
                pos_order_id: null,
                tracking_number: ticket.tracking_number,
                table_label: ticket.table_label,
                guest_count: ticket.guest_count,
                preset_label: null,
                customer_name: null,
                order_note: ticket.order_note,
                state: 'pending',
                fired_at: ticket.fired_at,
                first_started_at: null,
                ready_at: null,
                served_at: null,
                is_recalled: false,
                age_seconds: 0,
                lines: ticket.lines.map((line) => ({
                    id: line.id,
                    uuid: line.line_uuid,
                    pos_order_line_uuid: line.line_uuid,
                    prep_stage_id: firstStage?.id ?? 0,
                    course_index: line.course_index,
                    product_id: line.product_id,
                    display_name: line.display_name,
                    quantity: line.quantity,
                    change_type: line.change_type,
                    customer_note: line.customer_note,
                    internal_note: line.internal_note,
                    state: 'todo',
                    started_at: null,
                    ready_at: null,
                    served_at: null,
                    fired_at: ticket.fired_at,
                    pos_category_id: line.pos_category_id,
                    combo_parent_uuid: line.combo_parent_uuid,
                })),
            };

            set((state) => {
                state.orders.push(order);
                markSeen(state, [order]);
            });
            raise('new-ticket');
            void get().refresh();
        },

        ingestUpdate(update) {
            const known = get().orders.some((order) => order.id === update.prep_order_id);
            if (!known) {
                void get().refresh();
                return;
            }
            set((state) => {
                const index = state.orders.findIndex((order) => order.id === update.prep_order_id);
                if (index === -1) return;
                state.orders[index] = applyTicketUpdate(state.orders[index]!, update);
            });
        },

        // ── preferences ─────────────────────────────────────────────────────
        updatePrefs(patch) {
            set((state) => {
                state.prefs = { ...state.prefs, ...patch };
            });
            const { pairing, prefs } = get();
            if (pairing) void savePrefs(pairing.configId, prefs);
        },

        dismissAlert() {
            set((state) => {
                state.alert = null;
            });
        },
    };
});

type Setter = (updater: (state: KitchenState) => void) => void;

function revoke(set: Setter): void {
    alertSeq += 1;
    const id = alertSeq;
    set((state) => {
        state.phase = 'revoked';
        state.alert = { id, kind: 'revoked' };
    });
}

/** Record arrival times so the card can flash exactly once, for exactly this screen. */
function markSeen(state: KitchenState, orders: readonly KitchenOrder[]): void {
    const now = Date.now();
    const live = new Set(orders.map((order) => order.id));
    for (const order of orders) {
        if (state.firstSeen[order.id] === undefined) state.firstSeen[order.id] = now;
    }
    // Keep the map from growing without bound over a 14-hour service.
    for (const key of Object.keys(state.firstSeen)) {
        const id = Number(key);
        if (!live.has(id) && !state.orders.some((order) => order.id === id)) delete state.firstSeen[id];
    }
}
