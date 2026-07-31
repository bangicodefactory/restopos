import { Button, Spinner } from '@shared/ui';
import type { JSX } from 'react';
import { useState } from 'react';

import { hardReset, hydrateLocal, runBootstrap } from '../boot';
import { useT } from '../i18n';
import { useBootStore } from '../state/boot-store';
import { unsyncedCount, useOrderStore } from '../state/order-store';

/**
 * Bootstrap progress (spec 03 §3.2.1).
 *
 * The manifest exists so this is a progress bar with a known denominator instead of an opaque
 * eight-second wait. When the device already holds a dataset this screen never appears — the
 * register renders from IndexedDB and the download happens behind it.
 */

export function BootScreen(): JSX.Element {
    const t = useT();
    const phase = useBootStore((state) => state.phase);
    const label = useBootStore((state) => state.progressLabel);
    const progress = useBootStore((state) => state.progress);
    const error = useBootStore((state) => state.error);
    const hasLocalData = useBootStore((state) => state.hasLocalData);
    const [busy, setBusy] = useState(false);

    const text =
        label === 'purging'
            ? t('reg.boot.purging')
            : label === 'applying'
              ? t('reg.boot.applying')
              : label === 'ready'
                ? t('reg.boot.ready')
                : t('reg.boot.downloading');

    return (
        <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 p-6 text-center">
            <h1 className="text-2xl font-bold">{t('reg.boot.title')}</h1>

            {error === null ? (
                <>
                    <Spinner size="lg" label={text} />
                    <p className="text-lg">{text}</p>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                        <div
                            className="h-full bg-brand-600 transition-all"
                            style={{ width: progress === null ? '35%' : `${Math.round(progress * 100)}%` }}
                        />
                    </div>
                </>
            ) : (
                <>
                    <p className="text-lg font-semibold text-danger">{t('reg.boot.failed')}</p>
                    <p className="text-slate-600">{error === 'offline' ? t('status.offline') : error}</p>

                    <Button
                        size="xl"
                        block
                        loading={busy}
                        onClick={async () => {
                            setBusy(true);
                            const ok = await runBootstrap();
                            if (ok) {
                                await hydrateLocal();
                                useBootStore.getState().setPhase('ready');
                            }
                            setBusy(false);
                        }}
                    >
                        {t('reg.boot.retry')}
                    </Button>

                    {hasLocalData ? (
                        <Button
                            variant="secondary"
                            block
                            onClick={async () => {
                                await hydrateLocal();
                                useBootStore.getState().setPhase('ready');
                            }}
                        >
                            {t('reg.boot.continueOffline')}
                        </Button>
                    ) : null}

                    <Button
                        variant="ghost"
                        onClick={async () => {
                            const pending = unsyncedCount(useOrderStore.getState());
                            if (pending > 0) {
                                globalThis.alert?.(t('reg.boot.hardResetBlocked', { count: pending }));
                                return;
                            }
                            if (!globalThis.confirm?.(t('reg.boot.hardResetBody'))) return;
                            await hardReset();
                            globalThis.location?.reload();
                        }}
                    >
                        {t('reg.boot.hardReset')}
                    </Button>
                </>
            )}

            <p className="text-xs text-slate-400">{phase}</p>
        </main>
    );
}
