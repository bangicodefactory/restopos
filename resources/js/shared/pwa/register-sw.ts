/**
 * Service-worker registration — the page half of the three-scope strategy documented in
 * `vite.config.ts`.
 *
 * One worker script (`/sw.js`) is registered three times, once per scope:
 *
 *     registerServiceWorker({ scope: '/pos/' })       → the register PWA
 *     registerServiceWorker({ scope: '/kitchen/' })   → the kitchen display PWA
 *     registerServiceWorker({ scope: '/menu/' })      → the self-order PWA
 *
 * Each registration is an independent PWA: its own lifecycle, its own update cycle, its own caches
 * (the worker derives every cache name from `self.registration.scope`). Updating the register does
 * not invalidate the kiosk, and a customer's phone never precaches the register bundle.
 *
 * **Updates are never silent.** Swapping the bundle mid-transaction is how you lose an order, so a
 * waiting worker only takes over when the caller says it is safe (no open orders, empty outbox, not
 * closing the session, idle for a minute) — see `useSafeMoment` in `@shared/store`.
 */

export type SwScope = '/pos/' | '/kitchen/' | '/menu/';

export type UpdateState = {
    /** A new worker is installed and waiting. */
    pending: boolean;
    /** The app can run offline (first install completed). */
    offlineReady: boolean;
    /** Apply the waiting update and reload. Only call at a safe moment. */
    apply: () => void;
    /** Ask the browser to check for a new worker now. */
    checkForUpdate: () => Promise<void>;
    registration: ServiceWorkerRegistration | null;
};

export type RegisterOptions = {
    scope: SwScope;
    /** Path of the worker script. Must be at the origin root to claim these scopes. */
    swUrl?: string;
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    onError?: (error: Error) => void;
    /** Poll interval for update checks. A till is never manually refreshed. */
    updateIntervalMs?: number;
};

const NOOP_STATE: UpdateState = {
    pending: false,
    offlineReady: false,
    apply: () => {},
    checkForUpdate: async () => {},
    registration: null,
};

export async function registerServiceWorker(options: RegisterOptions): Promise<UpdateState> {
    const container = globalThis.navigator?.serviceWorker;
    if (!container) return NOOP_STATE;

    // Development runs from the Vite dev server, where there is no built worker to register.
    if (import.meta.env?.DEV) return NOOP_STATE;

    let registration: ServiceWorkerRegistration;
    try {
        registration = await container.register(options.swUrl ?? '/sw.js', {
            scope: options.scope,
            updateViaCache: 'none',
        });
    } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
        return NOOP_STATE;
    }

    const state: UpdateState = {
        pending: registration.waiting !== null,
        offlineReady: registration.active !== null && container.controller !== null,
        registration,
        apply: () => {
            const waiting = registration.waiting;
            if (!waiting) return;
            // The worker calls skipWaiting; controllerchange below reloads exactly once.
            waiting.postMessage({ type: 'SKIP_WAITING' });
        },
        checkForUpdate: async () => {
            try {
                await registration.update();
            } catch {
                // Offline: the next check will pick it up.
            }
        },
    };

    if (registration.waiting) options.onNeedRefresh?.();

    registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
            if (installing.state !== 'installed') return;
            if (container.controller) {
                state.pending = true;
                options.onNeedRefresh?.();
            } else {
                state.offlineReady = true;
                options.onOfflineReady?.();
            }
        });
    });

    let reloading = false;
    container.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        globalThis.location?.reload();
    });

    const interval = options.updateIntervalMs ?? 30 * 60 * 1000;
    setInterval(() => void state.checkForUpdate(), interval);

    return state;
}

/** Ask for a Background Sync of the outbox. A bonus path; correctness never depends on it. */
export async function requestBackgroundSync(tag = 'pos-order-sync'): Promise<boolean> {
    const registration = await globalThis.navigator?.serviceWorker?.ready;
    const sync = (registration as unknown as { sync?: { register(tag: string): Promise<void> } } | undefined)?.sync;
    if (!sync) return false;
    try {
        await sync.register(tag);
        return true;
    } catch {
        return false;
    }
}

/** Keep the catalog warm on a device left idle overnight, where the browser permits it. */
export async function requestPeriodicSync(tag = 'pos-delta-pull', minIntervalMs = 12 * 60 * 60 * 1000): Promise<boolean> {
    const registration = await globalThis.navigator?.serviceWorker?.ready;
    const periodic = (
        registration as unknown as {
            periodicSync?: { register(tag: string, options: { minInterval: number }): Promise<void> };
        } | undefined
    )?.periodicSync;
    if (!periodic) return false;
    try {
        await periodic.register(tag, { minInterval: minIntervalMs });
        return true;
    } catch {
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Install prompt
// ─────────────────────────────────────────────────────────────────────────────

type BeforeInstallPromptEvent = Event & {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;

/**
 * Installing is not cosmetic for register/KDS: an installed PWA keeps its storage bucket, launches
 * without browser chrome, and on Android is granted persistent storage. On iOS, where
 * `beforeinstallprompt` does not exist, the app shows Share → Add to Home Screen instructions and
 * refuses to run register/KDS in a Safari tab (7-day eviction for non-installed sites).
 */
export function watchInstallPrompt(onAvailable: (available: boolean) => void): () => void {
    const handler = (event: Event): void => {
        event.preventDefault();
        deferredPrompt = event as BeforeInstallPromptEvent;
        onAvailable(true);
    };
    const installed = (): void => {
        deferredPrompt = null;
        onAvailable(false);
    };

    globalThis.addEventListener?.('beforeinstallprompt', handler);
    globalThis.addEventListener?.('appinstalled', installed);

    return () => {
        globalThis.removeEventListener?.('beforeinstallprompt', handler);
        globalThis.removeEventListener?.('appinstalled', installed);
    };
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    if (!deferredPrompt) return 'unavailable';
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    return outcome;
}

/** `true` when running as an installed app rather than a browser tab. */
export function isStandalone(): boolean {
    const nav = globalThis.navigator as Navigator & { standalone?: boolean };
    return (
        globalThis.matchMedia?.('(display-mode: standalone), (display-mode: fullscreen)').matches === true ||
        nav?.standalone === true
    );
}
