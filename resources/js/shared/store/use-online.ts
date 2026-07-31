import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Connectivity.
 *
 * `navigator.onLine` is advisory at best: it reports "a network interface exists", which on a venue
 * Wi-Fi with a dead uplink is a lie. So `useOnline` combines the browser flag with an optional
 * heartbeat against our own origin, and the heartbeat is authoritative when it has run.
 */

type Listener = () => void;

let browserOnlineState = globalThis.navigator?.onLine !== false;
const listeners = new Set<Listener>();

function notify(): void {
    for (const listener of listeners) listener();
}

if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('online', () => {
        browserOnlineState = true;
        notify();
    });
    globalThis.addEventListener('offline', () => {
        browserOnlineState = false;
        notify();
    });
}

function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
    return browserOnlineState;
}

/** SSR / prerender: assume online so the back-office does not flash an offline banner. */
function getServerSnapshot(): boolean {
    return true;
}

export function useOnline(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export type HeartbeatOptions = {
    url?: string;
    intervalMs?: number;
    timeoutMs?: number;
    enabled?: boolean;
};

export type ReachabilityState = {
    /** The browser's opinion. */
    browserOnline: boolean;
    /** Our opinion, from the last heartbeat. `null` until the first one completes. */
    reachable: boolean | null;
    lastCheckAt: number | null;
    check: () => Promise<boolean>;
};

/**
 * Heartbeat against `/api/pos/ping`.
 *
 * Cheap (a 204), never cached by the service worker (all `/api/**` is NetworkOnly), and paused
 * while the document is hidden so a backgrounded till does not burn battery.
 */
export function useReachability(options: HeartbeatOptions = {}): ReachabilityState {
    const online = useOnline();
    const reachableRef = useRef<boolean | null>(null);
    const lastCheckRef = useRef<number | null>(null);
    const [, force] = useForceRender();

    const check = useCallback(async (): Promise<boolean> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
        try {
            const response = await fetch(options.url ?? '/api/pos/ping', {
                method: 'GET',
                cache: 'no-store',
                credentials: 'omit',
                signal: controller.signal,
            });
            reachableRef.current = response.ok || response.status === 204;
        } catch {
            reachableRef.current = false;
        } finally {
            clearTimeout(timer);
            lastCheckRef.current = Date.now();
            force();
        }
        return reachableRef.current;
    }, [options.url, options.timeoutMs, force]);

    useEffect(() => {
        if (options.enabled === false) return;
        void check();
        const interval = setInterval(() => {
            if (globalThis.document?.visibilityState === 'hidden') return;
            void check();
        }, options.intervalMs ?? 30_000);
        return () => clearInterval(interval);
    }, [check, options.enabled, options.intervalMs]);

    return {
        browserOnline: online,
        reachable: reachableRef.current,
        lastCheckAt: lastCheckRef.current,
        check,
    };
}

function useForceRender(): [number, () => void] {
    const ref = useRef(0);
    const listenersRef = useRef(new Set<Listener>());

    const value = useSyncExternalStore(
        useCallback((listener: Listener) => {
            const set = listenersRef.current;
            set.add(listener);
            return () => set.delete(listener);
        }, []),
        useCallback(() => ref.current, []),
        useCallback(() => 0, []),
    );

    const force = useCallback(() => {
        ref.current += 1;
        for (const listener of listenersRef.current) listener();
    }, []);

    return [value, force];
}
