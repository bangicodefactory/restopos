import { cn } from '@shared/ui';
import type { JSX, ReactNode } from 'react';

import { SUPPORTED_LOCALES, useKdsI18n, useT, type Locale } from '../i18n';
import { nextLayout, type BoardFilter, type BoardLayout } from '../logic/board';
import { formatElapsed, type StationSummary } from '../logic/elapsed';
import type { KitchenOrder } from '../types';

/**
 * The furniture around the board: the summary bar (KDS-022), the filter row (KDS-012) and the
 * recall bar (KDS-021).
 *
 * All of it is one strip at the top and one at the bottom, because a wall screen's vertical space
 * belongs to the tickets. Every control is ≥ 44 px and labelled — a KDS is operated with the back
 * of a knuckle.
 */

/** The dictionary key naming each layout, so the toggle stays exhaustive as layouts are added. */
const LAYOUT_KEY: Record<BoardLayout, 'kds.board.layoutColumns' | 'kds.board.layoutList' | 'kds.board.layoutGrid'> = {
    columns: 'kds.board.layoutColumns',
    list: 'kds.board.layoutList',
    grid: 'kds.board.layoutGrid',
};

export type SummaryBarProps = {
    displayName: string;
    summary: StationSummary;
    queued: number;
    online: boolean;
    realtime: 'connected' | 'degraded' | 'off';
    muted: boolean;
    layout: BoardLayout;
    locale: Locale;
    onToggleMute: () => void;
    onToggleLayout: () => void;
    onChangeLocale: (locale: Locale) => void;
    onChangeDisplay: () => void;
};

export function SummaryBar(props: SummaryBarProps): JSX.Element {
    const t = useT();
    const { summary } = props;

    return (
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-kitchen-border bg-kitchen-surface px-3 py-2">
            <h1 className="me-2 truncate text-2xl font-black">{props.displayName}</h1>

            <Metric label={t('kds.summary.open')} value={String(summary.openCount)} />
            <Metric label={t('kds.summary.oldest')} value={formatElapsed(summary.oldestSeconds)} />
            <Metric label={t('kds.summary.average')} value={formatElapsed(summary.averageSeconds)} />
            <Metric
                label={t('kds.summary.late')}
                value={String(summary.lateCount)}
                tone={summary.lateCount > 0 ? 'late' : 'normal'}
            />

            <div className="ms-auto flex items-center gap-2">
                <ConnectionPill online={props.online} realtime={props.realtime} queued={props.queued} />

                <select
                    aria-label="Language"
                    value={props.locale}
                    onChange={(event) => props.onChangeLocale(event.target.value as Locale)}
                    className="min-h-touch rounded-pos bg-kitchen-raised px-2 text-lg font-bold text-kitchen-text ring-1 ring-inset ring-kitchen-border"
                >
                    {SUPPORTED_LOCALES.map((locale) => (
                        <option key={locale} value={locale}>
                            {locale.toUpperCase()}
                        </option>
                    ))}
                </select>

                {/*
                 * The button names the layout it will switch *to*, and there are three of them now
                 * (KDS-013). Two hard-coded labels in a ternary is what left `grid` with no way of
                 * being reached from the screen even once the board could render it.
                 */}
                <ChromeButton onClick={props.onToggleLayout} label={t(LAYOUT_KEY[nextLayout(props.layout)])}>
                    {t(LAYOUT_KEY[nextLayout(props.layout)])}
                </ChromeButton>

                <ChromeButton
                    onClick={props.onToggleMute}
                    label={props.muted ? t('kds.summary.unmute') : t('kds.summary.mute')}
                    active={props.muted}
                >
                    {props.muted ? '🔇' : '🔔'}
                </ChromeButton>

                <ChromeButton onClick={props.onChangeDisplay} label={t('kds.display.change')}>
                    ⚙
                </ChromeButton>
            </div>
        </header>
    );
}

