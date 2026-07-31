// A service worker needs the WorkerGlobalScope ambient types before any import is resolved,
// and a triple-slash reference is the only form that works here.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./sw-globals.d.ts" />

import { cacheNames, filterManifest, resolveProfile } from './profile';

/**
 * The RestoPOS service worker (spec 03 §8).
 *
 * Hand-written rather than generated. Generated-SW mode does not survive contact with an app that
 * must decide, per request, whether "no network" is an error or the normal case — for a register it
 * is the normal case.
 *
 * One script, three registrations, three scopes (`/pos/`, `/kitchen/`, `/menu/`) — see the block
 * comment in `vite.config.ts`. Every cache name below is derived from `sw.registration.scope`, so
 * the three PWAs never touch each other's storage.
 *
 * Strategy per asset class:
 *
 *   | Asset class          | Strategy                    | Why                                          |
 *   |----------------------|-----------------------------|----------------------------------------------|
 *   | App shell HTML       | Precache + navigation route | The whole offline story depends on it        |
 *   | Hashed JS/CSS        | Precache, then cache-first  | Content-addressed, immutable                 |
 *   | Fonts                | Cache-first, long TTL       | Receipt rendering blocks on font load        |
 *   | Product images       | Cache-first + LRU cap       | Large, optional, evictable                   |
 *   | `GET /api/**`        | Network-first, cache fallback for the few safe reads |                      |
 *   | `POST /api/pos/sync` | **Never cached, never intercepted**                 |                      |
 *
 * The rule that is not negotiable: **IndexedDB is the single source of truth for data.** A cached
 * API response would be a second, unsynchronised one.
 */

/**
 * `self` is typed as `Window` by lib.dom (see sw-globals.d.ts for why we do not re-declare it), so
 * the worker scope is obtained once here and used everywhere below.
 */
const sw = self as unknown as ServiceWorkerGlobalScopeLike;

const VERSION = 'v1';

const profile = resolveProfile(sw.registration.scope);
const names = cacheNames(profile, VERSION);

/** Injected at build time by workbox-build's injectManifest. */
const MANIFEST = (self as unknown as ServiceWorkerGlobalScopeLike).__WB_MANIFEST;

const PRECACHE_URLS = filterManifest(MANIFEST, profile);

// ─────────────────────────────────────────────────────────────────────────────
// Install / activate
// ─────────────────────────────────────────────────────────────────────────────

sw.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const cache = await sw.caches.open(names.precache);
            // `reload` bypasses the HTTP cache: precaching a stale asset is worse than not
            // precaching at all, because it survives until the next deploy.
            await Promise.all(
                PRECACHE_URLS.map(async (url) => {
                    try {
                        const response = await fetch(new Request(url, { cache: 'reload' }));
                        if (response.ok) await cache.put(url, response);
                    } catch {
                        // A single missing asset must not fail the whole install.
                    }
                }),
            );

            // The shell document. Without it there is no offline cold boot.
            try {
                const shell = await fetch(new Request(profile.shellUrl, { cache: 'reload' }));
                if (shell.ok) {
                    const shellCache = await sw.caches.open(names.shell);
                    await shellCache.put(profile.shellUrl, shell);
                }
            } catch {
                // Installed while offline: the first successful navigation will fill it.
            }
        })(),
    );
    // NOTE: no skipWaiting() here. The page decides when it is safe to hand over (spec 03 §8.4);
    // swapping the bundle mid-transaction is how you lose an order.
});

sw.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            const keys = await sw.caches.keys();
            await Promise.all(
                keys
                    .filter((key) => key.startsWith(names.prefix) && !Object.values(names).includes(key))
                    .map((key) => sw.caches.delete(key)),
            );
            // clientsClaim() is deliberately NOT called: the handover is explicit.
        })(),
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// Fetch routing
// ─────────────────────────────────────────────────────────────────────────────

const SYNC_PATHS = ['/api/pos/sync', '/broadcasting/auth'];

function isSameOrigin(url: URL): boolean {
    return url.origin === sw.location.origin;
}

function inScope(url: URL): boolean {
    return url.pathname.startsWith(profile.scopePath);
}

sw.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);

    // Anything that mutates server state is never our business.
    if (request.method !== 'GET') return;
    if (!isSameOrigin(url)) return;

    // The push endpoint and broadcast auth are never touched, in either direction.
    if (SYNC_PATHS.some((path) => url.pathname.startsWith(path))) return;

    // 1. Navigations inside this scope resolve to the precached shell.
    if (request.mode === 'navigate') {
        if (!inScope(url)) return;
        event.respondWith(handleNavigation(request));
        return;
    }

    // 2. Hashed build assets — immutable under their URL, so cache-first.
    if (url.pathname.startsWith('/build/')) {
        event.respondWith(cacheFirst(request, names.assets));
        return;
    }

    // 3. Fonts — receipts block on them, so they must be local.
    if (request.destination === 'font' || /\.(?:woff2?|ttf|otf)$/.test(url.pathname)) {
        event.respondWith(cacheFirst(request, names.fonts));
        return;
    }

    // 4. Product imagery — nice to have, never blocking, LRU-capped.
    if (url.pathname.startsWith('/storage/') || url.pathname.startsWith('/media/')) {
        if (!profile.cacheProductImages) return;
        event.respondWith(cacheFirstCapped(request, names.images, profile.imageCacheLimit));
        return;
    }

    // 5. API reads — network-first with a cache fallback ONLY for the handful of endpoints that
    //    are genuinely idempotent reference data. Everything else goes to the network or fails,
    //    because IndexedDB is the offline data store, not the HTTP cache.
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(networkOnly(request));
        return;
    }

    // 6. Icons and manifests — small, needed for install, safe to precache lazily.
    if (url.pathname.startsWith('/icons/') || url.pathname.startsWith('/manifest')) {
        event.respondWith(cacheFirst(request, names.assets));
        return;
    }
});

