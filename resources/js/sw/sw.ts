// A service worker needs the WorkerGlobalScope ambient types before any import is resolved,
// and a triple-slash reference is the only form that works here.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./sw-globals.d.ts" />

import { cacheNames, filterManifest, manifestVersion, resolveProfile } from './profile';

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

const profile = resolveProfile(sw.registration.scope);

/** Injected at build time by workbox-build's injectManifest. */
const MANIFEST = (self as unknown as ServiceWorkerGlobalScopeLike).__WB_MANIFEST;

const PRECACHE_URLS = filterManifest(MANIFEST, profile);

/**
 * Cache-name version, derived from the injected manifest.
 *
 * This was the constant `'v1'`, which meant the cache names never changed, which meant the
 * `activate` cleanup below — written to delete caches no longer named in `names` — could never
 * delete anything. Asset filenames are content-hashed, so every deploy added a fresh set of chunks
 * and kept every previous set forever, on the same device whose storage policy is careful enough to
 * distinguish an evictable product photo from a receipt logo it must not lose (BAN-504).
 *
 * Derived from the manifest rather than from a build-time define because the worker is compiled
 * separately by `injectManifest`, and because the manifest is the thing that actually changes when
 * the assets do: same assets, same caches; new deploy, new caches, old ones swept on activate.
 */
const VERSION = manifestVersion(MANIFEST);

const names = cacheNames(profile, VERSION);


// ─────────────────────────────────────────────────────────────────────────────
// Install / activate
// ─────────────────────────────────────────────────────────────────────────────

sw.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const cache = await sw.caches.open(names.precache);
            // `reload` bypasses the HTTP cache: precaching a stale asset is worse than not
            // precaching at all. The cache it lands in is versioned by the manifest, so a deploy
            // gets fresh cache names and `activate` sweeps the previous ones.
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

            // The shell document is deliberately NOT fetched here, and this used to be the bug.
            //
            // `profile.shellUrl` is a scope *prefix* — `/pos/`, `/kitchen/`, `/menu/` — and every
            // shell route is parameterised: `/pos/{config}`, `/kitchen/{token}`, `/menu/{token}`.
            // So `fetch('/pos/')` is a 404, `response.ok` is false, and nothing was ever cached
            // under a comment promising "without it there is no offline cold boot". A till that had
            // been paired and traded all day still served the not-installed page the next morning
            // (BAN-504).
            //
            // The real URL is only knowable from a window, so it is captured on `activate` and on
            // every successful navigation instead.
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

            // The first navigation of a fresh install is not controlled by this worker, so nothing
            // would be cached until a *second* online load — which for a till means the morning
            // after, offline, too late. Reading the open windows costs nothing and needs no
            // control, so the shell is captured the moment this worker activates (BAN-504).
            await cacheShellFromClients();
        })(),
    );
});

/**
 * The cache key for a shell document: origin and path, without query or hash.
 *
 * `/pos/1?debug=1` and `/pos/1` are the same document — the shell is propless and the app reads the
 * path at runtime — so keying by the full URL would accumulate a near-duplicate entry per distinct
 * query string ever visited, and make `anyShellInScope` scan them all.
 */
function shellKey(url: URL | string): string {
    const parsed = typeof url === 'string' ? new URL(url) : url;

    return parsed.origin + parsed.pathname;
}

/**
 * Cache the real shell document of any window already in this worker's scope.
 *
 * The URL cannot be derived — `/pos/1` and `/pos/7` are different tills — so it is taken from the
 * window that is open right now. Failures are ignored: a worker that activates while offline simply
 * fills the cache on the next successful navigation.
 */
