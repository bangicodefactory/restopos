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

/**
 * The credentials of the approving manager, returned so the caller can forward them to a
 * server-verified action (e.g. an over-variance session close, REG-016). `null` means denied or
 * cancelled. The PIN is already verified client-side here; the server re-checks it on ingest.
 */
export type ApprovalGrant = { managerEmployeeId: number; pin: string };

/**
 * What the approval was granted *for* (BAN-515, BAN-518).
 *
 * `lineUuid` narrows the approval to one line. Omit it for an ability that is not about a line —
 * a session close, a cash-movement delete — and the approval stays order-scoped, which is what the
 * server assumes when no context arrives.
 *
 * **`orderUuid` is what gets the approval off the device.** `persistence.ts` attaches approvals to
 * an order push with `db.approvals.where('order_uuid').equals(orderUuid)`, so a row written without
 * one is never sent: the till shows the override, the server reprices the line because it saw no
 * approval, and the audit trail never records that a manager authorised anything — the one fact the
 * PIN exists to capture (BAN-413).
 *
 * The two original callers are session-level and hand the manager's credentials straight to an HTTP
 * endpoint, so they never needed it. Anything riding the order push does.
 */
export type ApprovalContext = { lineUuid?: string; orderUuid?: string };

/**
 * The `context` key the server reads the line from.
 *
 * Paired with `ApprovalAuthority::LineContextKey` in PHP. There is no shared home for a constant
 * across the two languages, so the pairing is held by the tests at both ends.
 */
export const LINE_CONTEXT_KEY = 'line_uuid';

type Pending = { resolve: (grant: ApprovalGrant | null) => void; ability: string; context: ApprovalContext };

let pending: Pending | null = null;

export function requestApproval(ability: string, context: ApprovalContext = {}): Promise<ApprovalGrant | null> {
    if (pending) pending.resolve(null);
    useUiStore.getState().openDialog('approval', { ability });
    return new Promise<ApprovalGrant | null>((resolve) => {
        pending = { resolve, ability, context };
    });
}

export function pendingAbility(): string | null {
    return pending?.ability ?? null;
}

export function cancelApproval(): void {
    pending?.resolve(null);
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

    // The context wins over the attempt: `requestApproval` is where the caller says what the
    // approval is *for*, and the dialog that calls `submitApproval` knows nothing about orders.
    const orderUuid = pending?.context.orderUuid ?? attempt.orderUuid ?? null;

    const approval: ApprovalRow = {
        uuid: asUuid(generateUuid()),
        order_uuid: orderUuid === null ? null : asUuid(orderUuid),
        ability,
        manager_employee_id: attempt.managerEmployeeId,
        verified: result.verified ?? 'offline',
        at: new Date().toISOString(),
        // Was hardcoded `{}` — so the server could only ever bind an approval to the order, and one
        // approval unlocked every line in the push (BAN-515). Recording the line the manager was
        // actually standing in front of is the whole of what makes the narrower binding possible.
        context: pending?.context.lineUuid === undefined ? {} : { [LINE_CONTEXT_KEY]: pending.context.lineUuid },
    };
    await runtime.db.approvals.put(approval);

    pending?.resolve({ managerEmployeeId: attempt.managerEmployeeId, pin: attempt.pin });
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
