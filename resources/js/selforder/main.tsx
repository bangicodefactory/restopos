import { registerServiceWorker } from '@shared/pwa/register-sw';
import { ErrorBoundary, ToastProvider } from '@shared/ui';
import { StrictMode, type JSX } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { SelfOrderI18nProvider, SUPPORTED_LOCALES, resolveLocale, type Locale } from './i18n';
import { useSelfOrderStore } from './store';

/**
 * Self-order PWA entry point — `/menu/{token}`, mounted from the propless
 * `resources/views/selforder.blade.php`.
 *
 * The shell carries no props by contract (spec §13): it is byte-identical for every venue so the
 * service worker can precache the document. The `{token}` path segment is the config's self-order
 * token and the optional `?tt=` query is the table's QR capability token; both only seed `boot()`
 * and are authenticated server-side by `/api/self-order/{configToken}/*`, never trusted by the
 * client — exactly as the kitchen never trusts its `{display}` segment.
 */

/** `/menu/{token}?tt={table}` → the two capability tokens the store boots from. */
function tokensFromUrl(): { configToken: string; tableToken: string | null } {
    const segments = (globalThis.location?.pathname ?? '').split('/').filter(Boolean);
    const configToken = segments[0] === 'menu' && segments[1] !== undefined ? segments[1] : '';
    const tableToken = new URLSearchParams(globalThis.location?.search ?? '').get('tt');
    return { configToken, tableToken: tableToken !== null && tableToken.length > 0 ? tableToken : null };
}

const { configToken, tableToken } = tokensFromUrl();

function Root(): JSX.Element {
    // Locale is reactive: the in-app language switch writes `prefs.locale`, and the provider must
    // follow it so `useT()` and the RTL flip re-render. On a first visit nothing is stored yet, so
    // fall back to the browser's best match against the locales we actually ship.
    const storedLocale = useSelfOrderStore((state) => state.prefs.locale);
    const locale: Locale =
        storedLocale ?? resolveLocale(globalThis.document?.documentElement.lang || null, SUPPORTED_LOCALES);

    return (
        <SelfOrderI18nProvider locale={locale}>
            <ToastProvider>
                <ErrorBoundary>
                    <App configToken={configToken} tableToken={tableToken} />
                </ErrorBoundary>
            </ToastProvider>
        </SelfOrderI18nProvider>
    );
}

const container = globalThis.document?.getElementById('root');
if (container) {
    createRoot(container).render(
        <StrictMode>
            <Root />
        </StrictMode>,
    );
}

// Own PWA scope: a customer's phone must never precache the register or kitchen bundles.
void registerServiceWorker({ scope: '/menu/' });