async function handleNavigation(request: Request): Promise<Response> {
    const cache = await sw.caches.open(names.shell);

    try {
        // Network-first for the shell so a deploy is picked up on the next launch when online…
        const response = await fetch(request);
        if (response.ok) {
            await cache.put(profile.shellUrl, response.clone());
            return response;
        }
    } catch {
        // …and cache-fallback so a cold boot with a dead uplink still opens the till.
    }

    const cached = (await cache.match(profile.shellUrl)) ?? (await cache.match(request));
    if (cached) return cached;

    return new Response(OFFLINE_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
    const cache = await sw.caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response.ok || response.type === 'opaque') await cache.put(request, response.clone());
        return response;
    } catch {
        return new Response('', { status: 504, statusText: 'Offline' });
    }
}

/**
 * Cache-first with a crude LRU: when the cache exceeds `limit`, drop the oldest quarter. Crude is
 * fine — these are re-fetchable images, and the alternative (tracking access times in IndexedDB)
 * costs more than it saves.
 */
async function cacheFirstCapped(request: Request, cacheName: string, limit: number): Promise<Response> {
    const cache = await sw.caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response.ok) {
            await cache.put(request, response.clone());
            const keys = await cache.keys();
            if (keys.length > limit) {
                const excess = keys.slice(0, Math.ceil(limit / 4));
                await Promise.all(excess.map((key) => cache.delete(key)));
            }
        }
        return response;
    } catch {
        return new Response('', { status: 504, statusText: 'Offline' });
    }
}

async function networkOnly(request: Request): Promise<Response> {
    try {
        return await fetch(request);
    } catch {
        // A structured 503 so the client's error classifier reports `offline` rather than
        // a parse failure.
        return new Response(JSON.stringify({ message: 'offline' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Messages, background sync, quota
// ─────────────────────────────────────────────────────────────────────────────

sw.addEventListener('message', (event) => {
    const data = event.data as { type?: string } | null;
    if (!data?.type) return;

    switch (data.type) {
        case 'SKIP_WAITING':
            // The page has decided it is safe: no open orders, empty outbox, idle.
            event.waitUntil(sw.skipWaiting());
            return;

        case 'GET_VERSION':
            event.source?.postMessage({ type: 'VERSION', version: VERSION, profile: profile.name });
            return;

        case 'CLEAR_IMAGE_CACHE':
            // Quota rescue from the page (spec 03 §8.6): images are always re-fetchable.
            event.waitUntil(sw.caches.delete(names.images));
            return;
    }
});

/**
 * Background Sync (spec 03 §8.5) — strictly a bonus.
 *
 * The in-page outbox is the primary mechanism and is fully correct on its own; this only helps when
 * the tab is closed and the OS wakes the worker (unavailable on iOS and Firefox). We do not replay
 * requests here — the payload lives in IndexedDB and only the page knows how to diff it — we wake
 * a client instead, and if none exists we open one.
 */
sw.addEventListener('sync', (event) => {
    if (event.tag !== 'pos-order-sync') return;
    event.waitUntil(wakeClientsToSync());
});

sw.addEventListener('periodicsync', (event) => {
    if (event.tag !== 'pos-delta-pull') return;
    event.waitUntil(notifyClients({ type: 'PULL_DELTA' }));
});

async function wakeClientsToSync(): Promise<void> {
    const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length > 0) {
        for (const client of clients) client.postMessage({ type: 'DRAIN_OUTBOX' });
        return;
    }
    // No window at all: opening one is the only way the outbox can drain, and it is exactly what
    // the OS woke us up to do.
    await sw.clients.openWindow(profile.shellUrl);
}

async function notifyClients(message: unknown): Promise<void> {
    const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage(message);
}

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline</title>
<style>
  body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0;text-align:center;padding:2rem}
  h1{font-size:1.5rem;margin:0 0 .5rem}
  p{opacity:.8;max-width:32rem}
  button{margin-top:1.5rem;min-height:3.5rem;padding:0 2rem;font-size:1rem;font-weight:600;border:0;border-radius:.75rem;background:#2563eb;color:#fff}
</style></head>
<body>
  <div>
    <h1>This device has not finished installing</h1>
    <p>The application shell has not been cached yet, so it cannot start without a network
       connection. Connect to the venue network once and it will work offline from then on.</p>
    <button onclick="location.reload()">Try again</button>
  </div>
</body></html>`;
