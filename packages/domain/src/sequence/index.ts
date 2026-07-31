import type { DeviceInfo } from '../types';

/**
 * Offline-safe reference generation (spec 03 §6).
 *
 * Three numbers that are routinely conflated and have different requirements:
 *
 *   | Number                  | Offline | Gapless | Scope        | Authority |
 *   |-------------------------|---------|---------|--------------|-----------|
 *   | Order reference         | yes     | no      | global       | client    |
 *   | Tracking number         | yes     | no      | per session  | client    |
 *   | Receipt / portal token  | yes     | no      | global       | client    |
 *   | Session sequence number | no      | **yes** | per session  | server    |
 *   | Invoice number          | no      | **yes** | per journal  | server    |
 *
 * Only the client-authoritative ones live here. Collision avoidance is structural: `device_seq` is
 * allocated by the server under a row lock at pairing and is unique per config, so two devices can
 * never mint the same reference. There is no recycling of abandoned counters — a gap in a
 * non-legal reference is harmless, reuse is not.
 */

/** The tiny slice of persistent storage the generator needs. Injected, never imported. */
export type CounterStore = {
    /** Atomically increment and return the new value. Must be durable before it resolves. */
    increment(key: string): Promise<number>;
    get(key: string): Promise<number | null>;
    set(key: string, value: number): Promise<void>;
};

export const SEQ_ORDER = 'seq.order';

/** Source of randomness. Injected so tests are deterministic. */
export type RandomSource = (bytes: number) => Uint8Array;

export const cryptoRandom: RandomSource = (bytes: number): Uint8Array => {
    const out = new Uint8Array(bytes);
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
        globalThis.crypto.getRandomValues(out);
        return out;
    }
    for (let i = 0; i < bytes; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
};

/** Two-digit year — protects the counter against reuse after a device wipe across a year boundary. */
function yy(now: Date): string {
    return String(now.getFullYear() % 100).padStart(2, '0');
}

/**
 * `26D03-3-000412` — `{YY}D{deviceSeq:02}-{configId}-{counter:06}`.
 *
 * Pure formatting so it can be unit-tested without a store; `nextOrderReference` is the stateful
 * wrapper.
 */
export function formatOrderReference(device: Pick<DeviceInfo, 'device_seq' | 'config_id'>, counter: number, now = new Date()): string {
    return [
        `${yy(now)}D${String(device.device_seq).padStart(2, '0')}`,
        String(device.config_id),
        String(counter).padStart(6, '0'),
    ].join('-');
}

export async function nextOrderReference(
    store: CounterStore,
    device: Pick<DeviceInfo, 'device_seq' | 'config_id'>,
    now = new Date(),
): Promise<{ reference: string; counter: number }> {
    const counter = await store.increment(SEQ_ORDER);
    return { reference: formatOrderReference(device, counter, now), counter };
}

/** Letter prefix shouted across the counter. Kiosk is `K`, mobile self-order `S` (Odoo's convention). */
export type TrackingPrefixSource = 'pos' | 'kiosk' | 'mobile';

export function devicePrefix(deviceSeq: number, source: TrackingPrefixSource = 'pos'): string {
    if (source === 'kiosk') return 'K';
    if (source === 'mobile') return 'S';
    // A..Z by device; wraps at 26, which is far beyond any real venue's till count.
    return String.fromCharCode(65 + ((deviceSeq - 1 + 26) % 26));
}

/**
 * The 2–3 digit number on the buzzer. `counter % 1000`, optionally letter-prefixed when the config
 * has more than one register (otherwise device 1's #412 and device 2's #412 collide audibly).
 */
export function formatTrackingNumber(
    counter: number,
    options: { deviceSeq: number; source?: TrackingPrefixSource; multiDevice?: boolean } ,
): string {
    const digits = String(((counter % 1000) + 1000) % 1000).padStart(3, '0');
    const source = options.source ?? 'pos';
    if (source !== 'pos' || options.multiDevice === true) {
        return `${devicePrefix(options.deviceSeq, source)}${digits}`;
    }
    return digits;
}

/**
 * Receipt / portal token: 5 characters from an unambiguous alphabet (no 0/O/1/I) — 32⁵ ≈ 33.5 M.
 * Collisions are resolved server-side by a unique index; the printed token stays valid as an alias.
 */
export const TOKEN_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateReceiptToken(random: RandomSource = cryptoRandom, length = 5): string {
    // Rejection-free because the alphabet length (32) divides 256 exactly.
    const bytes = random(length);
    let out = '';
    for (let i = 0; i < length; i++) {
        out += TOKEN_ALPHABET[(bytes[i] ?? 0) % TOKEN_ALPHABET.length];
    }
    return out;
}

/** RFC 4122 v4, from the injected randomness source (no `crypto.randomUUID` dependency). */
export function generateUuid(random: RandomSource = cryptoRandom): string {
    const b = random(16);
    b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
    b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
    const hex: string[] = [];
    for (let i = 0; i < 16; i++) hex.push((b[i] ?? 0).toString(16).padStart(2, '0'));
    return [
        hex.slice(0, 4).join(''),
        hex.slice(4, 6).join(''),
        hex.slice(6, 8).join(''),
        hex.slice(8, 10).join(''),
        hex.slice(10, 16).join(''),
    ].join('-');
}

/**
 * In-memory counter store — the default for tests and for the customer display, which never mints
 * references. Real clients pass the Dexie-backed store from `@shared/db`.
 */
export function createMemoryCounterStore(initial: Record<string, number> = {}): CounterStore {
    const values = new Map<string, number>(Object.entries(initial));
    return {
        async increment(key) {
            const next = (values.get(key) ?? 0) + 1;
            values.set(key, next);
            return next;
        },
        async get(key) {
            return values.get(key) ?? null;
        },
        async set(key, value) {
            values.set(key, value);
        },
    };
}
