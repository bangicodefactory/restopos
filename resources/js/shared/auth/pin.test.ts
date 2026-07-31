import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EmployeeRow } from '@domain/types';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { META, PosDb, dbNameFor, getMeta } from '../db';
import { importDeviceKey } from './device';
import {
    LOCKOUT_MS,
    MAX_PIN_FAILURES,
    clearFailures,
    hmacHex,
    loadLockouts,
    lockoutRemaining,
    recordFailure,
    sha256Hex,
    timingSafeEqualHex,
    verifyBadge,
    verifyManagerApproval,
    verifyPin,
    type VerifyDeps,
} from './pin';

/**
 * Unit coverage for spec 03 §2.3 — offline employee verification.
 *
 * The PIN is an attribution control, not an authorisation boundary; what these tests pin down is
 * that the *attribution* is correct and that the rate limiting cannot be reset by a reload.
 */

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

let configId = 8000;
let db: PosDb;
let deviceKey: CryptoKey;

function employee(partial: Partial<EmployeeRow> & Pick<EmployeeRow, 'id'>): EmployeeRow {
    return {
        uuid: `employee-${partial.id}`,
        name: `Employee ${partial.id}`,
        default_role: 'cashier',
        access_level: 'basic',
        avatar_media_id: null,
        avatar_url: null,
        has_pin: true,
        pin_verifier: null,
        badge_verifier: null,
        abilities: [],
        active: true,
        ...partial,
    };
}

let ALICE: EmployeeRow; // cashier, PIN 1234, badge BADGE-A
let MANAGER: EmployeeRow; // manager, PIN 9999, holds line.discount.above_limit
let NO_PIN: EmployeeRow; // selection-only login

function deps(now: () => number = () => NOW): VerifyDeps {
    return { db, deviceKey, employees: [ALICE, MANAGER, NO_PIN], now };
}

beforeEach(async () => {
    configId += 1;
    db = new PosDb(configId);
    deviceKey = await importDeviceKey('device-secret');

    // Verifiers wrap the SHA-256 of the PIN/badge, exactly as the server derives them from
    // `employees.pin_hash` / `barcode_hash` (see EmployeeAuthService).
    ALICE = employee({
        id: 1,
        name: 'Alice',
        pin_verifier: await hmacHex(deviceKey, `pin:1:${await sha256Hex('1234')}`),
        badge_verifier: await hmacHex(deviceKey, `badge:1:${await sha256Hex('BADGE-A')}`),
    });
    MANAGER = employee({
        id: 2,
        name: 'Manon',
        default_role: 'manager',
        pin_verifier: await hmacHex(deviceKey, `pin:2:${await sha256Hex('9999')}`),
        abilities: ['line.discount.above_limit', 'refund.create'],
    });
    NO_PIN = employee({ id: 3, name: 'Sans code', has_pin: false, pin_verifier: null });
});

afterEach(async () => {
    db.close();
    await Dexie.delete(dbNameFor(configId));
});

// ─────────────────────────────────────────────────────────────────────────────

describe('timingSafeEqualHex', () => {
    it.each([
        { a: 'deadbeef', b: 'deadbeef', expected: true },
        { a: 'deadbeef', b: 'deadbeee', expected: false },
        { a: 'deadbeef', b: 'deadbee', expected: false },
        { a: '', b: '', expected: true },
    ])('$a vs $b → $expected', ({ a, b, expected }) => {
        expect(timingSafeEqualHex(a, b)).toBe(expected);
    });
});

describe('hmacHex', () => {
    it('is deterministic, lowercase hex and 64 characters for SHA-256', async () => {
        const first = await hmacHex(deviceKey, 'pin:1:1234');
        const second = await hmacHex(deviceKey, 'pin:1:1234');
        expect(first).toBe(second);
        expect(first).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is device-scoped — the same PIN under another device secret is a different verifier', async () => {
        const other = await importDeviceKey('another-device');
        expect(await hmacHex(other, 'pin:1:1234')).not.toBe(await hmacHex(deviceKey, 'pin:1:1234'));
    });

    it('binds the employee id, so one employee PIN cannot unlock another account', async () => {
        expect(await hmacHex(deviceKey, 'pin:1:1234')).not.toBe(await hmacHex(deviceKey, 'pin:2:1234'));
    });
});