function Metric({
    label,
    value,
    tone = 'normal',
}: {
    label: string;
    value: string;
    tone?: 'normal' | 'late';
}): JSX.Element {
    return (
        <div className="flex flex-col leading-none">
            <span className="text-base font-semibold uppercase tracking-wide text-kitchen-muted">{label}</span>
            <span
                className={cn(
                    'font-mono text-2xl font-black tabular-nums',
                    tone === 'late' ? 'text-kitchen-late' : 'text-kitchen-text',
                )}
            >
                {value}
            </span>
        </div>
    );
}

function ConnectionPill({
    online,
    realtime,
    queued,
}: {
    online: boolean;
    realtime: 'connected' | 'degraded' | 'off';
    queued: number;
}): JSX.Element {
    const t = useT();
    const label = !online
        ? t('kds.net.offline')
        : realtime === 'connected'
          ? t('kds.net.live')
          : t('kds.net.polling');

    return (
        <span
            className={cn(
                'inline-flex min-h-touch items-center gap-2 rounded-pos px-3 text-lg font-bold ring-1 ring-inset',
                !online
                    ? 'bg-kitchen-late/20 text-kitchen-late ring-kitchen-late/50'
                    : realtime === 'connected'
                      ? 'bg-kitchen-ready/15 text-kitchen-ready ring-kitchen-ready/40'
                      : 'bg-kitchen-cooking/15 text-kitchen-cooking ring-kitchen-cooking/40',
            )}
        >
            <span aria-hidden="true">●</span>
            {label}
            {queued > 0 && (
                <span className="rounded bg-kitchen-raised px-2 text-base tabular-nums">
                    {t('kds.summary.queued', { count: queued })}
                </span>
            )}
        </span>
    );
}

function ChromeButton({
    onClick,
    label,
    active,
    children,
}: {
    onClick: () => void;
    label: string;
    active?: boolean;
    children: JSX.Element | string;
}): JSX.Element {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            title={label}
            className={cn(
                'min-h-touch min-w-touch rounded-pos px-3 text-lg font-bold ring-1 ring-inset ring-kitchen-border active:brightness-125',
                active ? 'bg-kitchen-late/25 text-kitchen-late' : 'bg-kitchen-raised text-kitchen-text',
            )}
        >
            {children}
        </button>
    );
}

// ─────────────────────────────────────────────────────────────────────────────

export type FilterBarProps = {
    categories: Array<{ id: number; name: string }>;
    courses: number[];
    /** Service modes present on the board right now — "Takeaway", "Delivery" (KDS-012). */
    presets: string[];
    filter: BoardFilter;
    onChange: (patch: Partial<BoardFilter>) => void;
};

export function FilterBar({ categories, courses, presets, filter, onChange }: FilterBarProps): JSX.Element | null {
    const t = useT();
    const hasFilters =
        filter.categoryIds.length > 0 || filter.lateOnly || filter.courseIndex !== null || filter.presets.length > 0;
    if (categories.length === 0 && courses.length === 0 && presets.length === 0) return null;

    const toggleCategory = (id: number): void => {
        const next = filter.categoryIds.includes(id)
            ? filter.categoryIds.filter((value) => value !== id)
            : [...filter.categoryIds, id];
        onChange({ categoryIds: next });
    };

    return (
        <div className="pos-scroll flex items-center gap-2 border-b border-kitchen-border bg-kitchen-bg px-3 py-2">
            <Chip
                active={!hasFilters}
                onClick={() => onChange({ categoryIds: [], lateOnly: false, courseIndex: null, presets: [] })}
            >
                {t('kds.filter.all')}
            </Chip>

            {categories.map((category) => (
                <Chip
                    key={category.id}
                    active={filter.categoryIds.includes(category.id)}
                    onClick={() => toggleCategory(category.id)}
                >
                    {category.name}
                </Chip>
            ))}

            {courses.map((index) => (
                <Chip
                    key={`course-${index}`}
                    active={filter.courseIndex === index}
                    onClick={() => onChange({ courseIndex: filter.courseIndex === index ? null : index })}
                >
                    {t('kds.filter.course')} {index}
                </Chip>
            ))}

            {presets.map((preset) => (
                <Chip
                    key={`preset-${preset}`}
                    active={filter.presets.includes(preset)}
                    onClick={() =>
                        onChange({
                            presets: filter.presets.includes(preset)
                                ? filter.presets.filter((value) => value !== preset)
                                : [...filter.presets, preset],
                        })
                    }
                >
                    {preset}
                </Chip>
            ))}

            <Chip active={filter.lateOnly} tone="late" onClick={() => onChange({ lateOnly: !filter.lateOnly })}>
                {t('kds.filter.lateOnly')}
            </Chip>
        </div>
    );
}

