import { createPosStore } from '@shared/store';

import { SelfOrderApi, errorCode, isDeadToken, isOffline } from './api';
import { buildCatalog, type Catalog, type MenuProduct } from './catalog';
import {
    EMPTY_CART,
    addLine,
    clearCart,
    removeLine,
    setNote,
    setQuantity,
    toSubmitLines,
    validateCart,
    type Cart,
    type CartDraft,
    type CartIssue,
} from './logic/cart';
import { canOrder } from './logic/availability';
import { trackingStep } from './realtime';
import {
    DEFAULT_PREFS,
    clearCartOnly,
    loadCart,
    loadKnownOrders,
    loadMenu,
    loadPrefs,
    saveCart,
    saveKnownOrders,
    saveMenu,
    savePrefs,
    type SelfOrderPrefs,
} from './persistence';
import type {
    KnownOrder,
    MenuResponse,
    SelfOrderConfig,
    SelfOrderStatus,
    SelfOrderTable,
    TrackingStep,
} from './types';

/**
 * The self-order client's state.
 *
 * One store serves all three modes (SLF-001). The mode is data, not a build flag: the same bundle
 * is a browse-only QR menu, a phone ordering at a table, and a kiosk, because a venue flips
 * `self_ordering_mode` in the back office and the customer's next page load must obey it.
 *
 * The catalog deliberately lives *outside* the store. It is megabytes of `Map`s, and running
 * Immer's structural-sharing pass over it on every quantity stepper press would be absurd — the
 * same reasoning `@shared/store` gives for keeping the register's catalog a frozen singleton. The
 * store holds a version counter; `getCatalog()` hands out the object.
 */

let catalogRef: Catalog | null = null;

export function getCatalog(): Catalog | null {
    return catalogRef;
}

export type Screen =
    | 'landing'
    | 'presets'
    | 'menu'
    | 'cart'
    | 'checkout'
    | 'status'
    | 'history';

export type SelfOrderState = {
    phase: 'booting' | 'ready' | 'dead';
    /** i18n key of a blocking error. */
    fatal: string | null;
    offline: boolean;

    configToken: string;
    tableToken: string | null;

    catalogVersion: number;
    config: SelfOrderConfig | null;
    table: SelfOrderTable | null;
    menuCachedAt: number | null;

    screen: Screen;
    /** Product open in the detail sheet / combo stepper. */
    detailProductId: number | null;
    /** Cart line being edited, if the sheet was opened from the cart. */
    editingLineUuid: string | null;

    cart: Cart;
    cartIssues: CartIssue[];
    presetId: number | null;
    standNumber: string;
    customerNote: string;

    submitting: boolean;
    submitError: string | null;

    activeOrder: SelfOrderStatus | null;
    activeOrderToken: string | null;
    trackingStep: TrackingStep;
    paymentPending: boolean;

    knownOrders: KnownOrder[];
    prefs: SelfOrderPrefs;

    boot: (configToken: string, tableToken: string | null) => Promise<void>;
    refreshMenu: () => Promise<void>;

    go: (screen: Screen) => void;
    openProduct: (productId: number, lineUuid?: string) => void;
    closeProduct: () => void;

    addToCart: (draft: CartDraft, children?: readonly CartDraft[]) => void;
    changeQuantity: (uuid: string, quantity: number) => void;
    removeFromCart: (uuid: string) => void;
    noteFor: (uuid: string, note: string | null) => void;
    emptyCart: () => void;
    setPreset: (presetId: number | null) => void;
    setStandNumber: (value: string) => void;
    setCustomerNote: (value: string) => void;
    dismissIssues: () => void;

    submit: () => Promise<boolean>;
    cancelActiveOrder: () => Promise<void>;
    payOnline: () => Promise<void>;
    resumePayment: (reference: string) => Promise<void>;
    pollStatus: () => Promise<void>;
    openKnownOrder: (order: KnownOrder) => Promise<void>;

    setLocale: (locale: SelfOrderPrefs['locale']) => void;
    dismissInstall: () => void;
    /** Kiosk idle reset (SLF-090): forget the previous customer entirely. */
    resetSession: () => void;
};

