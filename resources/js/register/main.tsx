import { I18nProvider } from '@shared/i18n';
import { registerServiceWorker } from '@shared/pwa/register-sw';
import { ErrorBoundary, ToastProvider } from '@shared/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { boot } from './boot';

/**
 * Register PWA entry point (`/pos/{config}`).
 *
 * The shell is **propless** — it renders identically for every user and tenant so the service
 * worker can precache the document. Everything the register knows comes from IndexedDB and the
 * bootstrap API, keyed by the device token; the `{config}` path segment is a hint for this client
 * only and is never trusted.
 *
 * React mounts before `boot()` resolves on purpose: the boot store drives a splash while the local
 * replica loads, and the network is consulted only after the first paint (spec 03 §3.3).
 */

const container = document.getElementById('root') ?? document.body;

createRoot(container).render(
    <StrictMode>
        <I18nProvider locale="fr">
            <ToastProvider>
                <ErrorBoundary>
                    <App />
                </ErrorBoundary>
            </ToastProvider>
        </I18nProvider>
    </StrictMode>,
);

void boot();
void registerServiceWorker({ scope: '/pos/' });