async function cacheShellFromClients(): Promise<void> {
    const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const cache = await sw.caches.open(names.shell);

    await Promise.all(
        windows
            .map((client) => new URL(client.url))
            .filter((url) => isSameOrigin(url) && inScope(url))
            .map(async (url) => {
                try {
                    const response = await fetch(new Request(url.href, { cache: 'reload' }));
                    if (response.ok) await cache.put(shellKey(url), response);
                } catch {
                    // Offline at activation: the next online navigation fills it.
                }
            }),
    );
}

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
    //
    //    Both caches, and that is the fix for a bug that made the precache decorative: `install`
    //    writes to `names.precache` and this rule only ever read `names.assets`, so every file the
    //    worker carefully downloaded at install time sat in a cache nothing consulted. Offline, the
    //    shell loaded and every one of its scripts 404'd into a blank screen (BAN-504).
    if (url.pathname.startsWith('/build/')) {
        event.respondWith(cacheFirstIn(request, [names.precache, names.assets], names.assets));
        return;
    }

    // 3. Fonts — receipts block on them, so they must be local.
    if (request.destination === 'font' || /\.(?:woff2?|ttf|otf)$/.test(url.pathname)) {
        event.respondWith(cacheFirst(request, names.fonts));
        return;
    }

    // 4. Public imagery — nice to have, never blocking, LRU-capped.
    //
    //    `/storage/` only. This used to also list `/media/`, a path nothing ever served; the media
    //    route landed at `/api/pos/media/{id}` and deliberately does not belong here — it is
    //    device-authenticated, so its responses have no business in a shared cache, and the clients
    //    already keep those bytes in IndexedDB where the rest of the replica lives (BAN-480).
    //    What still comes through here is the kiosk's public product photos, which are plain
    //    `/storage/` URLs because a customer's phone has no token to fetch with.
    if (url.pathname.startsWith('/storage/')) {
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
            // Keyed by the request's own URL, not by `profile.shellUrl`. The latter is a scope
            // prefix that no route serves, so it could only ever be a synthetic key — and one that
            // told you nothing about *which* till had been cached (BAN-504).
            await cache.put(shellKey(request.url), response.clone());

            return response;
        }
    } catch {
        // …and cache-fallback so a cold boot with a dead uplink still opens the till.
    }

    const cached = (await cache.match(shellKey(request.url))) ?? (await anyShellInScope(cache));
    if (cached) return cached;

    return new Response(OFFLINE_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

/**
 * Any cached shell belonging to this scope.
 *
 * The fallback for a deep link: a till reopened offline at `/pos/1/payment` has no entry for that
 * exact URL, but `/pos/1` is the same document — the router reads the path once React is up. Serving
 * the sibling is right for a single-page app and is the difference between resuming a service and
 * staring at the not-installed page.
 */
async function anyShellInScope(cache: Cache): Promise<Response | undefined> {
    for (const key of await cache.keys()) {
        const url = new URL(key.url);

        if (isSameOrigin(url) && inScope(url)) {
            const hit = await cache.match(key);
            if (hit) return hit;
        }
    }

    return undefined;
}

/**
 * Cache-first across several caches, storing a network miss in `writeTo`.
 *
 * The precache is authoritative and immutable; `assets` is where anything fetched at runtime lands —
 * a lazily-imported chunk, say, which no install-time manifest can enumerate ahead of the import
 * that needs it.
 */
async function cacheFirstIn(request: Request, readFrom: string[], writeTo: string): Promise<Response> {
    for (const name of readFrom) {
        const cache = await sw.caches.open(name);
        const hit = await cache.match(request);
        if (hit) return hit;
    }

    const response = await fetch(request);

    if (response.ok) {
        const cache = await sw.caches.open(writeTo);
        await cache.put(request, response.clone());
    }

    return response;
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
    // the OS woke us up to do. A cached shell key is a real document URL; `profile.shellUrl` is a
    // scope prefix that 404s, so it is only the last resort (BAN-504).
    await sw.clients.openWindow(await lastKnownShellUrl());
}

async function notifyClients(message: unknown): Promise<void> {
    const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage(message);
}

/** The most recently cached shell document for this scope, or the bare prefix if there is none. */
async function lastKnownShellUrl(): Promise<string> {
    const cache = await sw.caches.open(names.shell);

    for (const key of await cache.keys()) {
        const url = new URL(key.url);
        if (isSameOrigin(url) && inScope(url)) return key.url;
    }

    return profile.shellUrl;
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
