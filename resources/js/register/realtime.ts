import type { ReverbConfig } from '@shared/store';

/**
 * Realtime for the register (REG-024, spec 03 §5.4).
 *
 * The register is offline-first and everything that *matters* reaches it through the outbox, so it
 * has never subscribed to anything — the kitchen and the self-order apps were the only consumers.
 * There is one thing the outbox cannot carry, though: a fact about the till that originates
 * somewhere else. A session closed on the manager's device is exactly that, and a second till that
 * does not hear about it keeps ringing sales into a session whose summaries have already been
 * frozen.
 *
 * Deliberately a **session** channel rather than the config one. `SessionClosed` broadcasts on both,
 * and the register knows its session id while the config's `access_token` is not in the replica at
 * all. `pos.session.{id}` is also the narrower subscription: this till only wants news about the
 * session it is actually trading in.
 */

export const REGISTER_EVENTS = {
    sessionClosed: '.session.closed',
} as const;

/** `pos.session.{id}` — every device trading in this session. */
export function sessionChannel(sessionId: number): string {
    return `pos.session.${sessionId}`;
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
