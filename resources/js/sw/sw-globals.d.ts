/**
 * Service-worker globals.
 *
 * `lib.webworker.d.ts` cannot be added to the app program: it collides with `lib.dom.d.ts` on
 * dozens of shared identifiers, and the SW compiles as part of the same TypeScript project as the
 * React apps. So the (small) surface the worker actually uses is declared here instead. This also
 * documents exactly which SW APIs we depend on.
 */

interface ExtendableEvent extends Event {
    waitUntil(promise: Promise<unknown>): void;
}

interface FetchEvent extends ExtendableEvent {
    readonly request: Request;
    readonly clientId: string;
    readonly preloadResponse: Promise<unknown>;
    respondWith(response: Response | Promise<Response>): void;
}

interface ExtendableMessageEvent extends ExtendableEvent {
    readonly data: unknown;
    readonly source: { postMessage(message: unknown): void } | null;
}

interface SyncEvent extends ExtendableEvent {
    readonly tag: string;
    readonly lastChance: boolean;
}

interface ServiceWorkerClientLike {
    readonly id: string;
    readonly url: string;
    readonly type: string;
    postMessage(message: unknown): void;
    focus?(): Promise<ServiceWorkerClientLike>;
}

interface ServiceWorkerClientsLike {
    claim(): Promise<void>;
    get(id: string): Promise<ServiceWorkerClientLike | undefined>;
    matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<ServiceWorkerClientLike[]>;
    openWindow(url: string): Promise<ServiceWorkerClientLike | null>;
}

interface ServiceWorkerRegistrationLike {
    readonly scope: string;
    readonly waiting: { postMessage(message: unknown): void } | null;
    unregister(): Promise<boolean>;
}

interface ServiceWorkerGlobalScopeLike {
    readonly clients: ServiceWorkerClientsLike;
    readonly registration: ServiceWorkerRegistrationLike;
    readonly location: Location;
    readonly caches: CacheStorage;
    skipWaiting(): Promise<void>;
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
    addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
    addEventListener(type: 'message', listener: (event: ExtendableMessageEvent) => void): void;
    addEventListener(type: 'sync' | 'periodicsync', listener: (event: SyncEvent) => void): void;
    /** Injected at build time by `vite-plugin-pwa` / workbox-build. */
    __WB_MANIFEST: ReadonlyArray<{ url: string; revision: string | null }>;
}

/**
 * NOT declared as `self`: lib.dom already declares `self: Window & typeof globalThis`, and a
 * global re-declaration would either conflict or silently lose. `sw.ts` casts once instead:
 *
 *     const sw = self as unknown as ServiceWorkerGlobalScopeLike;
 */