describe('verifyPin', () => {
    it('accepts the right PIN', async () => {
        const result = await verifyPin(deps(), 1, '1234');
        expect(result).toEqual({ ok: true, employee: ALICE });
    });

    it('rejects the wrong PIN', async () => {
        expect(await verifyPin(deps(), 1, '0000')).toEqual({ ok: false, reason: 'wrong_pin' });
    });

    it('rejects an unknown employee', async () => {
        expect(await verifyPin(deps(), 99, '1234')).toEqual({ ok: false, reason: 'unknown_employee' });
    });

    it('lets a has_pin:false employee log in by selection alone', async () => {
        expect(await verifyPin(deps(), 3, '')).toEqual({ ok: true, employee: NO_PIN });
    });

    it('refuses an employee flagged has_pin whose verifier never arrived', async () => {
        NO_PIN = employee({ id: 3, has_pin: true, pin_verifier: null });
        expect(await verifyPin(deps(), 3, '1234')).toEqual({ ok: false, reason: 'no_pin' });
    });
});

describe('rate limiting', () => {
    it('locks the employee out after the configured number of failures', async () => {
        for (let attempt = 1; attempt < MAX_PIN_FAILURES; attempt++) {
            expect(await verifyPin(deps(), 1, '0000')).toEqual({ ok: false, reason: 'wrong_pin' });
        }

        const locked = await verifyPin(deps(), 1, '0000');
        expect(locked).toEqual({ ok: false, reason: 'locked', retryAfterMs: LOCKOUT_MS });
    });

    it('refuses even the correct PIN while locked out', async () => {
        for (let attempt = 0; attempt < MAX_PIN_FAILURES; attempt++) {
            await verifyPin(deps(), 1, '0000');
        }
        expect(await verifyPin(deps(), 1, '1234')).toMatchObject({ ok: false, reason: 'locked' });
    });

    it('lets the employee back in once the lockout has elapsed', async () => {
        for (let attempt = 0; attempt < MAX_PIN_FAILURES; attempt++) {
            await verifyPin(deps(), 1, '0000');
        }
        const later = (): number => NOW + LOCKOUT_MS + 1;
        expect(await verifyPin(deps(later), 1, '1234')).toMatchObject({ ok: true });
    });

    it('persists the counter, so reloading the page is not a bypass', async () => {
        for (let attempt = 0; attempt < MAX_PIN_FAILURES; attempt++) {
            await verifyPin(deps(), 1, '0000');
        }

        // A reload means a fresh Dexie handle over the same database.
        db.close();
        db = new PosDb(configId);

        expect(await loadLockouts(db)).toMatchObject({ 1: { failures: MAX_PIN_FAILURES } });
        expect(await verifyPin(deps(), 1, '1234')).toMatchObject({ ok: false, reason: 'locked' });
    });

    it('clears the counter on a successful PIN', async () => {
        await verifyPin(deps(), 1, '0000');
        expect(await loadLockouts(db)).toMatchObject({ 1: { failures: 1 } });

        await verifyPin(deps(), 1, '1234');
        expect(await loadLockouts(db)).toEqual({});
    });

    it('counts each employee separately', async () => {
        for (let attempt = 0; attempt < MAX_PIN_FAILURES; attempt++) {
            await verifyPin(deps(), 1, '0000');
        }
        expect(await verifyPin(deps(), 2, '9999')).toMatchObject({ ok: true });
    });

    it('lockoutRemaining reports the wait and ignores an expired entry', () => {
        expect(lockoutRemaining({ 1: { failures: 5, until: NOW + 5_000 } }, 1, NOW)).toBe(5_000);
        expect(lockoutRemaining({ 1: { failures: 5, until: NOW - 1 } }, 1, NOW)).toBe(0);
        expect(lockoutRemaining({}, 1, NOW)).toBe(0);
    });

    it('recordFailure / clearFailures round-trip through meta', async () => {
        await recordFailure(db, 7, NOW);
        expect(await getMeta(db, META.pinLockouts, {})).toMatchObject({ 7: { failures: 1, until: 0 } });

        await clearFailures(db, 7);
        expect(await getMeta(db, META.pinLockouts, {})).toEqual({});

        // Clearing an employee that was never recorded must not create an entry.
        await clearFailures(db, 8);
        expect(await getMeta(db, META.pinLockouts, {})).toEqual({});
    });
});

