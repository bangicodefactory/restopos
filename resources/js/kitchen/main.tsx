import { registerServiceWorker } from '@shared/pwa/register-sw';
import { ErrorBoundary, ToastProvider } from '@shared/ui';
import { StrictMode, useEffect, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { KitchenI18nProvider, SUPPORTED_LOCALES, resolveLocale, type Locale } from './i18n';
import { useKitchenStore } from './store';

/**
 * Kitchen display entry point — `/kitchen/{display}`, mounted from the propless
 * `resources/views/kitchen.blade.php`.
 *
 * The shell carries no props by contract (spec §13): it is byte-identical for every venue so the
 * service worker can precache the document. Everything the screen knows comes from IndexedDB and
 * from `/api/kitchen/*`. The `{display}` path segment is a *hint* used to pre-select a screen after
 * pairing; it is never trusted, exactly as the register never trusts its `{config}` segment.
 */

/** `/kitchen/{token}` → `token`, or `null` for a bare `/kitchen`. */
function displayHintFromUrl(): string | null {
    const segments = (globalThis.location?.pathname ?? '').split('/').filter(Boolean);
    if (segments[0] !== 'kitchen') return null;
    const hint = segments[1];
    return hint !== undefined && hint.length >= 8 ? hint : null;
}

function Root(): JSX.Element {
    const storedLocale = useKitchenStore((state) => state.prefs.locale);
    const phase = useKitchenStore((state) => state.phase);
    const display = useKitchenStore((state) => state.display);
    const chooseDisplay = useKitchenStore((state) => state.chooseDisplay);
    const [hintApplied, setHintApplied] = useState(false);

    const locale: Locale = storedLocale ?? resolveLocale(null, SUPPORTED_LOCALES);

    /**
     * Adopt the URL hint once, and only when the operator has not already chosen a screen. A wall
     * display is opened from a bookmark that carries its token; re-reading it on every render would
     * fight the picker.
     */
    useEffect(() => {
        if (hintApplied || phase !== 'choosing' || display) return;
        const hint = displayHintFromUrl();
        if (hint === null) return;
        setHintApplied(true);
        void chooseDisplay({ token: hint, id: null, name: hint });
    }, [hintApplied, phase, display, chooseDisplay]);

    return (
        <KitchenI18nProvider locale={locale}>
            <ToastProvider>
                <ErrorBoundary>
                    <App />
                </ErrorBoundary>
            </ToastProvider>
        </KitchenI18nProvider>
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

// Own PWA scope: updating the register must never invalidate the kitchen's cache.
void registerServiceWorker({ scope: '/kitchen/' });
