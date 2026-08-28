import type { JSX } from 'react';

import { useT } from '../i18n';

/**
 * This register is already open in another tab (REG-374, BAN-405).
 *
 * Two tabs share one Dexie database and one outbox, and both would drain it — pushing the same
 * orders twice. So exactly one tab is elected the writer and the others land here.
 *
 * Deliberately a plain notice with no "use this tab instead" button. Forcing a takeover is exactly
 * how you end up with two writers, which is the failure being prevented; and it is not needed,
 * because leadership is released the moment the other tab is closed or navigated away — this screen
 * then becomes the till again on its own, with no reload.
 */
export function SecondTabScreen(): JSX.Element {
    const t = useT();

    return (
        <main
            className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-4 p-6 text-center"
            data-testid="second-tab-blocked"
        >
            <h1 className="text-2xl font-bold">{t('reg.tab.title')}</h1>
            <p className="text-slate-600">{t('reg.tab.body')}</p>
            <p className="text-sm text-slate-500">{t('reg.tab.hint')}</p>
        </main>
    );
}
