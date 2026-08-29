import { clearPairing, loadDevice, storePairing } from '@shared/auth';
import { META, getDb, getMeta, setMeta, type PosDb } from '@shared/db';
import type { Locale } from '@shared/i18n';

import type { PairResponse } from './api';
import type { BoardLayout } from './logic/board';
import type { KitchenBoardResponse, KitchenPairing, QueuedAction } from './types';

/**
 * Everything the display remembers across a reboot (KDS-001, KDS-020).
 *
 * "Survive a browser restart without losing state" is a hard requirement: these screens are
 * unattended, they hang on a wall, and the tablet they run on reboots when the extractor fan trips
 * the socket. So the board snapshot, the unsent queue and the operator's preferences all live in
 * IndexedDB through `@shared/db` — the same Dexie database the register uses, keyed by config.
 *
 * ── The one exception, and why ──────────────────────────────────────────────────────────────
 * `getDb()` is keyed by **config id**, and the config id is only learned from the pairing
 * response. That is a genuine chicken-and-egg on a cold boot: we cannot open the database that
 * holds the device token without already knowing which database to open.
 *
 * The pointer — a bare integer, no secret — is therefore kept in `localStorage`. The device token,
 * the HMAC key and every order-bearing byte stay in IndexedDB exactly as
 * `docs/CONVENTIONS.md` requires; what is in `localStorage` is the equivalent of a filename.
 */

const CONFIG_POINTER = 'restopos.kitchen.config_id';

function keyFor(displayToken: string): { board: string; queue: string } {
    return { board: `kds.board.${displayToken}`, queue: `kds.queue.${displayToken}` };
}

const KEY = {
    display: 'kds.display',
    prefs: 'kds.prefs',
} as const;

export function readConfigPointer(): number | null {
    try {
        const raw = globalThis.localStorage?.getItem(CONFIG_POINTER);
        const value = raw === null || raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
        return Number.isInteger(value) ? value : null;
    } catch {
        // Private mode, or storage disabled. The display can still run; it just re-pairs on boot.
        return null;
    }
}

export function writeConfigPointer(configId: number): void {
    try {
        globalThis.localStorage?.setItem(CONFIG_POINTER, String(configId));
    } catch {
        /* non-fatal */
    }
}

export function clearConfigPointer(): void {
    try {
        globalThis.localStorage?.removeItem(CONFIG_POINTER);
    } catch {
        /* non-fatal */
    }
}

export function openDb(configId: number): PosDb {
    return getDb(configId);
}

/**
 * Persist the pairing.
 *
 * `@shared/auth`'s `storePairing` is the canonical writer, but its `PairingResponse` type predates
 * the shipped `/api/devices/pair` contract (`device.device_seq` / flat `config_id` vs the spec's
 * `device.device_identifier` / nested `config`). We adapt rather than duplicate, so the device
 * record, the token and the non-extractable HMAC key all land through the shared path.
 *
 * The HMAC import needs `crypto.subtle`, which is absent on a plain-HTTP LAN address. A kitchen
 * display never verifies a PIN, so that failure is downgraded: the token is written directly and
 * the screen works.
 */
export async function persistPairing(
    response: PairResponse,
    appVersion: string,
): Promise<KitchenPairing> {
    const configId = response.config.id;
    writeConfigPointer(configId);
    const db = openDb(configId);

    const pairing: KitchenPairing = {
        configId,
        deviceToken: response.token,
        deviceUuid: response.device.uuid,
        deviceName: response.device.name,
    };

    try {
        await storePairing(
            db,
            {
                device: {
                    id: String(response.device.id),
                    uuid: response.device.uuid,
                    name: response.device.name,
                    device_seq: response.device.device_identifier,
                    device_identifier: String(response.device.device_identifier),
                    kind: 'prep_display',
                },
                token: response.token,
                device_secret: response.device_secret,
                config_id: configId,
                server_time: response.server_time,
                min_client_version: response.min_client_version,
            },
            appVersion,
        );
    } catch {
        await setMeta(db, META.deviceToken, response.token);
        await setMeta(db, META.device, {
            device_id: String(response.device.id),
            device_identifier: String(response.device.device_identifier),
            device_seq: response.device.device_identifier,
            config_id: configId,
            name: response.device.name,
            kind: 'prep_display',
            app_version: appVersion,
        });
    }

    return pairing;
}

