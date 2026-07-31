import type { OutboxStats } from '@domain/sync/index';
import type { JSX, ReactNode } from 'react';

import { cn } from './cn';

/**
 * The always-visible sync indicator (spec 03 §3.6.6, UI treatment 1).
 *
 * Green: everything is on the server. Amber with a count: n pending. Red: something failed. Grey:
 * offline. Tapping opens the sync panel, which lists every outbox entry with its order reference,
 * age, attempt count and last error, plus Retry now / Retry all.
 *
 * This badge is the cashier's entire mental model of "did my sales make it", so it is never hidden,
 * never animated for decoration, and never shows a spinner where a count belongs.
 */

export type SyncBadgeLevel = 'synced' | 'pending' | 'failed' | 'offline' | 'syncing';

export function syncLevel(stats: OutboxStats | null, online: boolean): SyncBadgeLevel {
    if (!stats) return online ? 'synced' : 'offline';
    if (stats.quarantined > 0 || stats.error > 0) return 'failed';
    if (!online) return 'offline';
    if (stats.inflight > 0) return 'syncing';
    if (stats.pending > 0) return 'pending';
    return 'synced';
}

const LEVEL_STYLES: Record<SyncBadgeLevel, string> = {
    synced: 'bg-ok-soft text-ok-fg ring-ok/30',
    pending: 'bg-warn-soft text-warn-fg ring-warn/30',
    syncing: 'bg-info-soft text-info-fg ring-info/30 animate-pulse-sync',
    failed: 'bg-danger-soft text-danger-fg ring-danger/40',
    offline: 'bg-offline-soft text-offline-fg ring-offline/30',
};

const LEVEL_DOT: Record<SyncBadgeLevel, string> = {
    synced: 'bg-ok',
    pending: 'bg-warn',
    syncing: 'bg-info',
    failed: 'bg-danger',
    offline: 'bg-offline',
};

export type StatusBarProps = {
    online: boolean;
    stats: OutboxStats | null;
    /** Realtime socket state, shown as a second, quieter dot. */
    realtime?: 'connected' | 'degraded' | 'off';
    printerAlert?: string | null;
    onOpenSyncPanel?: () => void;
    /** Free slot for app-specific content (session name, cashier, clock). */
    children?: ReactNode;
    className?: string;
    labels?: Partial<Record<SyncBadgeLevel, string>>;
};

const DEFAULT_LABELS: Record<SyncBadgeLevel, string> = {
    synced: 'All synced',
    pending: 'pending',
    syncing: 'Syncing…',
    failed: 'failed',
    offline: 'Offline',
};

export function StatusBar({
    online,
    stats,
    realtime = 'off',
    printerAlert,
    onOpenSyncPanel,
    children,
    className,
    labels,
}: StatusBarProps): JSX.Element {
    const level = syncLevel(stats, online);
    const text = labels?.[level] ?? DEFAULT_LABELS[level];
    const count = level === 'pending' ? stats?.pending : level === 'failed' ? (stats?.error ?? 0) + (stats?.quarantined ?? 0) : null;

    return (
        <div
            className={cn(
                'flex min-h-touch items-center gap-3 border-b border-slate-200 bg-white px-3 text-sm',
                className,
            )}
        >
            <button
                type="button"
                onClick={onOpenSyncPanel}
                disabled={!onOpenSyncPanel}
                aria-label={`Sync status: ${count ? `${count} ${text}` : text}`}
                className={cn(
                    'inline-flex min-h-touch items-center gap-2 rounded-pos px-3 font-semibold ring-1',
                    LEVEL_STYLES[level],
                    onOpenSyncPanel && 'hover:brightness-95',
                )}
            >
                <span className={cn('h-2.5 w-2.5 rounded-full', LEVEL_DOT[level])} aria-hidden />
                {count ? `${count} ${text}` : text}
            </button>

            {realtime !== 'off' ? (
                <span
                    title={realtime === 'connected' ? 'Realtime connected' : 'Realtime degraded — polling'}
                    className={cn(
                        'h-2 w-2 rounded-full',
                        realtime === 'connected' ? 'bg-ok' : 'bg-warn',
                    )}
                    aria-label={realtime === 'connected' ? 'Realtime connected' : 'Realtime degraded'}
                />
            ) : null}

            {printerAlert ? (
                <span className="inline-flex min-h-touch items-center gap-1 rounded-pos bg-warn-soft px-2 font-medium text-warn-fg">
                    ⎙ {printerAlert}
                </span>
            ) : null}

            <div className="ms-auto flex items-center gap-3">{children}</div>
        </div>
    );
}

/** Compact variant for the kitchen display's dark chrome. */
export function KitchenStatusBar(props: StatusBarProps): JSX.Element {
    return (
        <StatusBar
            {...props}
            className={cn('border-kitchen-border bg-kitchen-surface text-kitchen-text', props.className)}
        />
    );
}
