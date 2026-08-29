import { formatMoney } from '@domain/receipt/index';
import { I18nProvider } from '@shared/i18n';
import { registerServiceWorker } from '@shared/pwa/register-sw';
import { useEcho } from '@shared/store';
import { ErrorBoundary } from '@shared/ui';
import type { CSSProperties, JSX } from 'react';
import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { DISPLAY_EVENT, createFrameGate, displayChannel, displayConfigIdFromUrl, displayTokenFromUrl, readDisplayBroadcast, subscribeDisplay, type DisplayPayload } from './domain/customer-display-bus';
import { useT } from './i18n';
import { publicReverbConfig } from './realtime';

/**
 * The customer-facing display (`/pos/{config}/display`, REG-350 … REG-354).
 *
 * Two transports, and the order between them is deliberate.
 *
 *   1. **`BroadcastChannel`** — the second monitor on the same machine, the common wiring, and
 *      critically it **works with the network off**. A display that blanks when the venue Wi-Fi
 *      hiccups is a display the staff stop trusting.
 *   2. **Reverb** (REG-352) — a display on a *separate device*, which is the normal restaurant
 *      setup and which the first transport cannot reach at all. Enabled only when the URL carries
 *      the capability token the register's pairing dialog puts there.
 *
 * Both feed the same `payload` state and the later frame wins, so a display that has both wired
 * simply gets whichever arrives first. There is no merge and no ordering problem: each frame is a
 * whole picture of the screen, not a delta.
 *
 * Still deliberately dumb: no database, no device token, no ability to mutate an order — it is a
 * screen strangers can see. What it gained in BAN-443a is an *identity* (the token in its URL), and
 * that is all: enough to name one channel and fetch one background image, and nothing that would
 * let it read a catalogue or write a sale.
 */

type Branding = { venue: string | null; background: string | null };

/** The venue name and background for this config, or nulls when there is no token to ask with. */
async function loadBranding(configId: number, token: string): Promise<Branding> {
    const response = await fetch(`/api/pos/customer-display/${configId}?token=${encodeURIComponent(token)}`, {
        headers: { Accept: 'application/json' },
    });

    if (!response.ok) return { venue: null, background: null };

    const body: unknown = await response.json();
    const data = (body as { data?: Record<string, unknown> }).data ?? {};

    return {
        venue: typeof data['venue'] === 'string' ? data['venue'] : null,
        background: typeof data['background'] === 'string' ? data['background'] : null,
    };
}

function Display({ configId, token }: { configId: number | null; token: string | null }): JSX.Element {
    const t = useT();
    const [payload, setPayload] = useState<DisplayPayload | null>(null);
    const [branding, setBranding] = useState<Branding>({ venue: null, background: null });

    // The newest frame wins, whichever leg it arrived on (BAN-443a). The reasoning, and why
    // whole frames do not make this unnecessary, is on `createFrameGate`.
    const gate = useMemo(() => createFrameGate(), []);

    const showFrame = useCallback(
        (next: DisplayPayload): void => {
            if (gate.accept(next)) setPayload(next);
        },
        [gate],
    );

    useEffect(() => subscribeDisplay(showFrame), [showFrame]);

    // REG-354 — the configured background. Fetched rather than pointed at by an `<img src>` on the
    // media route, because that route needs a bearer this screen does not have; the display's own
    // endpoint carries its capability in the URL, which is the only shape a CSS `url()` can use.
    useEffect(() => {
        if (configId === null || token === null) return;
        let live = true;
        void loadBranding(configId, token).then((next) => {
            if (live) setBranding(next);
        });
        return () => {
            live = false;
        };
    }, [configId, token]);

    // REG-352 — the remote leg. Null config (no token, or no Reverb in this deployment) makes
    // `useEcho` report `unavailable` and change nothing: `BroadcastChannel` is still running.
    const reverb = useMemo(() => (token === null ? null : publicReverbConfig()), [token]);
    const events = useMemo(
        () => ({
            [DISPLAY_EVENT]: (frame: unknown): void => {
                const next = readDisplayBroadcast(frame);
                // A frame off the network that this screen cannot render is dropped, not shown.
                // There is no replica to re-read from, so the last good picture is the best
                // available one — and rendering a malformed frame takes the screen down.
                if (next !== null) showFrame(next);
            },
        }),
        [showFrame],
    );

    useEcho({
        config: reverb,
        channel: token === null ? null : displayChannel(token),
        visibility: 'public',
        events,
    });

    const venue = payload?.venue ?? branding.venue;

    // A scrim under the text, because a venue's photograph is not a typography-safe backdrop and
    // the total is the one thing on this screen that has to be readable from across a counter.
    const backdrop: CSSProperties =
        branding.background === null
            ? {}
            : {
                  backgroundImage: `linear-gradient(rgb(15 23 42 / 0.72), rgb(15 23 42 / 0.72)), url(${JSON.stringify(branding.background)})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
              };

    if (payload === null || payload.kind === 'idle') {
        return (
            <main
                data-testid="display-idle"
                className="flex h-dvh flex-col items-center justify-center gap-4 bg-slate-900 text-white"
                style={backdrop}
            >
                <h1 className="text-5xl font-bold">{venue ?? 'RestoPOS'}</h1>
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
        <main className="flex h-dvh flex-col bg-slate-900 text-white" style={backdrop}>
            <header className="border-b border-white/10 px-8 py-4 text-2xl font-semibold">
                {venue ?? 'RestoPOS'}
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

const href = globalThis.location?.href ?? '';

createRoot(document.getElementById('root') ?? document.body).render(
    <StrictMode>
        <I18nProvider locale="fr">
            <ErrorBoundary>
                <Display configId={displayConfigIdFromUrl(href)} token={displayTokenFromUrl(href)} />
            </ErrorBoundary>
        </I18nProvider>
    </StrictMode>,
);

void registerServiceWorker({ scope: '/pos/' });
