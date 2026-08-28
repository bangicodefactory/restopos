/**
 * One writer per register, elected across tabs (REG-374, BAN-405).
 *
 * Two register tabs share one Dexie database and one outbox. Both drain it, both push the same
 * orders, and the second push of an order the server has already accepted is at best wasted and at
 * worst a duplicate sale. Nothing prevented this: `BroadcastChannel` was in the tree only for the
 * customer display.
 *
 * The election is deliberately boring — earliest claim wins, ties broken by id so every tab
 * computes the same winner from the same facts without a negotiation round. What it must survive
 * is not contention but *death*: a tab that crashes cannot release anything, so leadership is a
 * lease the leader renews and a follower takes over when the renewals stop.
 *
 * Two things it deliberately does not do:
 *
 *   - **It never blocks reads.** A follower renders the till read-only; it does not tear down the
 *     database. A cashier who opened a second tab by accident should see why, not lose the screen.
 *   - **It fails open.** With no `BroadcastChannel` (or in a test environment without one) the tab
 *     elects itself. A register that refuses to work because it cannot ask whether it is alone is
 *     worse than the duplicate it was guarding against.
 *
 * The channel is keyed on the config id, so the customer display at `/pos/{config}/display` — same
 * origin, boots nothing, joins no channel — is never a candidate and can never demote a till.
 */

export type TabRole = 'leader' | 'follower';

type Claim = { kind: 'claim'; id: string; since: number };
type Heartbeat = { kind: 'heartbeat'; id: string; since: number };
type Release = { kind: 'release'; id: string };
type TabMessage = Claim | Heartbeat | Release;

type Channel = {
    postMessage(message: TabMessage): void;
    close(): void;
    onmessage: ((event: { data: TabMessage }) => void) | null;
};

export type TabGuardOptions = {
    /** Register config id. Two venues open on one machine must not contend. */
    configId: string | number;
    /** How often the leader renews its lease. */
    heartbeatMs?: number;
    /**
     * How long a follower waits on silence before taking over. Must be a comfortable multiple of
     * the heartbeat: too tight and a busy main thread looks like a crash, and two tabs both
     * writing is the exact failure being prevented.
     */
    takeoverMs?: number;
    onRoleChange?: (role: TabRole) => void;
    now?: () => number;
    channelFactory?: (name: string) => Channel | null;
    /** Distinct per tab. Injected only so tests are deterministic. */
    tabId?: string;
};

export type TabGuard = {
    readonly role: TabRole;
    readonly tabId: string;
    /** Leader gives way (page unload, or an operator handing over). */
    release(): void;
    stop(): void;
};

export const HEARTBEAT_MS = 2_000;
export const TAKEOVER_MS = 7_000;

export function tabChannelName(configId: string | number): string {
    return `pos.register.tabs.${configId}`;
}

function defaultChannel(name: string): Channel | null {
    const Ctor = (globalThis as { BroadcastChannel?: new (n: string) => Channel }).BroadcastChannel;

    return Ctor ? new Ctor(name) : null;
}

export function createTabGuard(options: TabGuardOptions): TabGuard {
    const now = options.now ?? (() => Date.now());
    const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    const takeoverMs = options.takeoverMs ?? TAKEOVER_MS;
    const tabId = options.tabId ?? `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const since = now();

    const channel = (options.channelFactory ?? defaultChannel)(tabChannelName(options.configId));

    let role: TabRole = 'leader';
    let stopped = false;
    /**
     * This tab stood down and must stay down while the new leader lives.
     *
     * Without it a handover is impossible: `release()` leaves this tab still holding the earliest
     * claim, so it wins the very re-election it just triggered and the promoted tab is demoted
     * again a message later. Re-stamping `since` does not fix it — two tabs stamped in the same
     * millisecond fall to the id tie-break, which is stable and would keep picking the releaser.
     *
     * Cleared by the watchdog, so yielding is not permanent: if the tab we handed to dies, this
     * one can still take over on silence.
     */
    let yielded = false;
    let lastLeaderSeen = now();
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;

    function setRole(next: TabRole): void {
        if (role === next) return;
        role = next;
        options.onRoleChange?.(next);
    }

    // No channel: this tab is the only one it can know about, so it works. See the header.
    if (!channel) {
        options.onRoleChange?.('leader');

        return { get role() { return role; }, tabId, release() {}, stop() {} };
    }

    /**
     * Earliest claim wins; the id breaks a tie. Both tabs run this against the same pair of facts
     * and reach the same answer, so there is no round of negotiation to get wrong.
     */
    function losesTo(theirSince: number, theirId: string): boolean {
        return theirSince < since || (theirSince === since && theirId < tabId);
    }

    channel.onmessage = (event): void => {
        if (stopped) return;
        const message = event.data;
        if (message.id === tabId) return;

        if (message.kind === 'release') {
            // The leader stood down. Claim immediately rather than waiting out the watchdog, so a
            // deliberate handover is instant and only a crash costs the takeover delay.
            if (role === 'follower' && !yielded) {
                setRole('leader');
                channel.postMessage({ kind: 'claim', id: tabId, since });
            }

            return;
        }

        // Having stood down, treat whoever is talking as the leader and stay quiet.
        if (yielded) {
            lastLeaderSeen = now();

            return;
        }

        if (losesTo(message.since, message.id)) {
            lastLeaderSeen = now();
            setRole('follower');

            return;
        }

        // We outrank them. Say so, so a tab that opened first but heard us late steps down.
        if (message.kind === 'claim') channel.postMessage({ kind: 'claim', id: tabId, since });
    };

    channel.postMessage({ kind: 'claim', id: tabId, since });

    heartbeat = setInterval(() => {
        if (stopped || role !== 'leader') return;
        channel.postMessage({ kind: 'heartbeat', id: tabId, since });
    }, heartbeatMs);

    watchdog = setInterval(() => {
        if (stopped || role !== 'follower') return;
        if (now() - lastLeaderSeen < takeoverMs) return;

        // The leader stopped renewing. A crashed tab cannot release, so silence is the only signal
        // there is; claim and let the tie-break settle it if the leader is merely slow. A tab that
        // yielded earlier becomes eligible again here — otherwise handing over once would make
        // this tab permanently unable to recover the register if the new leader died.
        yielded = false;
        setRole('leader');
        channel.postMessage({ kind: 'claim', id: tabId, since });
    }, heartbeatMs);

    return {
        get role() {
            return role;
        },
        tabId,
        release(): void {
            if (role !== 'leader') return;
            yielded = true;
            setRole('follower');
            lastLeaderSeen = now();
            channel.postMessage({ kind: 'release', id: tabId });
        },
        stop(): void {
            if (stopped) return;
            stopped = true;
            if (role === 'leader') channel.postMessage({ kind: 'release', id: tabId });
            if (heartbeat) clearInterval(heartbeat);
            if (watchdog) clearInterval(watchdog);
            channel.onmessage = null;
            channel.close();
        },
    };
}
