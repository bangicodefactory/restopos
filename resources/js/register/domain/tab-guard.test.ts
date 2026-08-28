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

            // A closed channel is silent in BOTH directions. Removing it from the peer set is not
            // enough: `postMessage` closes over that set, so a "crashed" tab went on heartbeating
            // to everyone and the watchdog was never reached. That flaw is exactly why four
            // sabotages of the lease survived the first pass.
            let closed = false;

            const channel = {
                onmessage: null as ((e: { data: never }) => void) | null,
                postMessage(message: unknown): void {
                    if (closed) return;
                    for (const peer of peers) {
                        if (peer !== channel && peer.onmessage) peer.onmessage({ data: message as never });
                    }
                },
                close(): void {
                    closed = true;
                    channel.onmessage = null;
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

function openTab(bus: ReturnType<typeof makeBus>, tabId: string) {
    const roles: TabRole[] = [];
    let own: { close(): void } | null = null;

    const guard = createTabGuard({
        configId: 7,
        tabId,
        now,
        channelFactory: (name) => {
            const channel = bus.factory(name);
            own = channel as unknown as { close(): void };

            return channel;
        },
        heartbeatMs: 1_000,
        takeoverMs: 5_000,
        onRoleChange: (role) => roles.push(role),
    });

    return {
        guard,
        /** Every role this tab was ever assigned, so a promote-then-demote flap is visible. */
        roles,
        /**
         * The tab's process is gone: no release, no further heartbeats, nothing.
         *
         * `guard.stop()` is NOT this — it politely posts a release on the way out, so a test that
         * used it to simulate a crash would be exercising the handover path and never the
         * watchdog. That mistake is what let four sabotages of the lease survive.
         */
        crash: () => own?.close(),
    };
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
        const { guard } = openTab(makeBus(), 'a');

        expect(guard.role).toBe('leader');
        guard.stop();
    });

    it('leaves exactly one writer when a second tab opens', () => {
        const bus = makeBus();
        const first = openTab(bus, 'a');
        clock += 100;
        const second = openTab(bus, 'b');

        expect(first.guard.role).toBe('leader');
        expect(second.guard.role).toBe('follower');

        first.guard.stop();
        second.guard.stop();
    });

    it('demotes a tab that opened first but heard about an earlier one late', () => {
        // Two tabs restored together by a browser session: the later-claiming tab may still hold
        // the earlier `since`. Whoever started first must win regardless of who spoke first.
        const bus = makeBus();
        clock = 5_000;
        const late = openTab(bus, 'a');
        expect(late.guard.role).toBe('leader');

        clock = 1_000; // an older tab joins, claiming an earlier start
        const early = openTab(bus, 'b');

        expect(early.guard.role).toBe('leader');
        expect(late.guard.role).toBe('follower');

        late.guard.stop();
        early.guard.stop();
    });

    it('breaks a dead-heat deterministically rather than seating two writers', () => {
        const bus = makeBus();
        const a = openTab(bus, 'aaa');
        const b = openTab(bus, 'bbb'); // identical `since`

        expect([a, b].filter((tab) => tab.guard.role === 'leader')).toHaveLength(1);
        expect(a.guard.role).toBe('leader'); // lower id wins, and both sides agree on which

        a.guard.stop();
        b.guard.stop();
    });

    it('promotes a follower the moment the leader stands down', () => {
        const bus = makeBus();
        const first = openTab(bus, 'a');
        clock += 100;
        const second = openTab(bus, 'b');

        first.guard.release();

        // Instant: a deliberate handover must not cost the takeover delay.
        expect(second.guard.role).toBe('leader');
        expect(first.guard.role).toBe('follower');

        first.guard.stop();
        second.guard.stop();
    });

    it('takes over when the leader dies without releasing', () => {
        const bus = makeBus();
        const first = openTab(bus, 'a');
        clock += 100;
        const second = openTab(bus, 'b');
        expect(second.guard.role).toBe('follower');

        first.crash(); // killed: no release, no further heartbeats, only silence

        clock += 6_000;
        vi.advanceTimersByTime(6_000);

        expect(second.guard.role).toBe('leader');
        second.guard.stop();
    });

    it('waits out the full takeover window before stealing the register', () => {
        // Taking over early is how two tabs end up writing: a leader on a busy main thread looks
        // exactly like a dead one until the window has actually elapsed.
        const bus = makeBus();
        const first = openTab(bus, 'a');
        clock += 100;
        const second = openTab(bus, 'b');

        first.crash();

        clock += 3_000;
        vi.advanceTimersByTime(3_000);
        expect(second.guard.role).toBe('follower');

        clock += 3_000;
        vi.advanceTimersByTime(3_000);
        expect(second.guard.role).toBe('leader');

        second.guard.stop();
    });

    it('never once promotes the follower while the leader keeps renewing', () => {
        const bus = makeBus();
        const first = openTab(bus, 'a');
        clock += 100;
        const second = openTab(bus, 'b');

        // Well past the takeover window, with the leader alive and heartbeating throughout.
        for (let tick = 0; tick < 12; tick += 1) {
            clock += 1_000;
            vi.advanceTimersByTime(1_000);
        }

        // Asserted over the whole history, not just the end state: a follower that promotes and is
        // demoted a message later has already spent that window as a second writer, and checking
        // only the final role cannot see it.
        expect(second.roles).not.toContain('leader');
        expect(first.guard.role).toBe('leader');

        first.guard.stop();
        second.guard.stop();
    });

    it('lets a tab that handed over recover the register if the new leader dies', () => {
        // Yielding must not be permanent. Otherwise handing over once — closing a duplicate tab,
        // say — leaves that tab unable to take the till back when the other one crashes.
        const bus = makeBus();
        const first = openTab(bus, 'a');
        clock += 100;
        const second = openTab(bus, 'b');

        first.guard.release();
        expect(second.guard.role).toBe('leader');

        second.crash();

        clock += 6_000;
        vi.advanceTimersByTime(6_000);

        expect(first.guard.role).toBe('leader');

        // And it must lead *properly*, not just hold the title. A tab that recovered while still
        // marked as having yielded goes quiet: it ignores later claims instead of defending its
        // own, so the next tab to open also elects itself and the register has two writers again —
        // the exact failure all of this exists to prevent.
        clock += 100;
        const third = openTab(bus, 'c');

        expect(third.guard.role).toBe('follower');
        expect(first.guard.role).toBe('leader');

        first.guard.stop();
        third.guard.stop();
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
