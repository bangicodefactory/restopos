import { Button, cn } from '@shared/ui';
import type { JSX } from 'react';

import { LanguageSwitch } from './Brand';
import { useT, type Locale } from '../i18n';
import type { Catalog, MenuPreset } from '../catalog';
import { availablePresets, canOrder, isConsultation, isKiosk } from '../logic/availability';
import type { SelfOrderConfig, SelfOrderTable } from '../types';

/**
 * The entry screen (SLF-020, SLF-021, SLF-015).
 *
 * One component, three very different pages, because the difference is entirely in the venue's
 * configuration and not in the code:
 *
 *   - **consultation** — branding, a language switch, "view the menu". No cart, ever, and the API
 *     would refuse one anyway (SLF-002): the missing button is a courtesy, not the control.
 *   - **mobile** — the same, plus the scanned table for the customer to confirm. Confirming a table
 *     matters: a QR card walks from table 4 to table 7 in every restaurant on earth.
 *   - **kiosk** — a full-bleed attract screen the size of the whole display, then the service-mode
 *     choice, because that is the first thing a counter needs to know.
 */

export type LandingProps = {
    config: SelfOrderConfig;
    catalog: Catalog;
    table: SelfOrderTable | null;
    locale: Locale;
    hasOrders: boolean;
    onLocale: (locale: Locale) => void;
    onStart: () => void;
    onBrowse: () => void;
    onHistory: () => void;
};

export function Landing(props: LandingProps): JSX.Element {
    const t = useT();
    const { config, table } = props;
    const ordering = canOrder(config);
    const kiosk = isKiosk(config);

    return (
        <div
            className={cn(
                'flex min-h-full flex-col items-center justify-center gap-6 px-6 py-10 text-center',
                'bg-gradient-to-b from-brand-600 to-brand-800 text-white',
            )}
        >
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
                <p className="text-lg font-semibold uppercase tracking-[0.2em] opacity-80">
                    {t('so.landing.welcome')}
                </p>
                <h1 className={cn('font-black leading-tight', kiosk ? 'text-6xl' : 'text-4xl')}>
                    {config.brand_name ?? props.catalog.configName}
                </h1>

                {table && (
                    <p className="rounded-full bg-white/15 px-5 py-2 text-xl font-bold">
                        {t('so.landing.table', { name: String(table.name ?? table.table_number) })}
                    </p>
                )}

                {!config.ordering_open && (
                    <div className="mt-2 rounded-pos bg-black/25 px-5 py-3">
                        <p className="text-2xl font-bold">{t('so.landing.closed')}</p>
                        <p className="text-lg opacity-90">{t('so.landing.closedHint')}</p>
                    </div>
                )}

                {isConsultation(config) && (
                    <p className="mt-2 max-w-sm text-lg opacity-90">{t('so.landing.consultation')}</p>
                )}
            </div>

            <div className="flex w-full max-w-sm flex-col gap-3">
                {ordering ? (
                    <Button size="xl" block onClick={props.onStart} className="bg-white !text-brand-800">
                        {t('so.landing.start')}
                    </Button>
                ) : (
                    <Button size="xl" block onClick={props.onBrowse} className="bg-white !text-brand-800">
                        {t('so.landing.browse')}
                    </Button>
                )}

                {ordering && (
                    <Button variant="ghost" size="lg" block onClick={props.onBrowse} className="!text-white">
                        {t('so.landing.browse')}
                    </Button>
                )}

                {props.hasOrders && (
                    <Button variant="ghost" size="lg" block onClick={props.onHistory} className="!text-white">
                        {t('so.landing.myOrders')}
                    </Button>
                )}

                {config.custom_links.map((link) => (
                    <a
                        key={link.id}
                        href={link.url}
                        target={link.open_in_new_tab ? '_blank' : undefined}
                        rel="noreferrer noopener"
                        className="min-h-touch-lg flex items-center justify-center rounded-pos bg-white/15 px-4 text-lg font-bold text-white"
                    >
                        {link.name}
                    </a>
                ))}
            </div>

            <LanguageSwitch locale={props.locale} onChange={props.onLocale} className="pb-2" />
        </div>
    );
}

/**
 * Service-mode choice (SLF-021).
 *
 * On mobile without a scanned table the `service_at = table` presets are filtered out upstream by
 * `availablePresets` — offering "eat in at table 4" to somebody who never scanned table 4 produces
 * an order nobody can deliver.
 */
export function PresetPicker({
    catalog,
    config,
    hasTable,
    selected,
    onSelect,
    onBack,
}: {
    catalog: Catalog;
    config: SelfOrderConfig;
    hasTable: boolean;
    selected: number | null;
    onSelect: (preset: MenuPreset) => void;
    onBack: () => void;
}): JSX.Element {
    const t = useT();
    const presets = availablePresets(catalog, config, hasTable);

    return (
        <div className="flex min-h-full flex-col justify-center gap-6 bg-slate-50 px-6 py-10">
            <h1 className="text-center text-3xl font-black">{t('so.mode.choose')}</h1>
            <div className="mx-auto grid w-full max-w-md gap-3">
                {presets.map((preset) => (
                    <button
                        key={preset.id}
                        type="button"
                        onClick={() => onSelect(preset)}
                        aria-pressed={selected === preset.id}
                        className={cn(
                            'min-h-touch-xl rounded-pos-lg px-6 py-6 text-2xl font-bold shadow-pos ring-1 ring-inset',
                            selected === preset.id
                                ? 'bg-brand-600 text-white ring-brand-600'
                                : 'bg-white text-slate-900 ring-slate-200',
                        )}
                    >
                        {preset.name}
                    </button>
                ))}

                {presets.length === 0 && (
                    <>
                        <PresetFallback label={t('so.mode.eatIn')} onClick={() => onSelect(EAT_IN)} />
                        <PresetFallback label={t('so.mode.takeAway')} onClick={() => onSelect(TAKE_AWAY)} />
                    </>
                )}
            </div>
            <Button variant="ghost" size="lg" onClick={onBack} className="mx-auto">
                {t('common.back')}
            </Button>
        </div>
    );
}

/**
 * A venue with no presets configured still has to answer "here or to go?" for the kitchen ticket.
 * These two carry no preset id, so the server applies its default — which is the correct
 * behaviour, not a guess.
 */
const EAT_IN: MenuPreset = { id: 0, name: 'eat-in', serviceAt: 'table', identification: 'none', sequence: 0 };
const TAKE_AWAY: MenuPreset = { id: 0, name: 'take-away', serviceAt: 'counter', identification: 'none', sequence: 1 };

function PresetFallback({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
    return (
        <button
            type="button"
            onClick={onClick}
            className="min-h-touch-xl rounded-pos-lg bg-white px-6 py-6 text-2xl font-bold shadow-pos ring-1 ring-inset ring-slate-200"
        >
            {label}
        </button>
    );
}
