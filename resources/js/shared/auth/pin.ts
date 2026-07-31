import type { EmployeeRow } from '@domain/types';

import { META, getMeta, setMeta, type PosDb } from '../db';

/**
 * Offline employee verification (spec 03 §2.3).
 *
 * Requirement: switching cashier must take <100 ms with the network unplugged, hundreds of times a
 * shift. So the bootstrap payload carries, per employee and **per device**:
 *
 *     pin_verifier   = HMAC-SHA256(device_secret, "pin:<employee_id>:<sha256(pin)>")
 *     badge_verifier = HMAC-SHA256(device_secret, "badge:<employee_id>:<sha256(badge_code)>")
 *
 * The PIN/badge is SHA-256'd before it enters the verifier because the server only ever holds that
 * digest (`employees.pin_hash` / `barcode_hash`) — it never sees the plaintext — so both sides must
 * agree to hash first ({@see \App\Services\Identity\EmployeeAuthService}). The plaintext PIN is
 * never sent, and neither is the server-side hash.
 *
 * **Threat model, stated honestly.** A 4–6 digit PIN verified offline is brute-forceable by anyone
 * with code execution on the device (10⁶ HMACs ≈ seconds). That is inherent to *any* offline PIN
 * scheme, Odoo's included. Therefore the PIN is an **attribution** control ("who rang this up"),
 * not an authorization boundary: anything with real financial consequence requires a manager
 * approval that is recorded and synced. The rate limiting below raises the cost of casual guessing
 * at the counter; it is not a defence against an attacker with the device in a lab.
 */

const encoder = new TextEncoder();

export async function hmacHex(key: CryptoKey, message: string): Promise<string> {
    const signature = await globalThis.crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(message) as unknown as BufferSource,
    );
    const bytes = new Uint8Array(signature);
    let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
    return out;
}

/**
 * Lower-case hex SHA-256 — the digest the verifier message wraps. Mirrors the server's
 * `hash('sha256', pin)` so `employees.pin_hash` and this produce the same string for the same PIN.
 */
export async function sha256Hex(value: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value) as unknown as BufferSource);
    const bytes = new Uint8Array(digest);
    let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
    return out;
}

/**
 * Constant-time hex comparison.
 *
 * The timing channel here is genuinely irrelevant (the attacker already has the verifier if they
 * can read IndexedDB), but writing the comparison correctly costs three lines and removes the need
 * for anyone to reason about it again.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export type PinResult =
    | { ok: true; employee: EmployeeRow }
    | { ok: false; reason: 'unknown_employee' | 'no_pin' | 'wrong_pin' | 'locked'; retryAfterMs?: number };

// ── rate limiting ────────────────────────────────────────────────────────────

export type LockoutState = Record<number, { failures: number; until: number }>;

export const MAX_PIN_FAILURES = 5;
export const LOCKOUT_MS = 30_000;

/** Persisted so a reload does not reset the counter — the obvious bypass otherwise. */
export async function loadLockouts(db: PosDb): Promise<LockoutState> {
    return getMeta<LockoutState>(db, META.pinLockouts, {});
}

export async function recordFailure(db: PosDb, employeeId: number, now = Date.now()): Promise<LockoutState> {
    const state = await loadLockouts(db);
    const current = state[employeeId] ?? { failures: 0, until: 0 };
    const failures = current.failures + 1;
    const next: LockoutState = {
        ...state,
        [employeeId]: { failures, until: failures >= MAX_PIN_FAILURES ? now + LOCKOUT_MS : 0 },
    };
    await setMeta(db, META.pinLockouts, next);
    return next;
}

export async function clearFailures(db: PosDb, employeeId: number): Promise<void> {
    const state = await loadLockouts(db);
    if (!(employeeId in state)) return;
    const next = { ...state };
    delete next[employeeId];
    await setMeta(db, META.pinLockouts, next);
}

export function lockoutRemaining(state: LockoutState, employeeId: number, now = Date.now()): number {
    const entry = state[employeeId];
    if (!entry || entry.until <= now) return 0;
    return entry.until - now;
}

// ── verification ─────────────────────────────────────────────────────────────

export type VerifyDeps = {
    db: PosDb;
    deviceKey: CryptoKey;
    employees: readonly EmployeeRow[];
    now?: () => number;
};

export async function verifyPin(deps: VerifyDeps, employeeId: number, pin: string): Promise<PinResult> {
    const now = deps.now?.() ?? Date.now();
    const employee = deps.employees.find((e) => e.id === employeeId);
    if (!employee) return { ok: false, reason: 'unknown_employee' };

    const lockouts = await loadLockouts(deps.db);
    const remaining = lockoutRemaining(lockouts, employeeId, now);
    if (remaining > 0) return { ok: false, reason: 'locked', retryAfterMs: remaining };

    if (!employee.pin_verifier) {
        // No PIN configured: `has_pin === false` employees log in by selection alone.
        return employee.has_pin ? { ok: false, reason: 'no_pin' } : { ok: true, employee };
    }

    const mac = await hmacHex(deps.deviceKey, `pin:${employeeId}:${await sha256Hex(pin)}`);
    if (!timingSafeEqualHex(mac, employee.pin_verifier)) {
        const state = await recordFailure(deps.db, employeeId, now);
        const after = lockoutRemaining(state, employeeId, now);
        return after > 0
            ? { ok: false, reason: 'locked', retryAfterMs: after }
            : { ok: false, reason: 'wrong_pin' };
    }

    await clearFailures(deps.db, employeeId);
    return { ok: true, employee };
}

/**
 * Badge / RFID login.
 *
 * The badge code alone does not tell us who it belongs to, so we iterate: fewer than 200 employees
 * means fewer than 200 HMACs, about a millisecond. Odoo narrows with a prefix; we do not, because
 * the simpler version is fast enough and cannot be fooled by a forged prefix.
 */
export async function verifyBadge(deps: VerifyDeps, badgeCode: string): Promise<PinResult> {
    for (const employee of deps.employees) {
        if (!employee.badge_verifier) continue;
        const mac = await hmacHex(deps.deviceKey, `badge:${employee.id}:${await sha256Hex(badgeCode)}`);
        if (timingSafeEqualHex(mac, employee.badge_verifier)) {
            await clearFailures(deps.db, employee.id);
            return { ok: true, employee };
        }
    }
    return { ok: false, reason: 'unknown_employee' };
}

/**
 * Manager approval for a consequential action (spec 03 §2.3).
 *
 * Online, the server verifies against `employees.pin_hash` and returns a signed approval. Offline,
 * we verify locally, allow the action and queue an `approval` record marked `verified: 'offline'`
 * for the back-office audit report. A config may forbid offline overrides entirely, in which case
 * the action is simply blocked while the network is down.
 */
export async function verifyManagerApproval(
    deps: VerifyDeps,
    options: { ability: string; managerEmployeeId: number; pin: string; allowOffline: boolean; online: boolean },
): Promise<{ ok: boolean; verified: 'online' | 'offline' | null; reason?: string }> {
    if (!options.online && !options.allowOffline) {
        return { ok: false, verified: null, reason: 'offline_override_disabled' };
    }

    const manager = deps.employees.find((e) => e.id === options.managerEmployeeId);
    if (!manager) return { ok: false, verified: null, reason: 'unknown_employee' };
    if (!manager.abilities.includes(options.ability)) {
        return { ok: false, verified: null, reason: 'insufficient_ability' };
    }

    const result = await verifyPin(deps, options.managerEmployeeId, options.pin);
    if (!result.ok) return { ok: false, verified: null, reason: result.reason };

    return { ok: true, verified: options.online ? 'online' : 'offline' };
}
