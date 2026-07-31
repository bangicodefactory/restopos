import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import laravel from 'laravel-vite-plugin';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * RestoPOS build.
 *
 * Five entry points, exactly as fixed by docs/CONVENTIONS.md ("Fixed entry points"):
 *
 *   | App                   | Blade shell                    | Entry                                     | URL                  |
 *   |-----------------------|--------------------------------|-------------------------------------------|----------------------|
 *   | Back-office (Inertia) | resources/views/app.blade.php  | resources/js/backoffice/app.tsx           | /                    |
 *   | Register PWA          | register.blade.php             | resources/js/register/main.tsx            | /pos/{config}        |
 *   | Kitchen display PWA   | kitchen.blade.php              | resources/js/kitchen/main.tsx             | /kitchen/{display}   |
 *   | Self-order PWA        | selforder.blade.php            | resources/js/selforder/main.tsx           | /menu/{token}        |
 *   | Customer display      | customer_display.blade.php     | resources/js/register/customer-display.tsx| /pos/{config}/display|
 *
 * ---------------------------------------------------------------------------------------------
 * PWA STRATEGY — why ONE service worker source for THREE scopes
 * ---------------------------------------------------------------------------------------------
 * Spec 03 §1.5 requires three independent PWA scopes: register `/pos/`, kitchen `/kitchen/`,
 * self-order `/menu/`. A customer's phone must not precache the register bundle, and a register
 * update must not invalidate the kiosk's cache.
 *
 * `vite-plugin-pwa` emits exactly one service worker per build, and three separate Vite builds
 * would produce three Laravel manifests that `@vite()` cannot merge. So we do neither of the
 * naive options. Instead:
 *
 *   1. `injectManifest` mode compiles ONE hand-written worker, `resources/js/sw/sw.ts`.
 *   2. It is emitted to `public/sw.js` (NOT `public/build/`) — a worker script may only claim
 *      scopes at or below its own path, so a worker under `/build/` could never control `/pos/`.
 *   3. Each shell registers that same script under its own scope:
 *          navigator.serviceWorker.register('/sw.js', { scope: '/pos/' })
 *      The browser then creates three *independent registrations*, each with its own lifecycle,
 *      its own update cycle and — because the worker derives every `caches.open()` name from
 *      `self.registration.scope` — its own cache storage. Uninstalling or updating one does not
 *      touch the others.
 *   4. The worker reads its scope at startup (`resolveProfile()` in `resources/js/sw/profile.ts`)
 *      and filters the injected precache manifest down to the assets that scope actually needs.
 *
 * Net effect: one build artifact, three genuinely separate PWAs. See resources/js/sw/sw.ts.
 */
const APP_VERSION = process.env.APP_VERSION ?? '0.1.0';

export default defineConfig({
    plugins: [
        laravel({
            input: [
                'resources/css/app.css',
                'resources/js/backoffice/app.tsx',
                'resources/js/register/main.tsx',
                'resources/js/register/customer-display.tsx',
                'resources/js/kitchen/main.tsx',
                'resources/js/selforder/main.tsx',
            ],
            refresh: true,
        }),

        react(),

        VitePWA({
            strategies: 'injectManifest',
            srcDir: 'resources/js/sw',
            filename: 'sw.ts',
            // The worker MUST live at the origin root so `/pos/`, `/kitchen/` and `/menu/`
            // are all legal scopes for it. See the block comment above.
            outDir: 'public',
            registerType: 'prompt',
            // We register manually, per scope, from resources/js/shared/pwa.
            injectRegister: false,
            // Manifests are hand-written per app in public/manifest.*.json (spec 03 §8.2).
            manifest: false,
            devOptions: { enabled: false },
            injectManifest: {
                // Assets are emitted by the main build into public/build; the worker is emitted
                // into public/. Glob the former, rewrite the URLs to how they are actually served.
                globDirectory: 'public/build',
                globPatterns: ['assets/**/*.{js,css,woff,woff2}'],
                modifyURLPrefix: { '': '/build/' },
                maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
                injectionPoint: 'self.__WB_MANIFEST',
            },
        }),
    ],

    define: {
        __APP_VERSION__: JSON.stringify(APP_VERSION),
    },

    resolve: {
        alias: {
            '@domain': r('./packages/domain/src'),
            '@shared': r('./resources/js/shared'),
            '@register': r('./resources/js/register'),
            '@kitchen': r('./resources/js/kitchen'),
            '@selforder': r('./resources/js/selforder'),
            '@backoffice': r('./resources/js/backoffice'),
        },
    },

    build: {
        target: 'es2022',
        sourcemap: true,
        rollupOptions: {
            output: {
                /**
                 * Prefix every entry chunk with its app folder.
                 *
                 * Without this all three PWA entries are called `main.tsx`, so they all emit
                 * `assets/main-<hash>.js` and the service worker cannot tell which chunk belongs to
                 * which scope. `assets/register-main-<hash>.js` makes the precache filter in
                 * `resources/js/sw/profile.ts` a simple, reliable prefix test.
                 */
                entryFileNames(chunk): string {
                    const app = /resources\/js\/([^/]+)\//.exec(chunk.facadeModuleId ?? '')?.[1];
                    return app ? `assets/${app}-[name]-[hash].js` : 'assets/[name]-[hash].js';
                },
                // Keep the three PWA bundles separable so each scope precaches only its own code.
                manualChunks(id: string): string | undefined {
                    if (id.includes('/packages/domain/')) return 'domain';
                    if (id.includes('/resources/js/shared/')) return 'shared';
                    if (id.includes('/node_modules/react') || id.includes('/node_modules/scheduler')) {
                        return 'react';
                    }
                    return undefined;
                },
            },
        },
    },

    server: {
        host: '0.0.0.0',
        watch: { ignored: ['**/vendor/**', '**/storage/**', '**/tools/mirror/**'] },
    },
});
