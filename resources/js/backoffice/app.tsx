/**
 * Back-office entry point (docs/CONVENTIONS.md "Fixed entry points": `/` → `app.blade.php`).
 *
 * This is the one RestoPOS surface that is a normal, always-online Inertia application. It has no
 * service worker, no IndexedDB and no outbox: an admin who loses connectivity should see a failed
 * request, not a queue of half-applied configuration changes that will land on forty tills an
 * hour later.
 *
 * The tree below is deliberately shallow and fixed:
 *
 *   I18nProvider (French by default)
 *     └─ ToastProvider         — flash messages and action feedback
 *          └─ ErrorBoundary    — keyed on the page component, so a crash on one screen is
 *                                recovered by navigating away rather than by reloading
 *               └─ <App />
 *
 * Page components are resolved lazily from `./pages/`; the names Vite sees are exactly the
 * strings `Inertia::render()` is called with in `app/Http/Controllers/Backoffice/*`
 * (spec 05 §12).
 */

import { createInertiaApp } from '@inertiajs/react';
import { I18nProvider, resolveLocale, type Locale } from '@shared/i18n';
import { ErrorBoundary, ToastProvider } from '@shared/ui';
import { resolvePageComponent } from 'laravel-vite-plugin/inertia-helpers';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const APP_NAME = 'RestoPOS';

/**
 * French first.
 *
 * `resolveLocale` picks the best match from the browser's preference list against the locales we
 * actually ship; listing `fr` first makes it the fallback for anything unsupported, which is what
 * the venues this is built for expect. The `<html lang>` attribute set by the Blade shell is
 * offered as the preferred value so a server-side locale choice wins over the browser's.
 */
const AVAILABLE: readonly Locale[] = ['fr', 'en', 'ar'];
const locale = resolveLocale(document.documentElement.lang || 'fr', AVAILABLE);

void createInertiaApp({
    title: (title) => (title ? `${title} — ${APP_NAME}` : APP_NAME),

    resolve: (name) =>
        resolvePageComponent(
            `./pages/${name}.tsx`,
            import.meta.glob<{ default: unknown }>('./pages/**/*.tsx'),
        ),

    setup({ el, App, props }) {
        createRoot(el).render(
            <StrictMode>
                <I18nProvider locale={locale}>
                    <ToastProvider>
                        <ErrorBoundary resetKey={props.initialPage.component}>
                            <App {...props} />
                        </ErrorBoundary>
                    </ToastProvider>
                </I18nProvider>
            </StrictMode>,
        );
    },

    // The top progress bar: these are ordinary round trips, and a settings save that will
    // invalidate the cache of forty tills deserves a visible one.
    progress: {
        color: '#2563eb',
        delay: 200,
        showSpinner: false,
    },
});
