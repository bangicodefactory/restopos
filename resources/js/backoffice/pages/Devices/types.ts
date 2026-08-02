/**
 * `Devices/Index` props — spec 05 §12 / §12.1, spec 03 §2.2.
 *
 * Pairing codes are minted per **config**, not per device: `POST /pos-configs/{config}/pairing-codes`
 * answers with JSON rather than a redirect, so it is the one write on this screen that goes
 * through `lib/http` instead of an Inertia visit.
 */

export type DeviceRow = {
    id: number;
    uuid: string;
    name: string | null;
    device_identifier: number;
    device_type: string;
    pos_config_id: number;
    pos_config_name: string | null;
    last_seen_at: string | null;
    last_synced_at: string | null;
    user_agent: string | null;
    active: boolean;
};

export type DeviceConfigOption = {
    id: number;
    uuid: string;
    name: string;
};

export type DevicesIndexProps = {
    devices: DeviceRow[];
    configs: DeviceConfigOption[];
};

/** `DevicePairingService::createCode()` — the JSON body of the pairing endpoint. */
export type PairingCodeResponse = {
    code: string;
    expires_at: string;
    ttl_seconds: number;
};

export const DEVICE_TYPE_LABEL: Record<string, string> = {
    register: 'Caisse',
    kiosk: 'Borne',
    customer_display: 'Écran client',
    self_mobile: 'Commande mobile',
    prep_display: 'Écran cuisine',
};

export const DEVICE_TYPES: readonly string[] = [
    'register',
    'kiosk',
    'customer_display',
    'self_mobile',
    'prep_display',
];

/**
 * How stale a device is, from `last_seen_at`.
 *
 * A till that has not called home in a day is not necessarily broken — it may simply be a
 * Sunday — so the thresholds are coarse and the label says "vu il y a…", never "hors ligne".
 * Claiming a device is offline from a timestamp this page cannot refresh would be a guess
 * dressed as a fact.
 */
export function freshnessOf(
    lastSeen: string | null,
    now = Date.now(),
): 'live' | 'recent' | 'stale' | 'never' {
    if (!lastSeen) return 'never';
    const ms = Date.parse(lastSeen.includes(' ') && !lastSeen.includes('T') ? lastSeen.replace(' ', 'T') : lastSeen);
    if (Number.isNaN(ms)) return 'never';
    const age = now - ms;
    if (age < 5 * 60_000) return 'live';
    if (age < 24 * 3_600_000) return 'recent';
    return 'stale';
}

export const FRESHNESS_TONE: Record<string, 'ok' | 'info' | 'warn' | 'neutral'> = {
    live: 'ok',
    recent: 'info',
    stale: 'warn',
    never: 'neutral',
};

/** A shortened user agent: the browser and platform, not the forty-character token soup. */
export function shortUserAgent(userAgent: string | null): string {
    if (!userAgent) return '—';
    const browser = /(Firefox|Edg|Chrome|Safari)\/[\d.]+/.exec(userAgent)?.[1];
    const platform = /\(([^;)]+)/.exec(userAgent)?.[1];
    if (browser && platform) return `${browser} · ${platform.trim()}`;
    return userAgent.length > 48 ? `${userAgent.slice(0, 47)}…` : userAgent;
}
