import 'fake-indexeddb/auto';

import { hmacHex, importDeviceKey, sha256Hex } from '@shared/auth';
import { PosDb, dbNameFor } from '@shared/db';
import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { clearRuntime, setRuntime, type RegisterRuntime } from '../data/runtime';
import { cancelApproval, requestApproval, submitApproval } from './approval';
import { installCatalog, makeConfig, makeEmployee, resetRegisterState } from './__fixtures__/catalog';

/**
 * REG-016 / BAN-419 — a manager approval must hand its credentials back to the caller so an
 * over-variance session close can forward them to the server. `requestApproval` resolving to a bare
 * boolean was the bug: the till showed the dialog, then closed without the manager's id/PIN and the
 * server rejected every over-variance close.
 */

const OVER_VARIANCE = 'session.close.over_variance';

let configId = 9500;
let db: PosDb;

async function verifier(deviceKey: CryptoKey, id: number, pin: string): Promise<string> {
    return hmacHex(deviceKey, `pin:${id}:${await sha256Hex(pin)}`);
}

beforeEach(async () => {
    configId += 1;
    resetRegisterState();
    db = new PosDb(configId);
    const deviceKey = await importDeviceKey('device-secret');

    installCatalog({
        config: makeConfig({}),
        employees: [
            makeEmployee({ id: 2, name: 'Manon', abilities: [OVER_VARIANCE], has_pin: true, pin_verifier: await verifier(deviceKey, 2, '9999') }),
            makeEmployee({ id: 1, name: 'Alice', abilities: [], has_pin: true, pin_verifier: await verifier(deviceKey, 1, '1234') }),
        ],
    });

    setRuntime({ db, deviceKey } as unknown as RegisterRuntime);
});

afterEach(async () => {
    clearRuntime();
    db.close();
    await Dexie.delete(dbNameFor(configId));
});

it('resolves requestApproval with the manager credentials on a valid PIN, and records the approval', async () => {
    const pending = requestApproval(OVER_VARIANCE);

    const submitted = await submitApproval({ managerEmployeeId: 2, pin: '9999' });
    expect(submitted.ok).toBe(true);

    // The credentials flow back so the caller can forward them to the server-verified close.
    await expect(pending).resolves.toEqual({ managerEmployeeId: 2, pin: '9999' });

    // …and the attribution trail is written for the back-office report.
    expect(await db.approvals.count()).toBe(1);
});

it('does not resolve on a wrong PIN or an employee without the ability', async () => {
    const pending = requestApproval(OVER_VARIANCE);

    expect((await submitApproval({ managerEmployeeId: 2, pin: '0000' })).ok).toBe(false); // wrong PIN
    expect((await submitApproval({ managerEmployeeId: 1, pin: '1234' })).ok).toBe(false); // holds no ability

    // Still pending, so nothing was granted — cancelling resolves to null (denied).
    cancelApproval();
    await expect(pending).resolves.toBeNull();
    expect(await db.approvals.count()).toBe(0);
});

it('resolves an earlier pending request to null when a new one supersedes it', async () => {
    const first = requestApproval(OVER_VARIANCE);
    requestApproval(OVER_VARIANCE); // supersedes
    await expect(first).resolves.toBeNull();
});

/**
 * BAN-515 — the approval records *which line* the manager was standing in front of.
 *
 * `context` was hardcoded `{}`, so the only binding the client asserted was the order and one
 * approval unlocked the ability for every line in the push. The server narrows on this key; it can
 * only narrow on what the client actually says.
 */
it('records the line an approval was granted for', async () => {
    const pending = requestApproval(OVER_VARIANCE, { lineUuid: 'line-7' });

    expect((await submitApproval({ managerEmployeeId: 2, pin: '9999' })).ok).toBe(true);
    await pending;

    const [row] = await db.approvals.toArray();

    expect(row?.context).toEqual({ line_uuid: 'line-7' });
});

it('leaves the context empty when no line was named', async () => {
    // Order-scoped, which is what a session close or a cash-movement delete wants — and what the
    // server treats as "authorises the whole push", exactly as before this change.
    const pending = requestApproval(OVER_VARIANCE);

    expect((await submitApproval({ managerEmployeeId: 2, pin: '9999' })).ok).toBe(true);
    await pending;

    const [row] = await db.approvals.toArray();

    expect(row?.context).toEqual({});
});
