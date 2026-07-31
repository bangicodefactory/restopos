import { createContext, createElement, useCallback, useContext, useMemo, type JSX, type ReactNode } from 'react';

import { DICTIONARIES, RTL_LOCALES, en, type Dictionary, type Locale, type TranslationKey } from './dictionaries';

/**
 * Translation.
 *
 * ~60 lines instead of an i18n framework, because the requirements really are this small: three
 * locales, flat keys, `{placeholder}` interpolation, and RTL. What a framework would add — lazy
 * namespace loading, ICU plurals, a translation-management integration — costs bundle size on the
 * cold-boot path of an offline app and buys nothing a restaurant POS needs.
 *
 * The receipt is a special case worth stating: it is printed in the **customer's** language, not
 * the cashier's, so `t` is not the right tool there. Receipt labels are passed explicitly through
 * `ReceiptConfigView.labels` (see `@domain/receipt`).
 */

export type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

export type I18n = {
    locale: Locale;
    rtl: boolean;
    t: Translate;
};

function interpolate(template: string, params?: Record<string, string | number>): string {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, key: string) =>
        key in params ? String(params[key]) : match,
    );
}

export function createTranslator(locale: Locale): Translate {
    const dictionary: Dictionary = DICTIONARIES[locale] ?? en;
    return (key, params) => {
        // Fall back to English, then to the key itself — a visible key beats a blank button.
        const template = dictionary[key] ?? en[key] ?? key;
        return interpolate(template, params);
    };
}

export function isRtl(locale: Locale): boolean {
    return RTL_LOCALES.has(locale);
}

/** Pick the best supported locale from the browser's preference list. */
export function resolveLocale(preferred?: string | null, available: readonly Locale[] = ['en', 'fr', 'ar']): Locale {
    const candidates = [preferred, ...(globalThis.navigator?.languages ?? [])].filter(
        (value): value is string => typeof value === 'string' && value !== '',
    );

    for (const candidate of candidates) {
        const base = candidate.toLowerCase().split('-')[0] as Locale;
        if (available.includes(base)) return base;
    }
    return available[0] ?? 'en';
}

const I18nContext = createContext<I18n>({ locale: 'en', rtl: false, t: createTranslator('en') });

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }): JSX.Element {
    const value = useMemo<I18n>(
        () => ({ locale, rtl: isRtl(locale), t: createTranslator(locale) }),
        [locale],
    );

    // Set `dir`/`lang` on the document so Tailwind's logical properties (ps-/pe-/ms-/me-) flip.
    if (typeof globalThis.document !== 'undefined') {
        globalThis.document.documentElement.lang = locale;
        globalThis.document.documentElement.dir = value.rtl ? 'rtl' : 'ltr';
    }

    return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(): I18n {
    return useContext(I18nContext);
}

/** `const t = useT(); t('status.pending', { count: 3 })` */
export function useT(): Translate {
    const { t } = useI18n();
    return useCallback<Translate>((key, params) => t(key, params), [t]);
}

export { DICTIONARIES, RTL_LOCALES, ar, en, fr } from './dictionaries';
export type { Dictionary, Locale, TranslationKey } from './dictionaries';
