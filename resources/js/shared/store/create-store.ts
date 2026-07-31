import { create, type StateCreator, type StoreApi, type UseBoundStore } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

/**
 * The one store factory all three apps use (spec 03 §3.4.2).
 *
 * Why this shape:
 *
 *  - **Zustand + Immer, not Redux Toolkit.** Every one of the ~120 register mutations would become
 *    an action + reducer + selector in RTK. Zustand's store actions are plain methods, which maps
 *    1:1 onto the Odoo `PosStore` methods being ported and makes the port reviewable side by side.
 *  - **`subscribeWithSelector`** because the customer display, the printer router and the outbox
 *    all need to react to a *slice* of state without re-rendering anything.
 *  - **Immer only on the mutable working set.** The catalog is a frozen module singleton; running a
 *    structural-sharing pass over megabytes of products on every keystroke would be absurd.
 *  - **`enableMapSet` deliberately NOT called.** We normalise with plain objects keyed by uuid:
 *    Immer's Map support is slower and plain objects are what `structuredClone` (worker,
 *    IndexedDB, BroadcastChannel) actually wants.
 */

type PosMutators = [['zustand/subscribeWithSelector', never], ['zustand/immer', never]];

export type PosStoreInitializer<T extends object> = StateCreator<T, PosMutators, []>;

export type PosStore<T extends object> = UseBoundStore<
    Omit<StoreApi<T>, 'subscribe'> & {
        subscribe: {
            (listener: (state: T, previous: T) => void): () => void;
            <U>(
                selector: (state: T) => U,
                listener: (selected: U, previous: U) => void,
                options?: { equalityFn?: (a: U, b: U) => boolean; fireImmediately?: boolean },
            ): () => void;
        };
    }
>;

export function createPosStore<T extends object>(initializer: PosStoreInitializer<T>): PosStore<T> {
    return create<T>()(subscribeWithSelector(immer(initializer))) as PosStore<T>;
}

/**
 * Shallow equality for selector results — the standard guard against re-rendering a product grid
 * because a selector returned a fresh array of the same ids.
 */
export function shallow<T>(a: T, b: T): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;

    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((value, index) => Object.is(value, b[index]));
    }

    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
        Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
}

/**
 * Debounced persistence helper.
 *
 * `markDirty` semantics from spec 03 §3.4.6: a 250 ms debounce, with two **mandatory** overrides,
 * both learned from Odoo's incident history —
 *   1. flush immediately on payment validation, before navigating to the receipt;
 *   2. flush immediately on `visibilitychange → hidden` and on `pagehide`.
 * A crash between "paid" and "flushed" loses money.
 */
export function createFlusher(flush: () => Promise<void>, debounceMs = 250) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;
    let inFlight: Promise<void> | null = null;

    const run = async (): Promise<void> => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        if (!pending) return inFlight ?? Promise.resolve();
        pending = false;
        inFlight = flush().finally(() => {
            inFlight = null;
        });
        return inFlight;
    };

    const schedule = (): void => {
        pending = true;
        if (timer !== null) return;
        timer = setTimeout(() => void run(), debounceMs);
    };

    const attachLifecycle = (): (() => void) => {
        const onHide = (): void => void run();
        const onVisibility = (): void => {
            if (globalThis.document?.visibilityState === 'hidden') void run();
        };
        globalThis.addEventListener?.('pagehide', onHide);
        globalThis.document?.addEventListener('visibilitychange', onVisibility);
        return () => {
            globalThis.removeEventListener?.('pagehide', onHide);
            globalThis.document?.removeEventListener('visibilitychange', onVisibility);
        };
    };

    return { schedule, flushNow: run, attachLifecycle };
}