function Chip({
    active,
    tone = 'normal',
    onClick,
    children,
}: {
    active: boolean;
    tone?: 'normal' | 'late';
    onClick: () => void;
    children: ReactNode;
}): JSX.Element {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                'min-h-touch shrink-0 whitespace-nowrap rounded-full px-4 text-lg font-bold ring-1 ring-inset active:brightness-125',
                active
                    ? tone === 'late'
                        ? 'bg-kitchen-late text-white ring-kitchen-late'
                        : 'bg-kitchen-new text-kitchen-bg ring-kitchen-new'
                    : 'bg-kitchen-surface text-kitchen-muted ring-kitchen-border',
            )}
        >
            {children}
        </button>
    );
}

// ─────────────────────────────────────────────────────────────────────────────

export type RecallBarProps = {
    orders: readonly KitchenOrder[];
    onRecall: (orderId: number) => void;
};

/**
 * Recently completed tickets, most recent first (KDS-021).
 *
 * Collapsed to a strip of tracking numbers rather than full cards: the recall bar is a safety net,
 * not a second board, and it must not compete for the space the working tickets need. One tap
 * brings a card back — the mistake somebody is running back to fix is always the last one bumped.
 */
export function RecallBar({ orders, onRecall }: RecallBarProps): JSX.Element | null {
    const t = useT();
    if (orders.length === 0) return null;

    return (
        <footer className="border-t border-kitchen-border bg-kitchen-surface">
            <div className="flex items-center gap-2 px-3 pt-2">
                <h2 className="text-base font-bold uppercase tracking-wide text-kitchen-muted">
                    {t('kds.board.recallBar')}
                </h2>
                <span className="text-base text-kitchen-muted/70">{t('kds.board.recallHint')}</span>
            </div>
            <div className="pos-scroll flex gap-2 px-3 pb-2 pt-1">
                {orders.slice(0, 12).map((order) => (
                    <button
                        key={order.id}
                        type="button"
                        onClick={() => onRecall(order.id)}
                        className="min-h-touch shrink-0 rounded-pos bg-kitchen-raised px-4 text-xl font-black tabular-nums text-kitchen-served ring-1 ring-inset ring-kitchen-border active:brightness-125"
                        aria-label={`${t('kds.board.recall')} ${order.tracking_number ?? order.id}`}
                    >
                        {order.tracking_number ?? `#${order.id}`}
                        {order.table_label && (
                            <span className="ms-2 text-base font-semibold text-kitchen-muted">
                                {order.table_label}
                            </span>
                        )}
                    </button>
                ))}
            </div>
        </footer>
    );
}

/** Locale switcher used by the pairing/picker screens, which have no summary bar. */
export function LocaleSwitch({ onChange }: { onChange: (locale: Locale) => void }): JSX.Element {
    const { locale } = useKdsI18n();
    return (
        <div className="flex gap-2">
            {SUPPORTED_LOCALES.map((value) => (
                <button
                    key={value}
                    type="button"
                    onClick={() => onChange(value)}
                    aria-pressed={value === locale}
                    className={cn(
                        'min-h-touch min-w-touch rounded-pos px-3 text-lg font-bold ring-1 ring-inset ring-kitchen-border',
                        value === locale ? 'bg-kitchen-new text-kitchen-bg' : 'bg-kitchen-raised text-kitchen-text',
                    )}
                >
                    {value.toUpperCase()}
                </button>
            ))}
        </div>
    );
}
