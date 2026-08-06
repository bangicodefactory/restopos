import { generateUuid } from '@domain/sequence/index';
import type { PosSessionRow } from '@domain/types';
import { ApiError } from '@shared/sync';

import { getRuntime } from '../data/runtime';
import { usePosSessionStore, type ClosingData, type DenominationCount } from '../state/session-store';

/**
 * Session lifecycle (REG-001 … REG-021).
 *
 * Deliberately **not** offline-first, and the asymmetry is the point:
 *
 *  - Opening and closing a session touch money that other devices also see, and the closing figures
 *    are computed server-side from synced orders (REG-014). A till that invented them offline would
 *    disagree with its neighbour, and the difference would be discovered at the bank.
 *  - Cash in / out is the exception: it is a local fact about this drawer, so it queues through the
 *    outbox and replays in order (REG-010).
 *
 * Selling never depends on any of this. A session that cannot be closed because the uplink is down
 * is an inconvenience; an order that cannot be taken is lost revenue.
 */

export type SessionResponse = { session: PosSessionRow | null };

function describe(error: unknown): string {
    if (error instanceof ApiError) {
        switch (error.sync.kind) {
            case 'offline':
                return 'offline';
            case 'auth':
                return 'auth';
            case 'validation':
                return error.sync.message;
            default:
                return error.message;
        }
    }
    return error instanceof Error ? error.message : String(error);
}

/**
 * The open session: from the server when it can be reached, from the replica when it cannot.
 *
 * This used to be network-only, and on failure it set an error and left the session null — so a till
 * that booted with the line down showed "open the session" and could not sell, however complete its
 * local replica was. Booting offline is worth nothing if the till cannot then take an order
 * (BAN-504).
 *
 * The successful response is written to Dexie so the next cold boot has something to read. That is
 * the same shape as the rest of the replica: the server is authoritative when present, and the local
 * copy is what the till trades on when it is not.
 */
export async function fetchCurrentSession(): Promise<PosSessionRow | null> {
    const { api, db } = getRuntime();
    const store = usePosSessionStore.getState();

    try {
        const response = await api.get<SessionResponse>('pos/sessions/current');
        const session = response.data?.session ?? null;

        store.setSession(session);

        if (session) await db.sessions.put(session);
        else await db.sessions.clear();

        return session;
    } catch (error) {
        const cached = await openSessionFromDb();

        if (cached) {
            // Offline with a session already open: trade on. No error — this is the designed path,
            // not a degraded one, and an error banner here would tell a cashier something is wrong
            // when nothing is.
            store.setSession(cached);

            return cached;
        }

        store.setError(describe(error));

        return null;
    }
}

/** The open session held locally, if any. */
export async function openSessionFromDb(): Promise<PosSessionRow | null> {
    const { db } = getRuntime();
    const rows = await db.sessions.toArray();

    return rows.find((row) => row.state !== 'closed') ?? null;
}

export async function openSession(input: {
    openingFloat: string;
    employeeId: number | null;
    notes?: string | null;
    denominations?: DenominationCount[];
}): Promise<PosSessionRow | null> {
    const { api } = getRuntime();
    const store = usePosSessionStore.getState();
    store.setBusy(true);
    store.setError(null);
    try {
        const response = await api.post<PosSessionRow>('pos/sessions', {
            opening_float: input.openingFloat,
            employee_id: input.employeeId,
            notes: input.notes ?? null,
            denominations: input.denominations ?? [],
        });
        const session = response.data;
        if (session) store.setSession(session);
        return session;
    } catch (error) {
        store.setError(describe(error));
        return null;
    } finally {
        store.setBusy(false);
    }
}

/** REG-003 — the session number is assigned here, not at create. */
export async function confirmOpeningControl(
    sessionId: number,
    countedFloat: string,
    employeeId: number | null,
): Promise<PosSessionRow | null> {
    const { api } = getRuntime();
    const store = usePosSessionStore.getState();
    store.setBusy(true);
    try {
        const response = await api.post<PosSessionRow>(`pos/sessions/${sessionId}/opening-control`, {
            counted_float: countedFloat,
            employee_id: employeeId,
        });
        if (response.data) store.setSession(response.data);
        return response.data;
    } catch (error) {
        store.setError(describe(error));
        return null;
    } finally {
        store.setBusy(false);
    }
}

export async function fetchClosingData(sessionId: number): Promise<ClosingData | null> {
    const { api } = getRuntime();
    const store = usePosSessionStore.getState();
    store.setBusy(true);
    store.setError(null);
    try {
        const response = await api.get<ClosingData>(`pos/sessions/${sessionId}/closing-data`);
        store.setClosingData(response.data);
        return response.data;
    } catch (error) {
        store.setError(describe(error));
        return null;
    } finally {
        store.setBusy(false);
    }
}

export type CloseSessionInput = {
    sessionId: number;
    countedCash: string;
    countedByMethod: Record<number, string>;
    denominations?: DenominationCount[];
    employeeId: number | null;
    notes?: string | null;
    managerEmployeeId?: number | null;
    managerPin?: string | null;
    force?: boolean;
};

export type CloseSessionResult =
    | { ok: true; session: PosSessionRow | null }
    | { ok: false; reason: string; closingData?: ClosingData };

export async function closeSession(input: CloseSessionInput): Promise<CloseSessionResult> {
    const { api } = getRuntime();
    const store = usePosSessionStore.getState();
    store.setBusy(true);
    try {
        const response = await api.post<PosSessionRow>(`pos/sessions/${input.sessionId}/close`, {
            counted_cash: input.countedCash,
            counted_by_method: input.countedByMethod,
            denominations: input.denominations ?? [],
            employee_id: input.employeeId,
            notes: input.notes ?? null,
            manager_employee_id: input.managerEmployeeId ?? null,
            manager_pin: input.managerPin ?? null,
            force: input.force ?? false,
        });
        if (response.data) store.setSession(response.data);
        return { ok: true, session: response.data };
    } catch (error) {
        const reason = describe(error);
        store.setError(reason);
        const body = error instanceof ApiError ? (error.body as { closing_data?: ClosingData } | null) : null;
        return body?.closing_data
            ? { ok: false, reason, closingData: body.closing_data }
            : { ok: false, reason };
    } finally {
        store.setBusy(false);
    }
}

/**
 * REG-010 — cash in / out. Queued through the outbox so it works with the network down and replays
 * in order; the caller always sends a positive magnitude and the server signs it.
 */
export async function recordCashMovement(input: {
    sessionId: number;
    type: 'cash_in' | 'cash_out';
    amount: string;
    reason: string;
    employeeId: number | null;
}): Promise<void> {
    const { syncer } = getRuntime();
    await syncer.enqueueCommand('session.cash_move', {
        uuid: generateUuid(),
        session_id: input.sessionId,
        movement_type: input.type,
        amount: input.amount,
        reason: input.reason,
        employee_id: input.employeeId,
    });
}