let api: SelfOrderApi | null = null;

function requireApi(): SelfOrderApi {
    if (!api) throw new Error('Self-order API used before boot');
    return api;
}

export const useSelfOrderStore = createPosStore<SelfOrderState>((set, get) => {
    const persistCart = (): void => {
        const { configToken, cart } = get();
        void saveCart(configToken, cart);
    };

    const rememberOrder = (order: SelfOrderStatus): void => {
        const entry: KnownOrder = {
            uuid: order.uuid,
            accessToken: order.access_token,
            trackingNumber: order.tracking_number,
            total: order.amount_total,
            state: order.state,
            step: trackingStep(order),
            placedAt: Date.now(),
            updatedAt: Date.now(),
        };

        set((state) => {
            const index = state.knownOrders.findIndex((known) => known.uuid === order.uuid);
            if (index === -1) state.knownOrders.unshift(entry);
            else {
                const existing = state.knownOrders[index];
                state.knownOrders[index] = {
                    ...entry,
                    placedAt: existing?.placedAt ?? entry.placedAt,
                    // A token is only ever learned once; never overwrite it with an empty one.
                    accessToken: entry.accessToken || (existing?.accessToken ?? ''),
                };
            }
        });

        void saveKnownOrders(get().configToken, get().knownOrders);
    };

    const adopt = (menu: MenuResponse, cachedAt: number | null): void => {
        catalogRef = buildCatalog(menu);
        set((state) => {
            state.catalogVersion += 1;
            state.config = menu.self_order;
            state.table = menu.table;
            state.menuCachedAt = cachedAt;
        });
    };

    return {
        phase: 'booting',
        fatal: null,
        offline: globalThis.navigator?.onLine === false,

        configToken: '',
        tableToken: null,

        catalogVersion: 0,
        config: null,
        table: null,
        menuCachedAt: null,

        screen: 'landing',
        detailProductId: null,
        editingLineUuid: null,

        cart: EMPTY_CART,
        cartIssues: [],
        presetId: null,
        standNumber: '',
        customerNote: '',

        submitting: false,
        submitError: null,

        activeOrder: null,
        activeOrderToken: null,
        trackingStep: 'received',
        paymentPending: false,

        knownOrders: [],
        prefs: DEFAULT_PREFS,

        // ── boot ────────────────────────────────────────────────────────────
        async boot(configToken, tableToken) {
            api = new SelfOrderApi(configToken, tableToken);
            set((state) => {
                state.configToken = configToken;
                state.tableToken = tableToken;
            });

            // Paint from cache first. A venue's guest Wi-Fi is the worst network in the building,
            // and a menu that renders instantly from IndexedDB is the difference between a customer
            // ordering and a customer giving up.
            const [cached, cart, orders, prefs] = await Promise.all([
                loadMenu(configToken),
                loadCart(configToken),
                loadKnownOrders(configToken),
                loadPrefs(configToken),
            ]);

            set((state) => {
                state.cart = cart ?? EMPTY_CART;
                state.knownOrders = orders;
                state.prefs = prefs;
                state.presetId = prefs.presetId;
            });

            if (cached) {
                adopt(cached, cached.cachedAt ?? null);
                set((state) => {
                    state.phase = 'ready';
                });
            }

            await get().refreshMenu();
        },

        async refreshMenu() {
            const { configToken } = get();
            try {
                const menu = await requireApi().menu();
                adopt(menu, null);
                await saveMenu(configToken, menu);
                set((state) => {
                    state.phase = 'ready';
                    state.fatal = null;
                    state.offline = false;
                });

                // A live 86 may have landed while the phone was in a pocket (SLF-026, SLF-033).
                const catalog = catalogRef;
                if (catalog) {
                    const { cart, issues } = validateCart(get().cart, catalog);
                    if (issues.length > 0) {
                        set((state) => {
                            state.cart = cart;
                            state.cartIssues = issues;
                        });
                        persistCart();
                    }
                }
            } catch (error) {
                if (isDeadToken(error)) {
                    set((state) => {
                        state.phase = 'dead';
                        state.fatal =
                            errorCode(error) === 'self_order_disabled'
                                ? 'so.error.orderingDisabled'
                                : 'so.error.invalidToken';
                    });
                    return;
                }
                set((state) => {
                    state.offline = isOffline(error);
                    // A cached menu means offline is a warning, not a wall.
                    state.phase = catalogRef ? 'ready' : 'dead';
                    if (!catalogRef) state.fatal = 'so.error.load';
                });
            }
        },

        // ── navigation ──────────────────────────────────────────────────────
        go(screen) {
            set((state) => {
                state.screen = screen;
                state.detailProductId = null;
                state.editingLineUuid = null;
                if (screen !== 'cart') state.cartIssues = [];
            });
        },

        openProduct(productId, lineUuid) {
            set((state) => {
                state.detailProductId = productId;
                state.editingLineUuid = lineUuid ?? null;
            });
        },

        closeProduct() {
            set((state) => {
                state.detailProductId = null;
                state.editingLineUuid = null;
            });
        },

        // ── cart ────────────────────────────────────────────────────────────
        addToCart(draft, children = []) {
            const editing = get().editingLineUuid;
            set((state) => {
                // Editing replaces rather than accumulates: re-opening a line and pressing Add must
                // not leave the customer with two of everything.
                const base = editing ? removeLine(state.cart, editing) : state.cart;
                state.cart = addLine(base, draft, children);
                state.detailProductId = null;
                state.editingLineUuid = null;
            });
            persistCart();
        },

        changeQuantity(uuid, quantity) {
            set((state) => {
                state.cart = setQuantity(state.cart, uuid, quantity);
            });
            persistCart();
        },

        removeFromCart(uuid) {
            set((state) => {
                state.cart = removeLine(state.cart, uuid);
            });
            persistCart();
        },

        noteFor(uuid, note) {
            set((state) => {
                state.cart = setNote(state.cart, uuid, note);
            });
            persistCart();
        },

        emptyCart() {
            set((state) => {
                state.cart = clearCart();
                state.cartIssues = [];
            });
            persistCart();
        },

        setPreset(presetId) {
            set((state) => {
                state.presetId = presetId;
                state.prefs = { ...state.prefs, presetId };
            });
            void savePrefs(get().configToken, get().prefs);
        },

        setStandNumber(value) {
            set((state) => {
                state.standNumber = value.replace(/\D+/g, '').slice(0, 4);
            });
        },

        setCustomerNote(value) {
            set((state) => {
                state.customerNote = value.slice(0, 240);
            });
        },

        dismissIssues() {
            set((state) => {
                state.cartIssues = [];
            });
        },

        // ── submission ──────────────────────────────────────────────────────
        /**
         * Send the basket (SLF-036, SLF-037).
         *
         * The client proposes an `order_uuid` only in pay-after-meal mode, where appending to the
         * table's running tab is the point. In `each` mode it never does — the next basket must be
         * a brand-new order, and reusing the uuid would silently merge two customers' rounds.
         */
        async submit() {
            const { cart, config, presetId, standNumber, customerNote, activeOrder } = get();
            const catalog = catalogRef;
            if (!catalog || !config || cart.lines.length === 0) return false;
            if (!canOrder(config)) return false;

            // Submitting is online-only and there is no customer-facing outbox (BAN-450): refuse
            // before touching the network so the cart is kept intact and the order is sent exactly
            // once, on the first attempt after connectivity returns — not fired blindly into a drop.
            if (get().offline) {
                set((state) => {
                    state.submitError = 'so.error.offline';
                });

                return false;
            }

            const validated = validateCart(cart, catalog);
            if (validated.issues.length > 0) {
                set((state) => {
                    state.cart = validated.cart;
                    state.cartIssues = validated.issues;
                    state.screen = 'cart';
                });
                persistCart();
                return false;
            }

            set((state) => {
                state.submitting = true;
                state.submitError = null;
            });

            try {
                const appendUuid =
                    config.pay_after === 'meal' && activeOrder?.state === 'draft' ? activeOrder.uuid : undefined;

                const response = await requireApi().submitOrder({
                    ...(appendUuid ? { orderUuid: appendUuid } : {}),
                    presetId,
                    customerNote: customerNote.trim() === '' ? null : customerNote.trim(),
                    customerEmail: null,
                    customerPhone: null,
                    tableStandNumber: standNumber === '' ? null : standNumber,
                    lines: toSubmitLines(validated.cart),
                });

                rememberOrder(response.order);
                set((state) => {
                    state.activeOrder = response.order;
                    state.activeOrderToken = response.access_token || response.order.access_token;
                    state.trackingStep = trackingStep(response.order);
                    state.cart = clearCart();
                    state.customerNote = '';
                    state.screen = 'status';
                });
                persistCart();
                return true;
            } catch (error) {
                set((state) => {
                    state.submitError = isOffline(error) ? 'so.error.offline' : 'so.checkout.failed';
                });
                return false;
            } finally {
                set((state) => {
                    state.submitting = false;
                });
            }
        },

        async cancelActiveOrder() {
            const { activeOrder, activeOrderToken } = get();
            if (!activeOrder || !activeOrderToken) return;
            try {
                const cancelled = await requireApi().cancelOrder(activeOrder.uuid, activeOrderToken);
                rememberOrder(cancelled);
                set((state) => {
                    state.activeOrder = cancelled;
                    state.trackingStep = trackingStep(cancelled);
                });
            } catch {
                set((state) => {
                    state.submitError = 'so.checkout.cancelRefused';
                });
            }
        },

        // ── payment (SLF-060, SLF-061, SLF-065) ─────────────────────────────
        /**
         * Start an online payment.
         *
         * The shipped provider is a `NullProvider` that confirms without contacting anyone, so
         * `redirect_url` is routinely `null`. That is not an error path — it is the normal path for
         * a venue with no PSP, and the flow (intent → confirm → recomputed totals → broadcast)
         * is real end to end. When there *is* a redirect we hand the browser over and pick the
         * reference back up on return.
         */
        async payOnline() {
            const { activeOrder, activeOrderToken } = get();
            if (!activeOrder || !activeOrderToken) return;

            set((state) => {
                state.paymentPending = true;
                state.submitError = null;
            });

            try {
                const returnUrl = `${globalThis.location?.origin ?? ''}${globalThis.location?.pathname ?? ''}?pay=return`;
                const intent = await requireApi().createPaymentIntent(
                    activeOrder.uuid,
                    activeOrderToken,
                    returnUrl,
                );

                if (intent.redirect_url) {
                    rememberPendingReference(get().configToken, intent.reference, activeOrder.uuid);
                    globalThis.location?.assign(intent.redirect_url);
                    return;
                }

                await get().resumePayment(intent.reference);
            } catch (error) {
                set((state) => {
                    state.paymentPending = false;
                    state.submitError = isOffline(error) ? 'so.error.offline' : 'so.checkout.paymentFailed';
                });
            }
        },

        async resumePayment(reference) {
            const { activeOrder, activeOrderToken } = get();
            if (!activeOrder || !activeOrderToken) return;
            try {
                const confirmation = await requireApi().confirmPayment(
                    activeOrder.uuid,
                    activeOrderToken,
                    reference,
                );
                rememberOrder(confirmation.order);
                set((state) => {
                    state.activeOrder = confirmation.order;
                    state.trackingStep = trackingStep(confirmation.order);
                    state.paymentPending = false;
                });
                clearPendingReference(get().configToken);
            } catch (error) {
                set((state) => {
                    state.paymentPending = false;
                    state.submitError = isOffline(error) ? 'so.error.offline' : 'so.checkout.paymentFailed';
                });
            }
        },

        // ── status (SLF-082, SLF-083) ───────────────────────────────────────
        async pollStatus() {
            const { activeOrder, activeOrderToken } = get();
            if (!activeOrder || !activeOrderToken) return;
            try {
                const status = await requireApi().orderStatus(activeOrder.uuid, activeOrderToken);
                rememberOrder(status);
                set((state) => {
                    state.activeOrder = status;
                    state.trackingStep = trackingStep(status);
                    state.offline = false;
                });
            } catch (error) {
                if (isOffline(error)) {
                    set((state) => {
                        state.offline = true;
                    });
                }
            }
        },

        async openKnownOrder(order) {
            set((state) => {
                state.activeOrderToken = order.accessToken;
                state.screen = 'status';
                state.trackingStep = order.step;
                state.activeOrder = state.activeOrder?.uuid === order.uuid ? state.activeOrder : null;
            });
            try {
                const status = await requireApi().orderStatus(order.uuid, order.accessToken);
                set((state) => {
                    state.activeOrder = status;
                    state.trackingStep = trackingStep(status);
                });
                rememberOrder(status);
            } catch {
                // Offline: the history entry we already have is what the customer sees.
            }
        },

        // ── preferences & reset ─────────────────────────────────────────────
        setLocale(locale) {
            set((state) => {
                state.prefs = { ...state.prefs, locale };
            });
            void savePrefs(get().configToken, get().prefs);
        },

        dismissInstall() {
            set((state) => {
                state.prefs = { ...state.prefs, installDismissed: true };
            });
            void savePrefs(get().configToken, get().prefs);
        },

        /**
         * Kiosk reset (SLF-090, SLF-094).
         *
         * Wipes the basket, the active order and the language back to the venue default. It does
         * *not* wipe the order history: a customer who already paid and walked off still has an
         * order somebody may need to look up, and the token for it lives there.
         */
        resetSession() {
            const configToken = get().configToken;
            set((state) => {
                state.cart = clearCart();
                state.cartIssues = [];
                state.activeOrder = null;
                state.activeOrderToken = null;
                state.paymentPending = false;
                state.submitError = null;
                state.standNumber = '';
                state.customerNote = '';
                state.presetId = null;
                state.detailProductId = null;
                state.editingLineUuid = null;
                state.screen = 'landing';
                state.prefs = { ...state.prefs, locale: null, presetId: null };
            });
            void clearCartOnly(configToken);
            void savePrefs(configToken, get().prefs);
        },
    };
});

