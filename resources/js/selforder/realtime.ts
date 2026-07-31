import type { ReverbConfig } from '@shared/store';

import type { SelfOrderStatus, TrackingStep } from './types';

/**
 * Realtime for an anonymous customer (SLF-082, SLF-083, SLF-026).
 *
 * Two **public** channels, and their publicness is deliberate: *the channel name is the
 * capability*. Knowing `pos.order.{accessToken}` is knowing the order's secret, which is exactly
 * the property we want for a customer with no account and no login. Nothing sensitive — costs,
 * margins, other people's orders — is ever emitted on them (spec §11.2).
 *
 * Names come from `docs/spec/05-api-contract.md` §11.2/§11.3, not from `@shared/store`'s `channels`
 * helper, which predates the contract and names these differently.
 */

export const SELF_ORDER_EVENTS = {
    /** Live menu availability — 86'ing an item updates every open menu (SLF-026). */
    catalogChanged: '.catalog.changed',
    orderState: '.order.state',
    paymentStatus: '.payment.status',
    selfOrderPlaced: '.selforder.placed',
} as const;

/** `pos.self.{configToken}` — every phone looking at this venue's menu. */
export function menuChannel(configToken: string): string {
    return `pos.self.${configToken}`;
}

/** `pos.order.{orderAccessToken}` — exactly one customer's order. */
export function orderChannel(accessToken: string): string {
    return `pos.order.${accessToken}`;
}

type ViteEnv = Record<string, string | boolean | undefined>;

export function reverbConfig(): ReverbConfig | null {
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
        // Public channels have no auth callback (spec §15) — a customer has no token to present.
        token: null,
        enabled: true,
    };
}

function str(value: string | boolean | undefined): string {
    return typeof value === 'string' ? value : '';
}

/** How often the order status is re-pulled when the socket is unavailable. */
export const STATUS_POLL_MS = 10_000;

/**
 * Map the server's two state fields onto the ladder a customer understands (SLF-083).
 *
 * `state` is the *commercial* state (draft → paid → done) and `prep_state` is the *kitchen* state.
 * A customer cares about neither in isolation: "paid" is not "ready", and "draft" with the kitchen
 * cooking is very much not "we haven't started". Cancellation trumps everything.
 */
export function trackingStep(order: Pick<SelfOrderStatus, 'state' | 'prep_state'>): TrackingStep {
    if (order.state === 'cancelled') return 'cancelled';

    switch (order.prep_state) {
        case 'ready':
            return 'ready';
        case 'served':
        case 'done':
            return 'done';
        case 'in_progress':
        case 'preparing':
            return 'preparing';
        default:
            break;
    }

    if (order.state === 'done') return 'done';
    return 'received';
}

export const TRACKING_ORDER: readonly TrackingStep[] = ['received', 'preparing', 'ready'];
