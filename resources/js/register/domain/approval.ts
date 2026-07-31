import { generateUuid } from '@domain/sequence/index';
import type { ApprovalRow } from '@domain/types';
import { asUuid } from '@domain/types';
import { verifyManagerApproval } from '@shared/auth';
import { browserOnline } from '@shared/sync';

import { getCatalog } from '../data/catalog';
import { tryRuntime } from '../data/runtime';
import { useUiStore } from '../state/ui-store';

/**
 * Manager overrides (REG-045, spec 03 §2.3).
 *
 * The PIN is an **attribution** control, not an authorisation boundary: a four-digit code verified
 * on the device is brute-forceable by anyone who can run code on it. So the approval is recorded
 * and synced, and the server re-checks the same rule on ingest. What this gives us is a signed
 * trail of *who* authorised the discount, which is what a manager actually wants to know.
 *
 * Offline the override still works unless the config forbids it (`allow_offline_manager_override`),
 * and the record is marked `verified: 'offline'` so the back-office report can tell the difference.
 */

type Pending = { resolve: (granted: boolean) => void; ability: string };

let pending: Pending | null = null;

export function requestApproval(ability: string): Promise<boolean> {
    if (pending) pending.resolve(false);
    useUiStore.getState().openDialog('approval', { ability });
    return new Promise<boolean>((resolve) => {
        pending = { resolve, ability };
    });
}

export function pendingAbility(): string | null {
    return pending?.ability ?? null;
}

export function cancelApproval(): void {
    pending?.resolve(false);
    pending = null;
    useUiStore.getState().closeDialog();
}

export type ApprovalAttempt = {
    managerEmployeeId: number;
    pin: string;
    orderUuid?: string | null;
};

export async function submitApproval(
    attempt: ApprovalAttempt,
): Promise<{ ok: boolean; reason?: string }> {
    const runtime = tryRuntime();
    const catalog = getCatalog();
    const ability = pending?.ability ?? '';

    if (!runtime?.deviceKey) return { ok: false, reason: 'no_device_key' };

    const result = await verifyManagerApproval(
        { db: runtime.db, deviceKey: runtime.deviceKey, employees: catalog.employees },
        {
            ability,
            managerEmployeeId: attempt.managerEmployeeId,
            pin: attempt.pin,
            allowOffline: catalog.config?.allow_offline_manager_override !== false,
            online: browserOnline(),
        },
    );

    if (!result.ok) return { ok: false, reason: result.reason ?? 'denied' };

    const approval: ApprovalRow = {
        uuid: asUuid(generateUuid()),
        order_uuid: attempt.orderUuid ? asUuid(attempt.orderUuid) : null,
        ability,
        manager_employee_id: attempt.managerEmployeeId,
        verified: result.verified ?? 'offline',
        at: new Date().toISOString(),
        context: {},
    };
    await runtime.db.approvals.put(approval);

    pending?.resolve(true);
    pending = null;
    useUiStore.getState().closeDialog();
    return { ok: true };
}

/** Managers are the only employees whose PIN can authorise an override. */
export function managerCandidates(ability: string): Array<{ id: number; name: string }> {
    return getCatalog()
        .employees.filter((employee) => employee.abilities.includes(ability))
        .map((employee) => ({ id: employee.id, name: employee.name }));
}