/**
 * A payment redirect leaves the page, so the reference has to outlive the JS context.
 *
 * `sessionStorage` rather than IndexedDB on purpose: this must be readable *synchronously* during
 * the first render after the browser comes back from the PSP, and it must not survive the tab —
 * a stale reference on a shared kiosk is worse than losing it.
 */
const PENDING_KEY = 'restopos.selforder.pending_payment';

export function rememberPendingReference(configToken: string, reference: string, orderUuid: string): void {
    try {
        globalThis.sessionStorage?.setItem(
            PENDING_KEY,
            JSON.stringify({ configToken, reference, orderUuid }),
        );
    } catch {
        /* non-fatal */
    }
}

export function readPendingReference(
    configToken: string,
): { reference: string; orderUuid: string } | null {
    try {
        const raw = globalThis.sessionStorage?.getItem(PENDING_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { configToken?: string; reference?: string; orderUuid?: string };
        if (parsed.configToken !== configToken || !parsed.reference || !parsed.orderUuid) return null;
        return { reference: parsed.reference, orderUuid: parsed.orderUuid };
    } catch {
        return null;
    }
}

export function clearPendingReference(_configToken: string): void {
    try {
        globalThis.sessionStorage?.removeItem(PENDING_KEY);
    } catch {
        /* non-fatal */
    }
}

/** Products the menu screen shows for a category, respecting availability. */
export function productsFor(catalog: Catalog | null, categoryId: number | null): MenuProduct[] {
    if (!catalog) return [];
    if (categoryId === null) return catalog.products;
    return catalog.productsByCategory.get(categoryId) ?? [];
}