describe('verifyBadge', () => {
    it('finds the owner of a badge without being told who it is', async () => {
        expect(await verifyBadge(deps(), 'BADGE-A')).toEqual({ ok: true, employee: ALICE });
    });

    it('rejects an unknown badge', async () => {
        expect(await verifyBadge(deps(), 'BADGE-Z')).toEqual({ ok: false, reason: 'unknown_employee' });
    });

    it('clears the PIN lockout of the employee whose badge was accepted', async () => {
        for (let attempt = 0; attempt < MAX_PIN_FAILURES; attempt++) {
            await verifyPin(deps(), 1, '0000');
        }
        await verifyBadge(deps(), 'BADGE-A');
        expect(await loadLockouts(db)).toEqual({});
    });

    it('ignores employees with no badge configured', async () => {
        expect(await verifyBadge(deps(), '')).toEqual({ ok: false, reason: 'unknown_employee' });
    });
});

describe('verifyManagerApproval', () => {
    const attempt = {
        ability: 'line.discount.above_limit',
        managerEmployeeId: 2,
        pin: '9999',
        allowOffline: true,
        online: true,
    };

    it('grants an online override and records it as verified online', async () => {
        expect(await verifyManagerApproval(deps(), attempt)).toEqual({ ok: true, verified: 'online' });
    });

    it('grants an offline override and marks it so the back-office can tell', async () => {
        expect(await verifyManagerApproval(deps(), { ...attempt, online: false })).toEqual({
            ok: true,
            verified: 'offline',
        });
    });

    it('blocks the action when the config forbids offline overrides', async () => {
        expect(
            await verifyManagerApproval(deps(), { ...attempt, online: false, allowOffline: false }),
        ).toEqual({ ok: false, verified: null, reason: 'offline_override_disabled' });
    });

    it('refuses a manager who does not hold the ability', async () => {
        expect(await verifyManagerApproval(deps(), { ...attempt, ability: 'session.close' })).toEqual({
            ok: false,
            verified: null,
            reason: 'insufficient_ability',
        });
    });

    it('refuses an unknown manager', async () => {
        expect(await verifyManagerApproval(deps(), { ...attempt, managerEmployeeId: 99 })).toEqual({
            ok: false,
            verified: null,
            reason: 'unknown_employee',
        });
    });

    it('refuses a wrong PIN and counts it towards the lockout', async () => {
        expect(await verifyManagerApproval(deps(), { ...attempt, pin: '0000' })).toEqual({
            ok: false,
            verified: null,
            reason: 'wrong_pin',
        });
        expect(await loadLockouts(db)).toMatchObject({ 2: { failures: 1 } });
    });

    it('surfaces the lockout as the reason once the manager is locked out', async () => {
        for (let i = 0; i < MAX_PIN_FAILURES; i++) {
            await verifyManagerApproval(deps(), { ...attempt, pin: '0000' });
        }
        expect(await verifyManagerApproval(deps(), attempt)).toMatchObject({ ok: false, reason: 'locked' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('cross-language verifier parity (BAN-397)', () => {
    /**
     * The one test that would have caught the offline-login blocker: the client must reproduce, hex
     * for hex, the verifier the *server* emits — otherwise no cashier can ever log in with the
     * network unplugged, which is the whole reason bootstrap ships verifiers at all.
     *
     * The self-referential test above ("build the verifier with sha256, then verify it") cannot see
     * that divergence: it agrees with itself no matter which scheme it picks. So this block reads a
     * shared fixture whose expected verifiers were produced by the PHP server formula
     * ({@see \App\Services\Identity\EmployeeAuthService}) and asserts against those frozen values.
     * `tests/Feature/BootstrapTest.php` reads the same file — the two suites meet on one string.
     *
     * It drives the *shipped* client path end to end: `importDeviceKey` (device.ts, which encodes the
     * hex secret as UTF-8 to match the server's HMAC key) + `sha256Hex` + `hmacHex` (pin.ts). Revert
     * pin.ts to HMAC the raw PIN, or device.ts to decode the hex to bytes, and these hexes diverge.
     */
    type ParityCase = { kind: 'pin' | 'badge'; employeeId: number; secret: string; verifier: string };
    // `deviceSecretDerivation` (appKey + uuid) is consumed only by the PHP suite to reach this same
    // deviceSecret through the real DeviceTokenService; the client reads the secret directly.
    type ParityFixture = { deviceSecret: string; cases: ParityCase[] };

    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = JSON.parse(
        readFileSync(resolve(here, '../../../../tests/fixtures/auth/pin-verifier.json'), 'utf8'),
    ) as ParityFixture;
    const pinCases = fixture.cases.filter((c) => c.kind === 'pin');
    const badgeCases = fixture.cases.filter((c) => c.kind === 'badge');

    it('finds the shared fixture corpus', () => {
        expect(fixture.deviceSecret).toMatch(/^[0-9a-f]{64}$/);
        expect(fixture.cases.length).toBeGreaterThanOrEqual(4);
        expect(pinCases.length).toBeGreaterThan(0);
        expect(badgeCases.length).toBeGreaterThan(0);
    });

    // (1) The shipped primitives reproduce the server hex exactly — guards `sha256Hex`, `hmacHex`,
    // and `importDeviceKey`'s UTF-8 encoding of the hex secret (the server keys the HMAC on the same
    // bytes). If device.ts reverted to decoding the hex to bytes, every one of these would diverge.
    it.each(fixture.cases)(
        'primitive path reproduces the server $kind verifier for employee #$employeeId',
        async ({ kind, employeeId, secret, verifier }) => {
            const key = await importDeviceKey(fixture.deviceSecret);
            expect(await hmacHex(key, `${kind}:${employeeId}:${await sha256Hex(secret)}`)).toBe(verifier);
        },
    );

    // (2) The exact path BAN-397 broke: the shipped `verifyPin` / `verifyBadge` must accept the
    // plaintext against a *server-emitted* verifier. When they HMAC'd the raw PIN instead of
    // sha256(PIN), this returned `wrong_pin` for every cashier, forever, with the network down.
    it.each(pinCases)(
        'verifyPin accepts PIN "$secret" for employee #$employeeId against the server verifier',
        async ({ employeeId, secret, verifier }) => {
            const deviceKey = await importDeviceKey(fixture.deviceSecret);
            const emp = employee({ id: employeeId, has_pin: true, pin_verifier: verifier });
            expect(await verifyPin({ db, deviceKey, employees: [emp] }, employeeId, secret)).toMatchObject({
                ok: true,
            });
        },
    );

    it.each(badgeCases)(
        'verifyBadge authenticates badge "$secret" for employee #$employeeId against the server verifier',
        async ({ employeeId, secret, verifier }) => {
            const deviceKey = await importDeviceKey(fixture.deviceSecret);
            const emp = employee({ id: employeeId, has_pin: true, badge_verifier: verifier });
            expect(await verifyBadge({ db, deviceKey, employees: [emp] }, secret)).toMatchObject({
                ok: true,
                employee: emp,
            });
        },
    );

    // The verifier is not vacuously accepting: the *wrong* plaintext against a real server verifier
    // is still rejected. Guards against a future change that makes the comparison pass trivially.
    it('rejects the wrong PIN against a real server verifier', async () => {
        const [first] = pinCases;
        if (!first) throw new Error('parity fixture has no pin cases');
        const { employeeId, secret, verifier } = first;
        const deviceKey = await importDeviceKey(fixture.deviceSecret);
        const emp = employee({ id: employeeId, has_pin: true, pin_verifier: verifier });
        expect(await verifyPin({ db, deviceKey, employees: [emp] }, employeeId, `${secret}-wrong`)).toMatchObject({
            ok: false,
            reason: 'wrong_pin',
        });
    });
});
