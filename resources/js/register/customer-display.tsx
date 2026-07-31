import { formatMoney } from '@domain/receipt/index';
import { I18nProvider } from '@shared/i18n';
import { registerServiceWorker } from '@shared/pwa/register-sw';
import { ErrorBoundary } from '@shared/ui';
import type { JSX } from 'react';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { subscribeDisplay, type DisplayPayload } from './domain/customer-display-bus';
import { useT } from './i18n';

/**
 * The customer-facing display (`/pos/{config}/display`, REG-350 … REG-354).
 *
 * Driven by `BroadcastChannel` from the register on the same machine, which is the common wiring
 * (a second monitor) and — critically — **works with the network off**. A customer display that
 * blanks when the venue Wi-Fi hiccups is a display the staff stop trusting, so the offline-capable
 * transport is the default rather than the fallback.
 *
 * Deliberately dumb: it renders whatever payload it last received and nothing else. No database, no
 * device token, no ability to mutate an order — it is a screen strangers can see.
 */

function Display(): JSX.Element {
    const t = useT();
    const [payload, setPayload] = useState<DisplayPayload | null>(null);

    useEffect(() => subscribeDisplay(setPayload), []);

    if (payload === null || payload.kind === 'idle') {
        return (
            <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-slate-900 text-white">
                <h1 className="text-5xl font-bold">{payload?.venue ?? 'RestoPOS'}</h1>
                <p className="text-2xl opacity-80">{t('reg.display.welcome')}</p>
            </main>
        );
    }

    if (payload.kind === 'paid') {
        return (
            <main className="flex h-dvh flex-col items-center justify-center gap-6 bg-ok text-white">
                <p className="text-3xl">{t('reg.display.thanks')}</p>
                <p className="text-[6rem] font-bold leading-none tabular-nums">{payload.total}</p>
                <p className="text-2xl">
                    {t('reg.display.change')}: {payload.change}
                </p>
            </main>
        );
    }

    const money = (value: string): string => formatMoney(value, payload.currency);

    return (
        <main className="flex h-dvh flex-col bg-slate-900 text-white">
            <header className="border-b border-white/10 px-8 py-4 text-2xl font-semibold">
                {payload.venue ?? 'RestoPOS'}
            </header>

            <ul className="min-h-0 flex-1 overflow-auto px-8 py-4 text-2xl">
                {payload.lines.map((line, index) => (
                    <li key={`${line.name}-${index}`} className="flex items-baseline gap-4 border-b border-white/5 py-2">
                        <span className="w-16 shrink-0 tabular-nums opacity-70">{line.quantity}</span>
                        <span className="min-w-0 flex-1">
                            {line.name}
                            {line.note ? <span className="block text-lg italic opacity-70">{line.note}</span> : null}
                        </span>
                        <span className="tabular-nums">{money(line.total)}</span>
                    </li>
                ))}
            </ul>

            <footer className="border-t border-white/10 px-8 py-6">
                <div className="flex items-baseline justify-between">
                    <span className="text-3xl">{t('reg.display.total')}</span>
                    <span className="text-[4rem] font-bold leading-none tabular-nums">{money(payload.total)}</span>
                </div>
                <div className="mt-2 flex justify-between text-xl opacity-80">
                    <span>
                        {t('reg.display.paid')}: {money(payload.paid)}
                    </span>
                    <span>
                        {t('reg.display.due')}: {money(payload.due)}
                    </span>
                </div>
            </footer>
        </main>
    );
}

createRoot(document.getElementById('root') ?? document.body).render(
    <StrictMode>
        <I18nProvider locale="fr">
            <ErrorBoundary>
                <Display />
            </ErrorBoundary>
        </I18nProvider>
    </StrictMode>,
);

void registerServiceWorker({ scope: '/pos/' });
