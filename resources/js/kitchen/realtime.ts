import type { ReverbConfig } from '@shared/store';

/**
 * Realtime wiring for the kitchen (KDS-015).
 *
 * The channel and event names come from `docs/spec/05-api-contract.md` §11.2 / §11.3, which is the
 * normative document. They deliberately differ from the helpers exported by `@shared/store`
 * (`channels.prepDisplay(id)` → `prep.display.{id}`, and no `kitchen.ticket.*` in the `events`
 * map) — that helper predates the contract. Coding against the contract is the rule; the drift is
 * reported, not worked around silently.
 *
 * `broadcastAs` names are prefixed with `.` when subscribing so Echo does not prepend the
 * application namespace.
 */

export const KITCHEN_EVENTS = {
    ticketCreated: '.kitchen.ticket.created',
    ticketUpdated: '.kitchen.ticket.updated',
} as const;

/** Private channel scoped to one screen: `kitchen.display.{displayToken}`. */
export function kitchenChannel(displayToken: string): string {
    return `kitchen.display.${displayToken}`;
}

type ViteEnv = Record<string, string | boolean | undefined>;

/**
 * `null` when Reverb is not configured for this deployment — the caller then runs on the polling
 * path alone, which is a supported mode rather than a degraded one: "a kitchen that silently
 * misses orders is far worse than one that knows it is blind".
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
        token,
        authEndpoint: '/broadcasting/auth',
        enabled: token !== null,
    };
}

function str(value: string | boolean | undefined): string {
    return typeof value === 'string' ? value : '';
}

/** How often the board is re-pulled when the socket is unavailable. */
export const POLL_INTERVAL_MS = 12_000;

/** …and how often even a healthy socket re-pulls, as a safety net against missed frames. */
export const HEARTBEAT_INTERVAL_MS = 60_000;