export async function loadPairing(): Promise<KitchenPairing | null> {
    const configId = readConfigPointer();
    if (configId === null) return null;
    const stored = await loadDevice(openDb(configId));
    if (!stored) return null;
    return {
        configId,
        deviceToken: stored.token,
        deviceUuid: stored.info.device_id,
        deviceName: stored.info.name,
    };
}

export async function forgetPairing(configId: number): Promise<void> {
    await clearPairing(openDb(configId));
    await setMeta(openDb(configId), KEY.display, null);
    clearConfigPointer();
}

// ─────────────────────────────────────────────────────────────────────────────
// Selected display
// ─────────────────────────────────────────────────────────────────────────────

export type SelectedDisplay = { token: string; id: number | null; name: string };

export async function saveSelectedDisplay(configId: number, display: SelectedDisplay): Promise<void> {
    await setMeta(openDb(configId), KEY.display, display);
}

export async function loadSelectedDisplay(configId: number): Promise<SelectedDisplay | null> {
    return getMeta<SelectedDisplay | null>(openDb(configId), KEY.display, null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Board snapshot & unsent queue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The board snapshot is stored whole rather than shredded into the `prepOrders` / `prepOrderLines`
 * Dexie tables on purpose. Those tables are typed for the register's projection
 * (`order_reference`, numeric `quantity`, `attributes[]`) and cannot represent what the kitchen
 * endpoint returns (`table_label`, `guest_count`, `age_seconds`, `change_type`, per-line
 * timestamps). Writing a lossy projection and reading it back on a cold boot would silently drop
 * the cancelled-line highlight and the course headers — the two things the cook most needs.
 */
export async function saveBoard(
    configId: number,
    displayToken: string,
    board: KitchenBoardResponse,
): Promise<void> {
    await setMeta(openDb(configId), keyFor(displayToken).board, { ...board, cachedAt: Date.now() });
}

export async function loadBoard(
    configId: number,
    displayToken: string,
): Promise<(KitchenBoardResponse & { cachedAt?: number }) | null> {
    return getMeta<(KitchenBoardResponse & { cachedAt?: number }) | null>(
        openDb(configId),
        keyFor(displayToken).board,
        null,
    );
}

export async function saveQueue(
    configId: number,
    displayToken: string,
    queue: readonly QueuedAction[],
): Promise<void> {
    await setMeta(openDb(configId), keyFor(displayToken).queue, queue);
}

export async function loadQueue(configId: number, displayToken: string): Promise<QueuedAction[]> {
    const queue = await getMeta<QueuedAction[] | null>(openDb(configId), keyFor(displayToken).queue, null);
    return Array.isArray(queue) ? queue : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Operator preferences
// ─────────────────────────────────────────────────────────────────────────────

export type KitchenPrefs = {
    locale: Locale | null;
    muted: boolean;
    /** `null` follows the display's configured layout; anything else overrides it for this screen. */
    layout: BoardLayout | null;
    categoryIds: number[];
    lateOnly: boolean;
};

export const DEFAULT_PREFS: KitchenPrefs = {
    locale: null,
    muted: false,
    layout: null,
    categoryIds: [],
    lateOnly: false,
};

export async function loadPrefs(configId: number): Promise<KitchenPrefs> {
    const stored = await getMeta<Partial<KitchenPrefs> | null>(openDb(configId), KEY.prefs, null);
    return { ...DEFAULT_PREFS, ...(stored ?? {}) };
}

export async function savePrefs(configId: number, prefs: KitchenPrefs): Promise<void> {
    await setMeta(openDb(configId), KEY.prefs, prefs);
}
