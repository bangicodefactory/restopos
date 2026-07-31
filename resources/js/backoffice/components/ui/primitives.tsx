/**
 * Small presentational pieces the admin app repeats on every screen.
 *
 * Everything interactive comes from `@shared/ui` (Button, Dialog, Toast, MoneyInput…). What lives
 * here is layout and state-of-the-world display: cards, badges, empty states, skeletons for
 * deferred props, and the notice component used to tell an operator, honestly and in place, when
 * a screen cannot do something because the API contract does not expose it.
 */

import { cn } from '@shared/ui';
import type { JSX, ReactNode } from 'react';

// ───────────────────────────────────────────────────────────── card

export function Card({
    children,
    className,
    as: Element = 'section',
}: {
    children: ReactNode;
    className?: string;
    as?: 'section' | 'div' | 'article';
}): JSX.Element {
    return (
        <Element className={cn('rounded-pos-lg bg-white shadow-pos ring-1 ring-slate-200', className)}>
            {children}
        </Element>
    );
}

export function CardHeader({
    title,
    description,
    actions,
    id,
}: {
    title: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
    id?: string;
}): JSX.Element {
    return (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
            <div className="min-w-0">
                <h2 id={id} className="text-lg font-semibold text-slate-900">
                    {title}
                </h2>
                {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
            </div>
            {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
    );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
    return <div className={cn('px-5 py-4', className)}>{children}</div>;
}

// ───────────────────────────────────────────────────────────── badge

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'brand';

const BADGE_TONES: Record<BadgeTone, string> = {
    neutral: 'bg-slate-100 text-slate-700 ring-slate-300',
    ok: 'bg-ok-soft text-ok-fg ring-ok/30',
    warn: 'bg-warn-soft text-warn-fg ring-warn/30',
    danger: 'bg-danger-soft text-danger-fg ring-danger/30',
    info: 'bg-info-soft text-info-fg ring-info/30',
    brand: 'bg-brand-50 text-brand-800 ring-brand-300',
};

export function Badge({
    children,
    tone = 'neutral',
    className,
    title,
}: {
    children: ReactNode;
    tone?: BadgeTone;
    className?: string;
    title?: string;
}): JSX.Element {
    return (
        <span
            title={title}
            className={cn(
                'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
                BADGE_TONES[tone],
                className,
            )}
        >
            {children}
        </span>
    );
}

/** A yes/no cell that reads as well in a screen reader as it does at a glance. */
export function BoolCell({ value, labels }: { value: boolean; labels: [string, string] }): JSX.Element {
    return (
        <Badge tone={value ? 'ok' : 'neutral'}>
            <span aria-hidden>{value ? '✓' : '—'}</span>
            <span className="sr-only">{value ? labels[0] : labels[1]}</span>
        </Badge>
    );
}

// ───────────────────────────────────────────────────────────── stats

export function Stat({
    label,
    value,
    hint,
    tone = 'neutral',
    icon,
}: {
    label: ReactNode;
    value: ReactNode;
    hint?: ReactNode;
    tone?: BadgeTone;
    icon?: ReactNode;
}): JSX.Element {
    return (
        <div className="rounded-pos-lg bg-white p-4 shadow-pos ring-1 ring-slate-200">
            <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-600">{label}</span>
                {icon ? (
                    <span className={cn('rounded-full p-1 text-sm', BADGE_TONES[tone])} aria-hidden>
                        {icon}
                    </span>
                ) : null}
            </div>
            <div className="mt-2 text-2xl font-bold tabular-nums text-slate-900">{value}</div>
            {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
        </div>
    );
}

// ───────────────────────────────────────────────────────────── empty / loading

export function EmptyState({
    title,
    hint,
    action,
}: {
    title: string;
    hint?: string;
    action?: ReactNode;
}): JSX.Element {
    return (
        <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <div className="text-base font-semibold text-slate-700">{title}</div>
            {hint ? <p className="max-w-md text-sm text-slate-500">{hint}</p> : null}
            {action ? <div className="mt-2">{action}</div> : null}
        </div>
    );
}

/** Placeholder for an `Inertia::defer()`ed prop that has not landed yet. */
export function Skeleton({ rows = 3, className }: { rows?: number; className?: string }): JSX.Element {
    return (
        <div className={cn('space-y-2', className)} aria-hidden>
            {Array.from({ length: rows }, (_, index) => (
                <div
                    key={index}
                    className="h-4 animate-pulse-sync rounded bg-slate-200"
                    style={{ width: `${100 - index * 12}%` }}
                />
            ))}
        </div>
    );
}

/** Announces a deferred region politely while it loads. */
export function DeferredRegion<T>({
    value,
    label,
    rows,
    children,
}: {
    value: T | undefined;
    label: string;
    rows?: number;
    children: (value: T) => ReactNode;
}): JSX.Element {
    if (value === undefined) {
        return (
            <div role="status" aria-busy aria-label={label}>
                <Skeleton rows={rows ?? 3} />
            </div>
        );
    }
    return <>{children(value)}</>;
}

// ───────────────────────────────────────────────────────────── notice

export type NoticeTone = 'info' | 'warn' | 'danger' | 'ok';

const NOTICE_TONES: Record<NoticeTone, string> = {
    info: 'bg-info-soft text-info-fg ring-info/30',
    warn: 'bg-warn-soft text-warn-fg ring-warn/30',
    danger: 'bg-danger-soft text-danger-fg ring-danger/30',
    ok: 'bg-ok-soft text-ok-fg ring-ok/30',
};

/**
 * In-place explanation.
 *
 * Used mostly for one thing: telling an operator that a control is missing because the API
 * contract does not expose it. Silently hiding the control would leave someone hunting for a
 * feature that is not there; a disabled control with no explanation is worse.
 */
export function Notice({
    tone = 'info',
    title,
    children,
    className,
}: {
    tone?: NoticeTone;
    title?: ReactNode;
    children?: ReactNode;
    className?: string;
}): JSX.Element {
    return (
        <div
            className={cn('rounded-pos px-4 py-3 text-sm ring-1 ring-inset', NOTICE_TONES[tone], className)}
            role={tone === 'danger' ? 'alert' : undefined}
        >
            {title ? <div className="font-semibold">{title}</div> : null}
            {children ? <div className={cn(title && 'mt-1')}>{children}</div> : null}
        </div>
    );
}

// ───────────────────────────────────────────────────────────── misc

/** Indeterminate progress for a long action. Every long action shows one. */
export function ProgressBar({ label, value }: { label: string; value?: number }): JSX.Element {
    const determinate = typeof value === 'number';
    return (
        <div
            role="progressbar"
            aria-label={label}
            aria-valuemin={determinate ? 0 : undefined}
            aria-valuemax={determinate ? 100 : undefined}
            aria-valuenow={determinate ? Math.round(value) : undefined}
            className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200"
        >
            <div
                className={cn('h-full bg-brand-600', !determinate && 'w-1/3 animate-pulse-sync')}
                style={determinate ? { width: `${Math.max(0, Math.min(100, value))}%` } : undefined}
            />
        </div>
    );
}

/** Label/value pairs — the read-only half of every detail screen. */
export function DefinitionList({
    items,
    columns = 2,
}: {
    items: { label: ReactNode; value: ReactNode; wide?: boolean }[];
    columns?: 1 | 2 | 3;
}): JSX.Element {
    return (
        <dl
            className={cn(
                'grid gap-x-6 gap-y-3',
                columns === 1 && 'grid-cols-1',
                columns === 2 && 'grid-cols-1 sm:grid-cols-2',
                columns === 3 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
            )}
        >
            {items.map((item, index) => (
                <div key={index} className={cn(item.wide && 'sm:col-span-2 lg:col-span-3')}>
                    <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{item.label}</dt>
                    <dd className="mt-0.5 text-sm text-slate-900">{item.value}</dd>
                </div>
            ))}
        </dl>
    );
}

/** Section heading inside a long form. */
export function SectionTitle({
    title,
    description,
    id,
}: {
    title: ReactNode;
    description?: ReactNode;
    id?: string;
}): JSX.Element {
    return (
        <div className="mb-4">
            <h3 id={id} className="text-base font-semibold text-slate-900">
                {title}
            </h3>
            {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
        </div>
    );
}
