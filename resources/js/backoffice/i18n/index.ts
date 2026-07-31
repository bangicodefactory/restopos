/**
 * The back-office translator: `@shared/i18n` plus the admin vocabulary.
 *
 * Lookup order is BO dictionary → shared dictionary → the key itself, so a shared string
 * ("common.cancel", "status.offline") keeps exactly one definition and the admin app adds only
 * what is genuinely admin-only. Locale, RTL and the provider all come from `@shared/i18n`.
 */

import { useI18n, type Locale, type TranslationKey } from '@shared/i18n';
import { useCallback } from 'react';

import { BO_DICTIONARIES, boFr, type BoKey } from './dictionary';

export type AnyKey = BoKey | TranslationKey;
export type BoTranslate = (key: AnyKey, params?: Record<string, string | number>) => string;

function interpolate(template: string, params?: Record<string, string | number>): string {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, key: string) =>
        key in params ? String(params[key]) : match,
    );
}

export function translateWith(locale: Locale, shared: (k: TranslationKey, p?: Record<string, string | number>) => string): BoTranslate {
    const dictionary = BO_DICTIONARIES[locale] ?? boFr;
    return (key, params) => {
        const template = (dictionary as Record<string, string | undefined>)[key];
        if (template === undefined) return shared(key as TranslationKey, params);
        return interpolate(template, params);
    };
}

/** `const t = useT(); t('order.detail', { name: 'Bar/00412' })` */
export function useT(): BoTranslate {
    const { locale, t } = useI18n();
    return useCallback<BoTranslate>((key, params) => translateWith(locale, t)(key, params), [locale, t]);
}

export { BO_DICTIONARIES, boEn, boFr } from './dictionary';
export type { BoDictionary, BoKey } from './dictionary';
