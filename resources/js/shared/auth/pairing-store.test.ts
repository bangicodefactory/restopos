import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { META, PosDb, dbNameFor, getMeta } from '../db';
import { storePairing, type PairingResponse } from './device';

/**
 * BAN-402 — what a device keeps from its own pairing.
 *
 * `storePairing` builds the `DeviceInfo` every other subsystem reads, from a payload it does not
 * validate. That is a shape nobody notices going wrong: a field the server never sends lands as
 * `undefined`, `String(undefined)` is a perfectly good string, and the failure appears weeks later
 * as an order reference nobody can parse.
 *
 * Two fields were doing exactly that. `device_seq` — the per-config ordinal that prefixes every
 * offline order reference — was read from `response.device.device_seq`, which `DevicePairingResource`
 * has never sent; the register stamped `26Dundefined-…` on its first offline sale. And `uuid` was
 * not persisted at all, which is why the register could not suppress its own broadcast echo: the
 * server stamps `emitted_by_device_uuid` on every event and the till had nothing to compare it to.
 */

function response(overrides: Partial<PairingResponse['device']> = {}): PairingResponse {
    return {
        device: {
            id: 12,
            uuid: 'a1b2c3d4-0000-4000-8000-000000000001',
            name: 'Bar terminal 2',
            device_identifier: 3,
            device_type: 'register',
            ...overrides,
        },
        token: 'bearer-token',
        // 32 bytes hex, the shape the server actually mints.
        device_secret: 'ab'.repeat(32),
        config_id: configId,
        server_time: '2026-01-01T00:00:00Z',
        min_client_version: '1.0.0',
    };
}

// A fresh database per test: Dexie caches by name, and a shared one would let the round-trip
// assertions read a row an earlier test wrote.
let configId = 9700;
let db: PosDb;

beforeEach(() => {
    configId += 1;
    db = new PosDb(configId);

    // `storePairing` imports the device secret as a non-extractable HMAC key. Node's WebCrypto does
    // that fine; the stub is only here so a runner without `crypto.subtle` fails on the assertion
    // rather than on the import.
    if (globalThis.crypto?.subtle === undefined) {
        vi.stubGlobal('crypto', { subtle: { importKey: async (): Promise<unknown> => ({ algorithm: {} }) } });
    }
});

afterEach(async () => {
    db.close();
    await Dexie.delete(dbNameFor(configId));
});

describe('storePairing', () => {
    it('persists the device uuid, so the till can recognise its own broadcasts', async () => {
        const stored = await storePairing(db, response(), '1.2.3');

        expect(stored.info.uuid).toBe('a1b2c3d4-0000-4000-8000-000000000001');
        // …and it survives the round-trip, which is the part that matters: the uuid is read at boot
        // from IndexedDB, not from the pairing call.
        expect((await getMeta(db, META.device, null))).toMatchObject({
            uuid: 'a1b2c3d4-0000-4000-8000-000000000001',
        });
    });

    it('derives device_seq from the identifier the server actually sends', async () => {
        const stored = await storePairing(db, response({ device_identifier: 3 }), '1.2.3');

        expect(stored.info.device_seq).toBe(3);
        expect(Number.isNaN(stored.info.device_seq)).toBe(false);
    });

    it('normalises the numeric wire fields to the strings DeviceInfo declares', async () => {
        const stored = await storePairing(db, response({ id: 12, device_identifier: 3 }), '1.2.3');

        expect(stored.info.device_id).toBe('12');
        expect(stored.info.device_identifier).toBe('3');
        expect(stored.info.kind).toBe('register');
        expect(stored.info.config_id).toBe(configId);
        expect(stored.info.app_version).toBe('1.2.3');
    });

    it('never writes the raw device secret', async () => {
        await storePairing(db, response(), '1.2.3');

        const key = await getMeta<unknown>(db, META.deviceKey, null);
        expect(key).not.toBe('ab'.repeat(32));
        expect(await getMeta(db, META.deviceToken, null)).toBe('bearer-token');
    });
});

describe('the pairing payload this reads', () => {
    it('names only fields DevicePairingResource actually sends', () => {
        // The defect above was a type that described a payload the server has never produced, so it
        // is checked against the server rather than against itself.
        const source = readFileSync(
            fileURLToPath(new URL('../../../../app/Http/Resources/Pos/DevicePairingResource.php', import.meta.url)),
            'utf8',
        );
        const block = /'device' => \[([\s\S]*?)\],/.exec(source)?.[1] ?? '';

        for (const field of ['id', 'uuid', 'name', 'device_identifier', 'device_type']) {
            expect(block).toContain(`'${field}' =>`);
        }

        // The two the old type invented. If the server ever starts sending them, this test is the
        // reminder to stop deriving them.
        expect(block).not.toContain("'device_seq' =>");
        expect(block).not.toContain("'kind' =>");
    });
});
