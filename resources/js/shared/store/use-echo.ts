import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
import { useEffect, useRef, useState } from 'react';

/**
 * Realtime over Laravel Reverb (spec 03 §5), with an explicit degradation path.
 *
 * What realtime is **not** for: it is never the transport for order data. Every event carries an
 * identifier and a hint; the client then pulls the authoritative rows through the delta endpoint.
 * That single rule is what lets the whole system keep working when the socket is down — which, in a
 * venue with a consumer router and forty phones on the guest Wi-Fi, is often.
 *
 * Degradation ladder:
 *   1. WebSocket connected → events drive `pull()` immediately.
 *   2. Socket down → the caller's `onDegraded` starts a polling timer (default 20 s).
 *   3. No network at all → the outbox and IndexedDB carry the shift; nothing here is required.
 */

export type EchoStatus = 'idle' | 'connecting' | 'connected' | 'unavailable' | 'failed';

export type ReverbConfig = {
    key: string;
    host: string;
    port: number;
    scheme: 'http' | 'https';
    /** Bearer token for `/broadcasting/auth` — devices authenticate with Sanctum, not cookies. */
    token: string | null;
    authEndpoint?: string;
    enabled?: boolean;
};

type EchoInstance = Echo<'reverb'>;

let shared: EchoInstance | null = null;

/**
 * One Echo instance per document. Two would open two sockets and double every event, which is
 * exactly the bug that makes kitchen tickets print twice.
 */
export function getEcho(config: ReverbConfig): EchoInstance | null {
    if (config.enabled === false) return null;
    if (shared) return shared;

    // laravel-echo expects Pusher on the global in the browser build.
    (globalThis as unknown as { Pusher: typeof Pusher }).Pusher = Pusher;

    shared = new Echo<'reverb'>({
        broadcaster: 'reverb',
        key: config.key,
        wsHost: config.host,
        wsPort: config.port,
        wssPort: config.port,
        forceTLS: config.scheme === 'https',
        enabledTransports: ['ws', 'wss'],
        disableStats: true,
        // Reconnect aggressively: an unattended till has nobody to press refresh.
        activityTimeout: 30_000,
        pongTimeout: 10_000,
        authEndpoint: config.authEndpoint ?? '/broadcasting/auth',
        auth: {
            headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
        },
    });

    return shared;
}

export function disconnectEcho(): void {
    shared?.disconnect();
    shared = null;
}

export type UseEchoOptions = {
    config: ReverbConfig | null;
    channel: string | null;
    /** `private` for device/config channels, `public` for the self-order menu. */
    visibility?: 'public' | 'private' | 'presence';
    events: Record<string, (payload: unknown) => void>;
    /** Called when the socket is not usable, so the caller can start polling instead. */
    onDegraded?: (degraded: boolean) => void;
};

/**
 * Subscribe to one channel for the lifetime of the component.
 *
 * The event map is read through a ref, so handlers can close over fresh state without tearing the
 * subscription down and up on every render (which would drop events).
 */
export function useEcho(options: UseEchoOptions): EchoStatus {
    const [status, setStatus] = useState<EchoStatus>('idle');
    const handlersRef = useRef(options.events);
    handlersRef.current = options.events;

    const { config, channel, visibility = 'private', onDegraded } = options;

    useEffect(() => {
        if (!config || !channel || config.enabled === false) {
            setStatus('unavailable');
            onDegraded?.(true);
            return;
        }

        let echo: EchoInstance | null = null;
        try {
            echo = getEcho(config);
        } catch {
            setStatus('failed');
            onDegraded?.(true);
            return;
        }
        if (!echo) {
            setStatus('unavailable');
            onDegraded?.(true);
            return;
        }

        setStatus('connecting');

        const subscription =
            visibility === 'private'
                ? echo.private(channel)
                : visibility === 'presence'
                  ? echo.join(channel)
                  : echo.channel(channel);

        const names = Object.keys(handlersRef.current);
        for (const name of names) {
            subscription.listen(name, (payload: unknown) => handlersRef.current[name]?.(payload));
        }

        // pusher-js connection state, surfaced so the StatusBar can show a real badge.
        const connector = echo.connector as unknown as {
            pusher?: { connection?: { bind(event: string, cb: () => void): void; unbind(event: string, cb: () => void): void } };
        };
        const connection = connector.pusher?.connection;

        const onConnected = (): void => {
            setStatus('connected');
            onDegraded?.(false);
        };
        const onDisconnected = (): void => {
            setStatus('failed');
            onDegraded?.(true);
        };

        connection?.bind('connected', onConnected);
        connection?.bind('unavailable', onDisconnected);
        connection?.bind('failed', onDisconnected);
        connection?.bind('disconnected', onDisconnected);

        return () => {
            connection?.unbind('connected', onConnected);
            connection?.unbind('unavailable', onDisconnected);
            connection?.unbind('failed', onDisconnected);
            connection?.unbind('disconnected', onDisconnected);
            echo?.leave(channel);
        };
    }, [config, channel, visibility, onDegraded]);

    return status;
}

/**
 * The degradation timer. Runs `poll` every `intervalMs` while `degraded` is true, and once
 * immediately on the transition — a reconnect must not wait a full interval to catch up.
 */
export function usePollingFallback(degraded: boolean, poll: () => void, intervalMs = 20_000): void {
    const pollRef = useRef(poll);
    pollRef.current = poll;

    useEffect(() => {
        if (!degraded) return;
        pollRef.current();
        const timer = setInterval(() => {
            if (globalThis.document?.visibilityState === 'hidden') return;
            pollRef.current();
        }, intervalMs);
        return () => clearInterval(timer);
    }, [degraded, intervalMs]);
}

/** Channel names, in one place so the server and the three clients cannot drift. */
export const channels = {
    config: (configId: number): string => `pos.config.${configId}`,
    device: (deviceId: string): string => `pos.device.${deviceId}`,
    session: (sessionId: number): string => `pos.session.${sessionId}`,
    prepDisplay: (displayId: number): string => `prep.display.${displayId}`,
    order: (uuid: string): string => `pos.order.${uuid}`,
} as const;

/** Event names broadcast by the server (spec 03 §5.4). */
export const events = {
    catalogChanged: '.catalog.changed',
    orderUpdated: '.order.updated',
    orderPaid: '.order.paid',
    tableUpdated: '.table.updated',
    prepOrderChanged: '.prep.order.changed',
    deviceRevoked: '.device.revoked',
    customerDisplayUpdate: '.customer_display.update',
    paymentStatus: '.payment.status',
    sessionClosed: '.session.closed',
} as const;
