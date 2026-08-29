import type { DeviceInfo } from '@domain/types';

import { META, getMeta, setMeta, type PosDb } from '../db';

/**
 * Device credentials (spec 03 §2.2).
 *
 * Stored in **IndexedDB, never localStorage**. localStorage is synchronous, string-only, more
 * readily scraped by injected script, and — critically — cleared by the "clear site data" flows
 * Workbox users routinely hit. IndexedDB survives alongside the rest of the offline dataset and is
 * atomic with it.
 *
 * The device secret gets a second layer: it is imported once at pairing as a **non-extractable**
 * `CryptoKey` and the raw bytes are then dropped. `CryptoKey` is structured-cloneable, so it can
 * live in IndexedDB, but a stolen database dump does not yield the HMAC key — only an attacker
 * executing code in the origin can use it.
 */

export type PairingRequest = {
    code: string;
    kind: DeviceInfo['kind'];
    hardware_fingerprint: string;
    app_version: string;
};

/**
 * `POST /api/devices/pair`, exactly as `DevicePairingResource` serialises it.
 *
 * The numeric fields really do arrive as numbers and the kind really is called `device_type`; the
 * older shape of this type invented `device_seq` and `kind`, which the server has never sent, so
 * every register paired with `device_seq: undefined` and stamped `26Dundefined-…` on its first
 * offline order reference. Mirroring the wire and normalising in one place is what stops that
 * recurring.
 */
export type PairingResponse = {
    device: {
        id: string | number;
        uuid: string;
        name: string;
        device_identifier: string | number;
        device_type: DeviceInfo['kind'];
    };
    token: string;
    /** 32 bytes hex — used to derive the offline PIN/badge verifiers. Never persisted raw. */
    device_secret: string;
    config_id: number;
    server_time: string;
    min_client_version: string;
};

export type StoredDevice = {
    info: DeviceInfo;
    token: string;
};

/**
 * Import the pairing secret as a non-extractable HMAC key.
 *
 * The key material is the device-secret **hex string itself**, taken as UTF-8 bytes — matching the
 * server, which uses that same hex string directly as the `hash_hmac` key when it derives the
 * PIN/badge verifiers ({@see \App\Services\Identity\EmployeeAuthService}). Decoding the hex to raw
 * bytes here would silently produce a different key and every offline PIN check would fail.
 */
export async function importDeviceKey(secretHex: string): Promise<CryptoKey> {
    return globalThis.crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secretHex) as unknown as BufferSource,
        { name: 'HMAC', hash: 'SHA-256' },
        /* extractable */ false,
        ['sign'],
    );
}

/**
 * Persist everything the device needs to work offline forever after.
 *
 * `uuid` is stored because the server stamps it on every broadcast as `emitted_by_device_uuid`.
 * A till that does not know its own uuid cannot suppress its own echo, so it re-pulls every order
 * it just wrote — or, worse, suppresses nothing and the two behaviours are indistinguishable from
 * the outside.
 *
 * `device_seq` is the per-config ordinal that prefixes offline order references; the server calls
 * it `device_identifier` and sends nothing named `device_seq`.
 */
export async function storePairing(db: PosDb, response: PairingResponse, appVersion: string): Promise<StoredDevice> {
    const info: DeviceInfo = {
        device_id: String(response.device.id),
        uuid: String(response.device.uuid),
        device_identifier: String(response.device.device_identifier),
        device_seq: Number(response.device.device_identifier),
        config_id: response.config_id,
        name: response.device.name,
        kind: response.device.device_type,
        app_version: appVersion,
    };

    const key = await importDeviceKey(response.device_secret);

    await setMeta(db, META.device, info);
    await setMeta(db, META.deviceToken, response.token);
    // The CryptoKey, not the hex. The raw secret never touches storage.
    await setMeta(db, META.deviceKey, key);

    return { info, token: response.token };
}

export async function loadDevice(db: PosDb): Promise<StoredDevice | null> {
    const info = await getMeta<DeviceInfo | null>(db, META.device, null);
    const token = await getMeta<string | null>(db, META.deviceToken, null);
    if (!info || !token) return null;
    return { info, token };
}

export async function loadDeviceKey(db: PosDb): Promise<CryptoKey | null> {
    const key = await getMeta<CryptoKey | null>(db, META.deviceKey, null);
    // A structured-clone round-trip of a CryptoKey preserves its type; anything else is corruption.
    return key && typeof (key as CryptoKey).algorithm === 'object' ? key : null;
}

export async function isPaired(db: PosDb): Promise<boolean> {
    return (await loadDevice(db)) !== null;
}

/**
 * Forget this device.
 *
 * Credentials only — order data is deliberately left alone, because a revoked device mid-shift
 * still holds sales that must reach the server once a manager re-pairs it.
 */
export async function clearPairing(db: PosDb): Promise<void> {
    await db.meta.bulkDelete([META.device, META.deviceToken, META.deviceKey, META.activeEmployee]);
}

/**
 * A stable-enough machine fingerprint for the pairing request. Not a security control — it exists
 * so the back-office device list is legible ("Bar terminal 2, Chrome on Android") and so a
 * re-pairing of the same physical tablet can be recognised.
 */
export function hardwareFingerprint(): string {
    const nav = globalThis.navigator;
    const screen = globalThis.screen;
    const parts = [
        nav?.userAgent ?? 'unknown',
        nav?.language ?? '',
        String(nav?.hardwareConcurrency ?? 0),
        screen ? `${screen.width}x${screen.height}x${screen.colorDepth}` : '',
        Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
    ];
    // The server caps `hardware_fingerprint` at 128 chars (PairDeviceRequest); a modern
    // user-agent alone can exceed that, which would 422 the pairing request.
    return parts.join('|').slice(0, 128);
}
