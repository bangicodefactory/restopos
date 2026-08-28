import type { OutboxEntry } from '@domain/sync/index';
import { Button, Sheet } from '@shared/ui';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { reloadData, syncNow } from '../boot';
import { tryRuntime } from '../data/runtime';
import { useT } from '../i18n';
import { useSyncStore } from '../state/boot-store';
import { unsyncedCount, useOrderStore } from '../state/order-store';
import { useUiStore } from '../state/ui-store';

/**
 * The sync panel (REG-375) and the quarantine drawer (spec 03 §3.6.6).
 *
 * The rule this screen exists to honour: a stuck order is **surfaced, never silently dropped and
 * never blocking**. Each entry shows what it is, how old it is, how many attempts it has had and
 * what the server said, with per-entry retry and an explicit, confirmed discard — because
 * discarding is throwing away a sale and must feel like it.
 */

export function SyncDrawer(): JSX.Element | null {
    const t = useT();
    const dialog = useUiStore((state) => state.dialog);
    const closeDialog = useUiStore((state) => state.closeDialog);
    const stats = useSyncStore((state) => state.stats);
    const [entries, setEntries] = useState<OutboxEntry[]>([]);
    const [busy, setBusy] = useState(false);
    const [repairing, setRepairing] = useState(false);

    const open = dialog?.kind === 'syncPanel';

    const refresh = useCallback(async () => {
        const runtime = tryRuntime();
        if (!runtime) return;
        useSyncStore.getState().setStats(await runtime.syncer.outbox.stats());
        setEntries(await listEntries());
    }, []);

    useEffect(() => {
        if (!open) return;
        void refresh();
        const timer = setInterval(() => void refresh(), 3_000);
        return () => clearInterval(timer);
    }, [open, refresh]);

    if (!open) return null;

    const problems = entries.filter((entry) => entry.state === 'error' || entry.state === 'quarantined');

    return (
        <Sheet open onClose={closeDialog} title={t('reg.sync.title')} side="right">
            <div className="space-y-4">
                <p className="text-sm text-slate-600">
                    {t('reg.sync.pending', { count: stats?.pending ?? 0 })} ·{' '}
                    {t('reg.sync.problems', { count: problems.length })}
                </p>

                <div className="flex gap-2">
                    <Button
                        loading={busy}
                        onClick={async () => {
                            setBusy(true);
                            await syncNow();
                            await refresh();
                            setBusy(false);
                        }}
                    >
                        {t('reg.sync.now')}
                    </Button>
                    <Button
                        variant="secondary"
                        onClick={async () => {
                            await tryRuntime()?.syncer.outbox.retryAll();
                            await syncNow();
                            await refresh();
                        }}
                    >
                        {t('reg.sync.retryAll')}
                    </Button>
                </div>

                {/*
                  * Repair local data (XCT-014, BAN-405).
                  *
                  * Lives here rather than on the boot screen because the case it is for is a till
                  * that *starts* fine and shows something wrong — a stale catalogue, a price that
                  * will not update. The boot screen only appears when the register failed to start,
                  * which is the one time this is not the problem.
                  *
                  * Refuses while sales are unsynced. "Repair" is what a cashier reaches for exactly
                  * when things already look wrong, and that is precisely when a full re-hydrate
                  * against a server that has never seen those sales would lose them quietly.
                  */}
                <div className="rounded-pos border border-slate-200 p-3">
                    <Button
                        variant="secondary"
                        loading={repairing}
                        onClick={async () => {
                            const pending = unsyncedCount(useOrderStore.getState());
                            if (pending > 0) {
                                globalThis.alert?.(t('reg.repair.blocked', { count: pending }));
                                return;
                            }

                            setRepairing(true);
                            const result = await reloadData();
                            setRepairing(false);
                            globalThis.alert?.(result.ok ? t('reg.repair.done') : t('reg.repair.failed'));
                            await refresh();
                        }}
                    >
                        {t('reg.repair.action')}
                    </Button>
                    <p className="mt-1 text-xs text-slate-500">{t('reg.repair.hint')}</p>
                </div>

                {problems.length === 0 ? (
                    <p className="text-slate-500">{t('reg.sync.noProblems')}</p>
                ) : (
                    <ul className="space-y-2">
                        {problems.map((entry) => (
                            <li key={entry.id} className="rounded-pos bg-danger-soft p-3 text-danger-fg">
                                <p className="font-semibold">
                                    {entry.kind} ·{' '}
                                    {entry.state === 'quarantined' ? t('reg.sync.quarantined') : t('reg.sync.error')}
                                </p>
                                <p className="text-sm">
                                    {entry.lastError && 'message' in entry.lastError
                                        ? entry.lastError.message
                                        : (entry.lastError?.kind ?? '')}{' '}
                                    · {t('reg.sync.attempts', { count: entry.attempts })}
                                </p>
                                <div className="mt-2 flex gap-2">
                                    <Button
                                        size="sm"
                                        onClick={async () => {
                                            await tryRuntime()?.syncer.outbox.retryNow(entry.id);
                                            await syncNow();
                                            await refresh();
                                        }}
                                    >
                                        {t('reg.sync.retry')}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="danger"
                                        onClick={async () => {
                                            if (!globalThis.confirm?.(t('reg.sync.discardConfirm'))) return;
                                            await tryRuntime()?.syncer.outbox.succeed(entry.id);
                                            await refresh();
                                        }}
                                    >
                                        {t('reg.sync.discard')}
                                    </Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </Sheet>
    );
}

/** The outbox exposes stats, not rows; the drawer needs the rows, so it reads Dexie directly. */
async function listEntries(): Promise<OutboxEntry[]> {
    const runtime = tryRuntime();
    if (!runtime) return [];
    return runtime.db.outbox.orderBy('seq').toArray();
}
