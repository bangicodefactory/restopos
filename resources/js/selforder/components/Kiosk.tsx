import { useIdle } from '@shared/store';
import { Button, ConfirmDialog } from '@shared/ui';
import { useEffect, useState, type JSX } from 'react';

import { LanguageSwitch } from './Brand';
import { useT, type Locale } from '../i18n';
import type { SelfOrderConfig } from '../types';

/**
 * Kiosk-only behaviour (SLF-004, SLF-090, SLF-094).
 *
 * A kiosk is not a big phone. It is an unattended terminal in a public space, and the two things it
 * must never do are (a) show the previous customer's basket and (b) sit on a half-finished order
 * forever. Hence a hard idle timeout with a visible countdown, and a full reset — cart, language,
 * service mode — when it expires.
 *
 * The countdown is deliberately loud and cancellable: a customer reading the menu carefully is not
 * an abandoned session, and silently wiping their basket is worse than asking.
 */

export function useKioskIdle({
    enabled,
    idleSeconds,
    confirmSeconds,
    onReset,
}: {
    enabled: boolean;
    idleSeconds: number;
    confirmSeconds: number;
    onReset: () => void;
}): { warning: boolean; remaining: number; stay: () => void } {
    const [warning, setWarning] = useState(false);
    const [remaining, setRemaining] = useState(confirmSeconds);

    const idle = useIdle({
        timeoutMs: Math.max(10, idleSeconds) * 1000,
        enabled,
        onIdle: () => setWarning(true),
    });

    useEffect(() => {
        if (!warning) {
            setRemaining(confirmSeconds);
            return;
        }
        const timer = setInterval(() => {
            setRemaining((value) => {
                if (value <= 1) {
                    clearInterval(timer);
                    setWarning(false);
                    onReset();
                    return confirmSeconds;
                }
                return value - 1;
            });
        }, 1000);
        return () => clearInterval(timer);
    }, [warning, confirmSeconds, onReset]);

    return {
        warning,
        remaining,
        stay: () => {
            setWarning(false);
            idle.reset();
        },
    };
}

export function IdleDialog({
    open,
    remaining,
    onStay,
    onReset,
}: {
    open: boolean;
    remaining: number;
    onStay: () => void;
    onReset: () => void;
}): JSX.Element {
    const t = useT();
    return (
        <ConfirmDialog
            open={open}
            onClose={onStay}
            onConfirm={onReset}
            title={t('so.kiosk.idleTitle')}
            message={t('so.kiosk.idleBody', { seconds: remaining })}
            confirmLabel={t('so.kiosk.startOver')}
            cancelLabel={t('so.kiosk.continue')}
        />
    );
}

/**
 * The attract screen (SLF-098).
 *
 * Full-bleed branding, one instruction, one enormous target. It exists so an idle kiosk reads as
 * "touch me" from across the room rather than as a website nobody is using.
 */
export function AttractScreen({
    config,
    locale,
    onLocale,
    onStart,
}: {
    config: SelfOrderConfig;
    locale: Locale;
    onLocale: (locale: Locale) => void;
    onStart: () => void;
}): JSX.Element {
    const t = useT();
    return (
        <button
            type="button"
            onClick={onStart}
            className="flex min-h-full w-full flex-col items-center justify-center gap-10 bg-gradient-to-b from-brand-600 to-brand-900 px-8 py-16 text-center text-white"
        >
            <span className="text-5xl font-black">{config.brand_name ?? ''}</span>
            <span className="animate-pulse-sync rounded-full bg-white/20 px-12 py-8 text-4xl font-black">
                {t('so.kiosk.tapToStart')}
            </span>
            <span
                // The language switch is inside a button, so stop the tap from also starting.
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                role="presentation"
            >
                <LanguageSwitch locale={locale} onChange={onLocale} />
            </span>
        </button>
    );
}

// ─────────────────────────────────────────────────────────────────────────────

type InstallPromptEvent = Event & { prompt: () => Promise<void> };

/**
 * The PWA install prompt (SLF-014), mobile only.
 *
 * Deliberately not shown on a kiosk (already installed, and a customer must never be offered a
 * browser dialog) and not shown until the customer has done something — offering "add to home
 * screen" to somebody who has not yet decided to order is how a prompt gets permanently dismissed.
 */
export function InstallPrompt({
    eligible,
    onDismiss,
}: {
    eligible: boolean;
    onDismiss: () => void;
}): JSX.Element | null {
    const t = useT();
    const [event, setEvent] = useState<InstallPromptEvent | null>(null);

    useEffect(() => {
        const handler = (raw: Event): void => {
            raw.preventDefault();
            setEvent(raw as InstallPromptEvent);
        };
        globalThis.addEventListener?.('beforeinstallprompt', handler);
        return () => globalThis.removeEventListener?.('beforeinstallprompt', handler);
    }, []);

    if (!eligible || !event) return null;

    return (
        <div className="pos-safe-bottom fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-slate-200 bg-white px-3 py-3 shadow-pos-lg">
            <p className="flex-1 text-base font-semibold">{t('so.pwa.install')}</p>
            <Button
                size="md"
                onClick={() => {
                    void event.prompt();
                    setEvent(null);
                    onDismiss();
                }}
            >
                {t('so.pwa.install')}
            </Button>
            <Button
                variant="ghost"
                size="md"
                onClick={() => {
                    setEvent(null);
                    onDismiss();
                }}
            >
                {t('so.pwa.dismiss')}
            </Button>
        </div>
    );
}
