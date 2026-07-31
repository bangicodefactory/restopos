import { Money, cn } from '@shared/ui';
import { useEffect, type JSX, type ReactNode } from 'react';

import { getCatalog } from '../store';
import { LOCALE_LABELS, SUPPORTED_LOCALES, useSelfOrderI18n, type Locale } from '../i18n';
import type { SelfOrderConfig } from '../types';

/**
 * Venue branding and the pieces of chrome every screen shares.
 *
 * The brand colour is applied by writing the Tailwind theme's CSS variables at runtime — the exact
 * mechanism `resources/css/app.css` documents ("so the self-order app can re-theme at runtime from
 * the venue's branding without a rebuild"). One venue's red and another's green are the same
 * bundle.
 */

/** `#8B1E1E` → `139 30 30`, the space-separated RGB form Tailwind's `<alpha-value>` needs. */
function toRgbChannels(hex: string): string | null {
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
    if (!match) return null;
    const value = match[1] as string;
    const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
    const r = Number.parseInt(full.slice(0, 2), 16);
    const g = Number.parseInt(full.slice(2, 4), 16);
    const b = Number.parseInt(full.slice(4, 6), 16);
    return `${r} ${g} ${b}`;
}

/** Darken/lighten by mixing towards black or white — enough for a usable ramp from one colour. */
function shade(channels: string, factor: number): string {
    const [r = 0, g = 0, b = 0] = channels.split(' ').map(Number);
    const mix = (value: number): number =>
        Math.round(factor < 1 ? value * factor : value + (255 - value) * (factor - 1));
    return `${mix(r)} ${mix(g)} ${mix(b)}`;
}

export function useVenueTheme(config: SelfOrderConfig | null): void {
    useEffect(() => {
        const root = globalThis.document?.documentElement;
        if (!root || !config?.primary_color) return;
        const base = toRgbChannels(config.primary_color);
        if (!base) return;

        const ramp: Record<string, number> = {
            '--rp-brand-50': 1.9,
            '--rp-brand-100': 1.8,
            '--rp-brand-200': 1.6,
            '--rp-brand-300': 1.4,
            '--rp-brand-400': 1.2,
            '--rp-brand-500': 1.1,
            '--rp-brand-600': 1,
            '--rp-brand-700': 0.85,
            '--rp-brand-800': 0.7,
            '--rp-brand-900': 0.55,
        };
        for (const [variable, factor] of Object.entries(ramp)) {
            root.style.setProperty(variable, factor === 1 ? base : shade(base, factor));
        }
    }, [config?.primary_color]);
}

/** Money, in the venue's currency, from the catalog. Falls back gracefully before boot. */
export function Price({
    amount,
    className,
}: {
    amount: string;
    className?: string;
}): JSX.Element {
    const currency = getCatalog()?.currency;
    if (!currency) return <span className={className}>{amount}</span>;
    return <Money amount={amount} currency={currency} className={className} />;
}

export function LanguageSwitch({
    locale,
    onChange,
    className,
}: {
    locale: Locale;
    onChange: (locale: Locale) => void;
    className?: string;
}): JSX.Element {
    return (
        <div className={cn('flex gap-2', className)} role="group" aria-label="Language">
            {SUPPORTED_LOCALES.map((value) => (
                <button
                    key={value}
                    type="button"
                    onClick={() => onChange(value)}
                    aria-pressed={value === locale}
                    lang={value}
                    className={cn(
                        'min-h-touch rounded-full px-4 text-base font-bold ring-1 ring-inset',
                        value === locale
                            ? 'bg-brand-600 text-white ring-brand-600'
                            : 'bg-white text-slate-700 ring-slate-300',
                    )}
                >
                    {LOCALE_LABELS[value]}
                </button>
            ))}
        </div>
    );
}

/**
 * A product image, or a monogram.
 *
 * "No image" is a first-class state, not a broken one: most venues photograph a handful of dishes
 * and nothing else, and a grid of grey placeholders looks like a bug. The monogram is derived from
 * the name so the same dish is always the same colour.
 */
export function ProductImage({
    url,
    name,
    className,
}: {
    url: string | null;
    name: string;
    className?: string;
}): JSX.Element {
    if (url) {
        return (
            <img
                src={url}
                alt=""
                loading="lazy"
                decoding="async"
                className={cn('size-full object-cover', className)}
            />
        );
    }

    const hue = [...name].reduce((total, char) => (total + char.charCodeAt(0)) % 360, 0);
    return (
        <span
            aria-hidden="true"
            className={cn('flex size-full items-center justify-center text-3xl font-black text-white/90', className)}
            style={{ backgroundColor: `hsl(${hue} 45% 55%)` }}
        >
            {name.trim().charAt(0).toUpperCase()}
        </span>
    );
}

export function Screen({
    title,
    onBack,
    action,
    children,
    footer,
}: {
    title: ReactNode;
    onBack?: () => void;
    action?: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
}): JSX.Element {
    const { rtl } = useSelfOrderI18n();
    return (
        <div className="flex min-h-full flex-col bg-slate-50">
            <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
                {onBack && (
                    <button
                        type="button"
                        onClick={onBack}
                        aria-label="Back"
                        className="min-h-touch min-w-touch rounded-pos text-2xl text-slate-700 active:bg-slate-100"
                    >
                        {rtl ? '→' : '←'}
                    </button>
                )}
                <h1 className="min-w-0 flex-1 truncate text-xl font-bold">{title}</h1>
                {action}
            </header>
            <main className="flex-1">{children}</main>
            {footer && (
                <div className="pos-safe-bottom sticky bottom-0 z-20 border-t border-slate-200 bg-white px-3 py-3">
                    {footer}
                </div>
            )}
        </div>
    );
}

/** A non-blocking notice strip — offline, stale menu, a removed item. */
export function Notice({
    tone = 'info',
    children,
}: {
    tone?: 'info' | 'warn' | 'danger';
    children: ReactNode;
}): JSX.Element {
    return (
        <p
            role="status"
            className={cn(
                'px-3 py-2 text-center text-base font-semibold',
                tone === 'info' && 'bg-info-soft text-info-fg',
                tone === 'warn' && 'bg-warn-soft text-warn-fg',
                tone === 'danger' && 'bg-danger-soft text-danger-fg',
            )}
        >
            {children}
        </p>
    );
}
