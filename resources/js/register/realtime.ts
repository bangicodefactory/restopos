import type { ReverbConfig } from '@shared/store';

/**
 * Realtime for the register (REG-024, REG-365…REG-368, spec 03 §5.4).
 *
 * The register is offline-first and everything that originates *here* reaches the server through
 * the outbox. Realtime exists for the opposite direction: facts about this till that originate
 * somewhere else. There are three, and they are the whole subscription surface.
 *
 *   - `session.closed`  — a manager closed the shift on another device. A till that keeps ringing
 *                         sales into frozen summaries is a reconciliation problem that surfaces
 *                         days later. On `pos.session.{id}`, the narrowest channel that carries it.
 *   - `order.synced`    — a peer till changed an order. Without it two registers are two
 *                         independent registers and a table's bill exists twice.
 *   - `table.state`     — floor-plan occupancy moved.
 *
 * The last two are config-wide, so they arrive on `pos.config.{access_token}` — the token, not the
 * numeric id, because that is what `routes/channels.php` authorises against.
 *
 * **Events are never the transport.** Every payload here is a cache-invalidation hint; the
 * authoritative rows come back through `delta.pull()`. That single rule is what lets the till keep
 * working when the socket is down, which in a venue with a consumer router is often.
 */

export const REGISTER_EVENTS = {
    /** `SessionClosed::broadcastAs()`. */
    sessionClosed: '.session.closed',
    /** `OrderSynced::broadcastAs()` — note `synced`, not `updated`. */
    orderSynced: '.order.synced',
    /** `TableStateChanged::broadcastAs()`. */
    tableState: '.table.state',
} as const;

/** `pos.session.{id}` — every device trading in this session. */
export function sessionChannel(sessionId: number): string {
    return `pos.session.${sessionId}`;
}

/**
 * `pos.config.{access_token}` — every register and display of this config.
 *
 * The **token**, not `pos_configs.id`. `Broadcast::channel('pos.config.{configToken}')` looks the
 * config up by `access_token`, so a numeric id authorises against nothing and the subscription is
 * refused. The token reaches the client on the bootstrap config row, which `BootstrapService`
 * ships for the register profile precisely so this channel can be named.
 */
export function configChannel(accessToken: string): string {
    return `pos.config.${accessToken}`;
}

/** The device uuid the server stamped on a broadcast, or `null` when it did not stamp one. */
export function emittedByDeviceUuid(payload: unknown): string | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const value = (payload as { emitted_by_device_uuid?: unknown }).emitted_by_device_uuid;

    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Did this device emit the event it is being told about?
 *
 * Suppressing self-echo is not an optimisation: an `order.synced` for the sale this till just rang
 * would trigger a pull that overwrites the local copy the cashier is still editing.
 *
 * Unattributed events are deliberately **not** suppressed. A null `emitted_by_device_uuid` means
 * the server does not know who did it (a back-office close, a scheduled job), and treating "unknown
 * author" as "me" is how a till silently stops hearing about anything.
 */
export function isSelfEcho(payload: unknown, deviceUuid: string | null): boolean {
    if (deviceUuid === null || deviceUuid === '') return false;

    return emittedByDeviceUuid(payload) === deviceUuid;
}

/** How often the register re-pulls deltas even when nothing was broadcast. */
export const DELTA_POLL_MS = 30_000;

/** Burst window: five lines synced by a peer are five events and should be one pull. */
export const DELTA_COALESCE_MS = 400;

export type DeltaSchedulerDeps = {
    /** Runs the actual pull. Must resolve, never reject — a failed pull is a stale replica. */
    pull: () => Promise<void>;
    isOnline: () => boolean;
    /** True while a sale is being flushed and drained; a pull must not land mid-payment. */
    isPaymentInFlight: () => boolean;
    intervalMs?: number;
    coalesceMs?: number;
};

export type DeltaScheduler = {
    /** An event says something changed. Coalesced, and honours the same gates as the timer. */
    request: () => void;
    /** Is a requested pull still owed because a gate refused it? */
    isDeferred: () => boolean;
    stop: () => void;
};

