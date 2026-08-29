import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DELTA_COALESCE_MS,
    DELTA_POLL_MS,
    REGISTER_EVENTS,
    configChannel,
    emittedByDeviceUuid,
    isSelfEcho,
    realtimeBadge,
    sessionChannel,
    startDeltaScheduler,
} from './realtime';

/**
 * BAN-402 — the register's realtime foundation.
 *
 * Two halves, and the first is the one that has actually bitten this repo. A channel or event name
 * that is wrong does not throw: Echo subscribes happily to a channel the authorizer refuses, and
 * binds happily to an event nobody broadcasts. The status badge says "connected" the whole time and
 * the till simply never hears anything. `shared/store/use-echo.ts` shipped exactly that pair of
 * mistakes — `pos.config.{numeric id}` and `.order.updated` — for as long as nobody imported them.
 *
 * So the name tests read the PHP. Asserting `configChannel(t) === 'pos.config.' + t` would only
 * prove the function is the function; asserting it against the string in `routes/channels.php` and
 * against `OrderSynced::broadcastAs()` is what fails when either side moves.
 */

function repoFile(relative: string): string {
    return readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8');
}

describe('channel names match the server authorizer', () => {
    const channels = repoFile('routes/channels.php');

    it('subscribes to the config channel the authorizer registers', () => {
        const registered = /Broadcast::channel\('(pos\.config\.\{\w+\})'/.exec(channels)?.[1];

        expect(registered).toBeDefined();
        // `{configToken}` → the actual token. A numeric config id here authorises against nothing.
        expect(configChannel('tok3n')).toBe(registered?.replace(/\{\w+\}/, 'tok3n'));
    });

    it('subscribes to the session channel the authorizer registers', () => {
        const registered = /Broadcast::channel\('(pos\.session\.\{\w+\})'/.exec(channels)?.[1];

        expect(registered).toBeDefined();
        expect(sessionChannel(12)).toBe(registered?.replace(/\{\w+\}/, '12'));
    });

    it('names the config channel by token, never by id', () => {
        // The regression that made the deleted `channels.config(configId)` helper useless.
        expect(configChannel('abc')).not.toMatch(/pos\.config\.\d+$/);
    });
});

describe('event names match the server broadcastAs', () => {
    const broadcastAs = (relative: string): string => {
        const source = repoFile(relative);
        const name = /public function broadcastAs\(\): string\s*\{\s*return '([^']+)';/.exec(source)?.[1];

        expect(name).toBeDefined();

        // Echo needs the leading dot, or it prepends the application namespace and binds to a name
        // the server never sends.
        return `.${name ?? ''}`;
    };

    it('listens for what OrderSynced broadcasts', () => {
        expect(REGISTER_EVENTS.orderSynced).toBe(broadcastAs('app/Events/Pos/OrderSynced.php'));
    });

    it('listens for what TableStateChanged broadcasts', () => {
        expect(REGISTER_EVENTS.tableState).toBe(broadcastAs('app/Events/Restaurant/TableStateChanged.php'));
    });

    it('listens for what SessionClosed broadcasts', () => {
        expect(REGISTER_EVENTS.sessionClosed).toBe(broadcastAs('app/Events/Pos/SessionClosed.php'));
    });
});

describe('the server stamps the emitting device on the events the register consumes', () => {
    // Item 2 of this ticket: `SessionClosed` and `TableStateChanged` were dispatched with the
    // argument omitted, so they shipped null and self-echo suppression could never work on them.
    it.each([
        ['app/Services/Pos/SessionService.php', 'SessionClosed'],
        ['app/Services/Restaurant/TableService.php', 'TableStateChanged'],
        ['app/Services/Pos/OrderSyncService.php', 'OrderSynced'],
    ])('%s dispatches %s with emittedByDeviceUuid', (file, event) => {
        const source = repoFile(file);
        const dispatch = new RegExp(`new ${event}\\(([\\s\\S]*?)\\)\\);`).exec(source)?.[1];

        expect(dispatch).toBeDefined();
        expect(dispatch).toContain('emittedByDeviceUuid:');
    });
});

describe('self-echo suppression', () => {
    it('reads the device uuid off the payload', () => {
        expect(emittedByDeviceUuid({ emitted_by_device_uuid: 'dev-a' })).toBe('dev-a');
        expect(emittedByDeviceUuid({ emitted_by_device_uuid: null })).toBeNull();
        expect(emittedByDeviceUuid({ emitted_by_device_uuid: '' })).toBeNull();
        expect(emittedByDeviceUuid({})).toBeNull();
        expect(emittedByDeviceUuid(null)).toBeNull();
        expect(emittedByDeviceUuid('dev-a')).toBeNull();
    });

    it('suppresses this device own echo', () => {
        expect(isSelfEcho({ emitted_by_device_uuid: 'dev-a' }, 'dev-a')).toBe(true);
    });

    it('does not suppress a peer', () => {
        expect(isSelfEcho({ emitted_by_device_uuid: 'dev-b' }, 'dev-a')).toBe(false);
    });

    it('does not suppress an unattributed event', () => {
        // A back-office close has no emitting device. Treating "unknown author" as "me" is how a
        // till stops hearing about the one thing it cannot derive for itself.
        expect(isSelfEcho({ emitted_by_device_uuid: null }, 'dev-a')).toBe(false);
        expect(isSelfEcho({}, 'dev-a')).toBe(false);
    });

    it('suppresses nothing while this device does not know its own uuid', () => {
        // An unpaired or legacy replica. Pulling too often is a cost; pulling never is a bug.
        expect(isSelfEcho({ emitted_by_device_uuid: 'dev-a' }, null)).toBe(false);
        expect(isSelfEcho({ emitted_by_device_uuid: 'dev-a' }, '')).toBe(false);
    });
});

describe('realtimeBadge', () => {
    it('reports a live socket', () => {
        expect(realtimeBadge('connected', true)).toBe('connected');
    });

    it('reports a dropped socket as off', () => {
        expect(realtimeBadge('failed', true)).toBe('off');
        expect(realtimeBadge('unavailable', true)).toBe('off');
    });

    it('reports a socket still coming up as degraded', () => {
        expect(realtimeBadge('connecting', true)).toBe('degraded');
    });

    it('reports off when broadcasting is not configured at all', () => {
        // A single-till venue. `connecting` would be a lie about a socket that will never exist.
        expect(realtimeBadge('connecting', false)).toBe('off');
        expect(realtimeBadge('connected', false)).toBe('off');
    });
});

describe('the delta scheduler', () => {
    let pulls = 0;
    let online = true;
    let paying = false;
    let resolvePull: (() => void) | null = null;

    function scheduler(overrides: { intervalMs?: number; coalesceMs?: number; block?: boolean } = {}): ReturnType<
        typeof startDeltaScheduler
    > {
        return startDeltaScheduler({
            pull: () => {
                pulls += 1;
                if (overrides.block !== true) return Promise.resolve();

                return new Promise<void>((resolve) => {
                    resolvePull = resolve;
                });
            },
            isOnline: () => online,
            isPaymentInFlight: () => paying,
            ...(overrides.intervalMs === undefined ? {} : { intervalMs: overrides.intervalMs }),
            ...(overrides.coalesceMs === undefined ? {} : { coalesceMs: overrides.coalesceMs }),
        });
    }

    beforeEach(() => {
        vi.useFakeTimers();
        pulls = 0;
        online = true;
        paying = false;
        resolvePull = null;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('pulls on its own schedule with nothing broadcast at all', async () => {
        // The whole point of the ticket: before this, `delta.pull()` ran at boot, on the manual
        // Sync-now button, and after a table op. Nothing else. A peer's order was invisible until
        // somebody pressed something.
        const running = scheduler({ intervalMs: 1000 });

        await vi.advanceTimersByTimeAsync(3500);
        expect(pulls).toBe(3);

        running.stop();
    });

    it('defaults to a 30 s sweep', () => {
        expect(DELTA_POLL_MS).toBe(30_000);
    });

    it('stops pulling once stopped', async () => {
        const running = scheduler({ intervalMs: 1000 });

        await vi.advanceTimersByTimeAsync(1500);
        running.stop();
        await vi.advanceTimersByTimeAsync(5000);

        expect(pulls).toBe(1);
    });

    it('coalesces a burst of events into one pull', async () => {
        const running = scheduler({ intervalMs: 100_000, coalesceMs: DELTA_COALESCE_MS });

        running.request();
        running.request();
        running.request();
        await vi.advanceTimersByTimeAsync(DELTA_COALESCE_MS + 1);

        expect(pulls).toBe(1);

        running.stop();
    });

    it('pulls again for an event that arrives after the burst window', async () => {
        const running = scheduler({ intervalMs: 100_000, coalesceMs: 100 });

        running.request();
        await vi.advanceTimersByTimeAsync(101);
        running.request();
        await vi.advanceTimersByTimeAsync(101);

        expect(pulls).toBe(2);

        running.stop();
    });

    it('does not pull while offline, and owes the pull', async () => {
        online = false;
        const running = scheduler({ intervalMs: 1000 });

        await vi.advanceTimersByTimeAsync(2500);
        expect(pulls).toBe(0);
        expect(running.isDeferred()).toBe(true);

        online = true;
        await vi.advanceTimersByTimeAsync(1000);
        expect(pulls).toBe(1);

        running.stop();
    });

    it('does not pull while a payment is in flight', async () => {
        // A delta landing between "paid" and "flushed" rewrites the rows `commitPaidOrder` is
        // part-way through persisting. That is a lost sale, not a stale screen.
        paying = true;
        const running = scheduler({ intervalMs: 1000 });

        await vi.advanceTimersByTimeAsync(2500);
        expect(pulls).toBe(0);

        running.stop();
    });

    it('pulls as soon as the payment finishes rather than dropping the request', async () => {
        paying = true;
        const running = scheduler({ intervalMs: 1000, coalesceMs: 10 });

        running.request();
        await vi.advanceTimersByTimeAsync(11);
        expect(pulls).toBe(0);
        expect(running.isDeferred()).toBe(true);

        paying = false;
        await vi.advanceTimersByTimeAsync(1000);
        expect(pulls).toBe(1);
        expect(running.isDeferred()).toBe(false);

        running.stop();
    });

    it('does not run two pulls at once, and re-runs once for what arrived meanwhile', async () => {
        const running = scheduler({ intervalMs: 1000, block: true });

        await vi.advanceTimersByTimeAsync(1000);
        expect(pulls).toBe(1);

        // Three more ticks while the first pull is still in flight.
        await vi.advanceTimersByTimeAsync(3000);
        expect(pulls).toBe(1);

        resolvePull?.();
        await vi.advanceTimersByTimeAsync(0);

        // Exactly one catch-up run, not one per missed tick.
        expect(pulls).toBe(2);

        resolvePull?.();
        running.stop();
    });

    it('owes the pull again when one fails', async () => {
        let attempts = 0;
        const running = startDeltaScheduler({
            pull: () => {
                attempts += 1;

                return attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve();
            },
            isOnline: () => true,
            isPaymentInFlight: () => false,
            intervalMs: 1000,
        });

        await vi.advanceTimersByTimeAsync(1000);
        // The failure schedules its own retry, so the second attempt does not wait a full interval.
        expect(attempts).toBe(2);
        expect(running.isDeferred()).toBe(false);

        running.stop();
    });

    it('ignores a request made after stop', async () => {
        const running = scheduler({ intervalMs: 1000, coalesceMs: 10 });

        running.stop();
        running.request();
        await vi.advanceTimersByTimeAsync(5000);

        expect(pulls).toBe(0);
    });
});
