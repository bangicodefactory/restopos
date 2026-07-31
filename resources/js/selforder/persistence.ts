import { getDb, getMeta, setMeta, type PosDb } from '@shared/db';
import type { Locale } from '@shared/i18n';

import type { Cart } from './logic/cart';
import type { KnownOrder, MenuResponse } from './types';

/**
 * What a customer's browser remembers (SLF-081, SLF-082).
 *
 * Three things, and each has a reason to survive a reload:
 *   - the **menu snapshot**, so the QR still shows a menu on a venue's dead Wi-Fi;
 *   - the **cart**, so a phone call mid-order does not lose the basket;
 *   - the **known orders**, each with its `access_token` — the *only* credential for viewing,
 *     cancelling or paying that order. Losing it strands the customer.
 *
 * That last one is why this is IndexedDB and not `localStorage`, per `docs/CONVENTIONS.md`: the
 * order tokens are bearer secrets, and `localStorage` is synchronous, string-only and the first
 * thing an injected script reads.
 *
 * ── The pointer exception ────────────────────────────────────────────────────────────────────
 * `getDb()` is keyed by config **id**, but a phone arriving at `/menu/{configToken}` has only the
 * token, and it needs storage before the first network call resolves the id. So a single integer —
 * the config id for this token — lives in `localStorage`, keyed by the token. It is not a secret
 * (the token in the URL already is one), and it is the equivalent of a filename.
 */

const POINTER_PREFIX = 'restopos.selforder.config.';

function pointerKey(configToken: string): string {
    return `${POINTER_PREFIX}${configToken}`;
}

export function readConfigPointer(configToken: string): number | null {
    try {
        const raw = globalThis.localStorage?.getItem(pointerKey(configToken));
        const value = raw === null || raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
        return Number.isInteger(value) ? value : null;
    } catch {
        return null;
    }
}

export function writeConfigPointer(configToken: string, configId: number): void {
    try {
        globalThis.localStorage?.setItem(pointerKey(configToken), String(configId));
    } catch {
        /* Private browsing. The app degrades to network-only, which still works. */
    }
}

function keys(configToken: string): { menu: string; cart: string; orders: string; prefs: string } {
    return {
        menu: `so.menu.${configToken}`,
        cart: `so.cart.${configToken}`,
        orders: `so.orders.${configToken}`,
        prefs: `so.prefs.${configToken}`,
    };
}

/** `null` when we have never seen this venue before and the network is down. */
export function openStore(configToken: string): PosDb | null {
    const configId = readConfigPointer(configToken);
    return configId === null ? null : getDb(configId);
}

export type SelfOrderPrefs = {
    locale: Locale | null;
    presetId: number | null;
    /** Whether the customer has already dismissed the install prompt (SLF-014). */
    installDismissed: boolean;
};

export const DEFAULT_PREFS: SelfOrderPrefs = { locale: null, presetId: null, installDismissed: false };

export type CachedMenu = MenuResponse & { cachedAt: number };

export async function saveMenu(configToken: string, menu: MenuResponse): Promise<void> {
    writeConfigPointer(configToken, configIdOf(menu));
    const db = openStore(configToken);
    if (!db) return;
    await setMeta(db, keys(configToken).menu, { ...menu, cachedAt: Date.now() });
}

export async function loadMenu(configToken: string): Promise<CachedMenu | null> {
    const db = openStore(configToken);
    if (!db) return null;
    return getMeta<CachedMenu | null>(db, keys(configToken).menu, null);
}

export async function saveCart(configToken: string, cart: Cart): Promise<void> {
    const db = openStore(configToken);
    if (!db) return;
    await setMeta(db, keys(configToken).cart, cart);
}

export async function loadCart(configToken: string): Promise<Cart | null> {
    const db = openStore(configToken);
    if (!db) return null;
    const cart = await getMeta<Cart | null>(db, keys(configToken).cart, null);
    return cart && Array.isArray(cart.lines) ? cart : null;
}

export async function saveKnownOrders(configToken: string, orders: readonly KnownOrder[]): Promise<void> {
    const db = openStore(configToken);
    if (!db) return;
    // A phone is not an archive: keep the last 20, newest first.
    const trimmed = [...orders].sort((a, b) => b.placedAt - a.placedAt).slice(0, 20);
    await setMeta(db, keys(configToken).orders, trimmed);
}

export async function loadKnownOrders(configToken: string): Promise<KnownOrder[]> {
    const db = openStore(configToken);
    if (!db) return [];
    const orders = await getMeta<KnownOrder[] | null>(db, keys(configToken).orders, null);
    return Array.isArray(orders) ? orders : [];
}

export async function savePrefs(configToken: string, prefs: SelfOrderPrefs): Promise<void> {
    const db = openStore(configToken);
    if (!db) return;
    await setMeta(db, keys(configToken).prefs, prefs);
}

export async function loadPrefs(configToken: string): Promise<SelfOrderPrefs> {
    const db = openStore(configToken);
    if (!db) return DEFAULT_PREFS;
    const prefs = await getMeta<Partial<SelfOrderPrefs> | null>(db, keys(configToken).prefs, null);
    return { ...DEFAULT_PREFS, ...(prefs ?? {}) };
}

/**
 * Wipe the basket but keep the order history.
 *
 * The kiosk reset (SLF-090) must never show the previous customer's basket, but the orders that
 * were actually placed still need their tokens — a customer who walked away mid-payment can still
 * be helped at the counter.
 */
export async function clearCartOnly(configToken: string): Promise<void> {
    await saveCart(configToken, { lines: [] });
}

function configIdOf(menu: MenuResponse): number {
    const config = menu.data?.pos_config;
    if (!config) return 0;
    return Array.isArray(config) ? (config[0]?.id ?? 0) : config.id;
}