/**
 * The periodic delta pull, plus the event-driven one (REG-367).
 *
 * Before this the register pulled deltas exactly three times: at boot, on the manual "Sync now"
 * button, and after a server-authoritative table op. With the socket down, a second till's order
 * was invisible until a human pressed a button.
 *
 * Two gates, both of which *defer* rather than drop:
 *
 *   - **offline** — a pull would fail anyway, and the outbox already owns the reconnect story.
 *   - **payment in flight** — `commitPaidOrder` flushes the sale to IndexedDB and drains the
 *     outbox. A delta landing inside that window rewrites rows the flush is mid-way through
 *     persisting, which is a lost sale rather than a stale one.
 *
 * A deferred request is remembered, so the next tick that finds the gates open pulls immediately
 * instead of waiting for a fresh event that may never come. Overlapping pulls are collapsed the
 * same way: a pull that arrives while one is running is remembered and re-run once, not queued.
 */
export function startDeltaScheduler(deps: DeltaSchedulerDeps): DeltaScheduler {
    const intervalMs = deps.intervalMs ?? DELTA_POLL_MS;
    const coalesceMs = deps.coalesceMs ?? DELTA_COALESCE_MS;

    let stopped = false;
    let running = false;
    let deferred = false;
    let coalesce: ReturnType<typeof setTimeout> | null = null;

    function tick(): void {
        if (stopped) return;

        if (running) {
            deferred = true;
            return;
        }
        if (!deps.isOnline() || deps.isPaymentInFlight()) {
            deferred = true;
            return;
        }

        deferred = false;
        running = true;
        void deps
            .pull()
            .catch(() => {
                // A failed pull is a stale replica, not a stopped till. Owe it again so the next
                // tick retries rather than waiting for another broadcast.
                deferred = true;
            })
            .finally(() => {
                running = false;
                if (deferred && !stopped) tick();
            });
    }

    const timer = setInterval(tick, intervalMs);

    return {
        request: (): void => {
            if (stopped || coalesce !== null) return;
            coalesce = setTimeout(() => {
                coalesce = null;
                tick();
            }, coalesceMs);
        },
        isDeferred: (): boolean => deferred,
        stop: (): void => {
            stopped = true;
            clearInterval(timer);
            if (coalesce !== null) clearTimeout(coalesce);
            coalesce = null;
        },
    };
}

/** How `useEcho`'s connection status reads on the status strip (REG-366). */
export function realtimeBadge(status: string, configured: boolean): 'connected' | 'degraded' | 'off' {
    if (!configured) return 'off';
    if (status === 'connected') return 'connected';
    // `connecting` is a socket that may yet come up; anything else is a socket that will not.
    return status === 'connecting' ? 'degraded' : 'off';
}

type ViteEnv = Record<string, string | boolean | undefined>;

function str(value: string | boolean | undefined): string {
    return typeof value === 'string' ? value : '';
}

/**
 * Reverb connection details, or null when broadcasting is not configured.
 *
 * Null is an ordinary outcome, not a failure: a single-till venue has no siblings to hear from, and
 * `useEcho` reports `unavailable` and leaves the register working exactly as it always has.
 */
export function reverbConfig(token: string | null): ReverbConfig | null {
    const env = (import.meta.env ?? {}) as ViteEnv;
    const key = str(env['VITE_REVERB_APP_KEY']);
    if (key === '') return null;

    const scheme = str(env['VITE_REVERB_SCHEME']) === 'https' ? 'https' : 'http';
    const host = str(env['VITE_REVERB_HOST']) || globalThis.location?.hostname || 'localhost';
    const port = Number.parseInt(str(env['VITE_REVERB_PORT']) || '8080', 10);

    return {
        key,
        host,
        port: Number.isFinite(port) ? port : 8080,
        scheme,
        // A private channel, so `/broadcasting/auth` needs the device's bearer token — a register is
        // a paired device, not an anonymous customer.
        token,
        enabled: true,
    };
}
