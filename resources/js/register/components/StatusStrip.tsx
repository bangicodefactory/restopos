import { useSessionStore } from '@shared/auth';
import { StatusBar, cn } from '@shared/ui';
import type { JSX } from 'react';

import { useT } from '../i18n';
import { useSyncStore } from '../state/boot-store';
import { useUiStore } from '../state/ui-store';

/**
 * The persistent status strip (spec 03 §3.6.6, REG-375).
 *
 * This badge is the cashier's entire mental model of "did my sales make it", so it is never hidden,
 * never replaced by a spinner where a count belongs, and always tappable to the panel that says
 * *what* is pending in human terms rather than "syncing…".
 *
 * Per-record sync failures land in the notice strip underneath: a failed order must never take the
 * screen away from the next customer.
 */

export function StatusStrip({ className }: { className?: string }): JSX.Element {
    const t = useT();
    const online = useSyncStore((state) => state.online);
    const stats = useSyncStore((state) => state.stats);
    const realtime = useSyncStore((state) => state.realtime);
    const lastSyncAt = useSyncStore((state) => state.lastSyncAt);
    const notices = useSyncStore((state) => state.notices);
    const dismissNotice = useSyncStore((state) => state.dismissNotice);
    const openDialog = useUiStore((state) => state.openDialog);
    const cashier = useSessionStore((state) => state.cashier);

    return (
        <div className={cn('shrink-0', className)}>
            <StatusBar
                online={online}
                stats={stats}
                realtime={realtime}
                onOpenSyncPanel={() => openDialog('syncPanel')}
                labels={{
                    synced: t('status.synced'),
                    pending: t('reg.sync.pending', { count: stats?.pending ?? 0 }),
                    failed: t('status.failed', { count: (stats?.error ?? 0) + (stats?.quarantined ?? 0) }),
                    syncing: t('status.syncing'),
                    offline: t('status.offline'),
                }}
            >
                <span className="hidden text-sm text-slate-500 till:inline">
                    {t('reg.sync.lastSync', {
                        when: lastSyncAt === null ? t('reg.sync.never') : new Date(lastSyncAt).toLocaleTimeString(),
                    })}
                </span>
                {cashier ? <span className="text-sm font-semibold">{cashier.name}</span> : null}
            </StatusBar>

            {notices.length > 0 ? (
                <ul className="flex flex-wrap gap-2 bg-warn-soft px-3 py-1 text-sm text-warn-fg">
                    {notices.slice(-3).map((notice) => (
                        <li key={notice.id}>
                            <button
                                type="button"
                                className="min-h-touch rounded-pos px-2 underline"
                                onClick={() => dismissNotice(notice.id)}
                            >
                                {notice.message} ✕
                            </button>
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}
