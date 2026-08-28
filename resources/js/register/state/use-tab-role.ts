import { useEffect, useState } from 'react';

import { pauseWrites, resumeWrites } from '../boot';
import { createTabGuard, type TabRole } from '../domain/tab-guard';

/**
 * Which tab is allowed to write (REG-374, BAN-405).
 *
 * The guard is created once per mount and torn down on unmount, which also releases leadership —
 * so navigating away or closing the tab hands the register over immediately rather than leaving
 * the next tab waiting out the takeover delay.
 *
 * Writes are gated here rather than in the components: there are a dozen places that can enqueue,
 * and a guard on some of them is a guard none of them has.
 */
export function useTabRole(configId: string | number | null): TabRole {
    const [role, setRole] = useState<TabRole>('leader');

    useEffect(() => {
        if (configId === null) return;

        const guard = createTabGuard({
            configId,
            onRoleChange: (next) => {
                setRole(next);
                if (next === 'leader') resumeWrites();
                else pauseWrites();
            },
        });

        // `onRoleChange` only fires on a *change*, and the guard starts as leader — so a tab that
        // is genuinely first would never be told to start draining without this.
        setRole(guard.role);
        if (guard.role === 'leader') resumeWrites();

        return () => guard.stop();
    }, [configId]);

    return role;
}
