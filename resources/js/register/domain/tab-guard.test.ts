/**
 * One writer per register (REG-374, BAN-405).
 *
 * The failure being prevented is two tabs draining one outbox, so the properties worth asserting
 * are the ones that let that happen: two leaders at once, a leader that crashes and is never
 * replaced, and a guard that locks the till out when it cannot ask the question at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTabGuard, tabChannelName, type TabRole } from './tab-guard';

/** An in-memory BroadcastChannel: every channel on a name delivers to the others, not to itself. */
function makeBus() {
    type Peer = { onmessage: ((e: { data: never }) => void) | null };
    const channels = new Map<string, Set<Peer>>();

    return {
        factory(name: string) {
            const peers = channels.get(name) ?? new Set<Peer>();
            channels.set(name, peers);

            const channel = {
                onmessage: null as ((e: { data: never }) => void) | null,
                postMessage(message: unknown): void {
                    for (const peer of peers) {
                        if (peer !== channel && peer.onmessage) peer.onmessage({ data: message as never });
                    }
                },
                close(): void {
                    peers.delete(channel);
                },
            };

            peers.add(channel);

            return channel as never;
        },
        names: () => [...channels.keys()],
    };
}

let clock = 1_000;
const now = (): number => clock;

function openTab(bus: ReturnType<typeof makeBus>, tabId: string, seen: Record<string, TabRole[]> = {}) {
    const roles: TabRole[] = [];
    seen[tabId] = roles;

    const guard = createTabGuard({
        configId: 7,
        tabId,
        now,
        channelFactory: bus.factory,
        heartbeatMs: 1_000,
        takeoverMs: 5_000,
        onRoleChange: (role) => roles.push(role),
    });

    return guard;
}

beforeEach(() => {
    clock = 1_000;
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('tab election', () => {
    it('makes a lone tab the writer', () => {
        const guard = openTab(makeBus(), 'a');

        expect(guard.role).toBe('leader');
        guard.stop();
    });

    it('leaves exactly one writer when a second tab opens', () => {
        const bus = makeBus();
        const first = openTab(bus, 'a');
        clock += 100;
        const second = openTab(bus, 'b');

        expect(first.role).toBe('leader');
        expect(second.role).toBe('follower');

        first.stop();
        second.stop();
    });

    it('demotes a tab that opened first but heard about an earlier one late', () => {
        // Two tabs restored together by a browser session: the later-claiming tab may still hold
        // the earlier `since`. Whoever started first must win regardless of who spoke first.
        const bus = makeBus();
        clock = 5_000;
        const late = openTab(bus, 'a');
        expect(late.role).toBe('leader');

        clock = 1_000; // an older tab joins, claiming an earlier start
        const early = openTab(bus, 'b');

        expect(early.role).toBe('leader');
        expect(late.role).toBe('follower');

        late.stop();
        early.stop();
    });

    it('breaks a dead-heat deterministically rather than seating two writers', () => {
        const bus = makeBus();
        const a = openTab(bus, 'aaa');
        const b = openTab(bus, 'bbb'); // identical `since`

        const leaders = [a, b].filter((g) => g.role === 'leader');
        expect(leaders).toHaveLength(1);
        expect(a.role).toBe('leader'); // lower id wins, and both sides agree on which

        a.stop();
        b.stop();
    });

    it('promotes a follower the moment the leader stands down', () => {
        const bus = makeBus();
        const first = openTab(bus, 'a');
        clock += 100;
        const second = openTab(bus, 'b');

        first.release();

        // Instant: a deliberate handover must not cost the takeover delay.
        expect(second.role).toBe('leader');
        expect(first.role).toBe('follower');

        first.stop();
        second.stop();
    });

    it('takes over when the leader dies without releasing', () => {
        const bus = makeBus();
        const first = openTab(bus, 'a');
        clock += 100;
        const second = openTab(bus, 'b');
        expect(second.role).toBe('follower');

        // The leader's tab is killed: no release, no further heartbeats. Only silence.
        first.stop(); // its channel closes with it; no release reaches anyone after this

        clock += 6_000;
        vi.advanceTimersByTime(6_000);

        expect(second.role).toBe('leader');
        second.stop();
    });

    it('does not take over while the leader is still renewing its lease', () => {
        const bus = makeBus();
        const first = openTab(bus, 'a');
        clock += 100;
        const second = openTab(bus, 'b');

        // Well past the takeover window, but the leader is alive and heartbeating throughout.
        for (let tick = 0; tick < 12; tick += 1) {
            clock += 1_000;
            vi.advanceTimersByTime(1_000);
        }

        expect(second.role).toBe('follower');
        expect(first.role).toBe('leader');

        first.stop();
        second.stop();
    });

    it('works when the browser has no BroadcastChannel at all', () => {
        // Failing closed here would mean a till that refuses to sell because it cannot ask whether
        // it is alone — worse than the duplicate the guard exists to prevent.
        const guard = createTabGuard({ configId: 7, tabId: 'a', now, channelFactory: () => null });

        expect(guard.role).toBe('leader');
        guard.stop();
    });

    it('keys the channel on the config, so two venues on one machine do not contend', () => {
        expect(tabChannelName(7)).toBe('pos.register.tabs.7');
        expect(tabChannelName(8)).not.toBe(tabChannelName(7));
    });
});
