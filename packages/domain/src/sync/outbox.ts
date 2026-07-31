import type { EpochMs, Uuid } from '../types';
import { isRetryable, type SyncError } from './wire';

/**
 * The offline push queue (spec 03 §3.6.4) — pure logic, storage injected.
 *
 * Everything that makes the register survive a six-hour outage is here:
 *
 *   - **Coalescing.** A mutation to an order that already has a `pending` entry replaces that
 *     entry's payload instead of appending. The queue stays bounded no matter how long the venue
 *     is offline. An `inflight` entry is never touched — the follow-up becomes a new entry.
 *   - **Ordering.** Entries drain strictly by `seq` within a `targetUuid`, with bounded parallelism
 *     across different targets. `barrier` entries (session lifecycle) drain alone.
 *   - **Backoff.** Exponential with *full* jitter, capped at 30 s. There is **no maximum attempt
 *     count for network errors** — a till offline for six hours must still be trying at hour six.
 *   - **Quarantine.** `rejected` results never retry; they surface to a manager instead.
 *
 * No Dexie, no fetch, no timers: `OutboxStorage` and the clock are injected, which is what makes
 * the whole policy unit-testable in microseconds.
 */

export type OutboxKind =
    | 'order.sync'
    | 'order.cancel'
    | 'session.open'
    | 'session.close'
    | 'session.cash_move'
    | 'partner.create'
    | 'audit.batch'
    | 'prep.sent';

export type OutboxState = 'pending' | 'inflight' | 'error' | 'quarantined';

export type OutboxEntry = {
    id: Uuid;
    /** Monotonic — preserves causal order within a target. */
    seq: number;
    kind: OutboxKind;
    payload: unknown;
    /** The order (or session) this entry mutates; drives coalescing and serialization. */
    targetUuid: Uuid | null;
    state: OutboxState;
    attempts: number;
    nextAttemptAt: EpochMs;
    lastError: SyncError | null;
    createdAt: EpochMs;
    /** Drains alone, after everything before it and before everything after it. */
    barrier: boolean;
};

/** The storage contract. Implemented over Dexie in `@shared/db`, over a Map in tests. */
export type OutboxStorage = {
    put(entry: OutboxEntry): Promise<void>;
    get(id: Uuid): Promise<OutboxEntry | undefined>;
    delete(id: Uuid): Promise<void>;
    /** All entries, ascending by `seq`. Implementations should push the filter into an index. */
    all(): Promise<OutboxEntry[]>;
    nextSeq(): Promise<number>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Backoff policy
// ─────────────────────────────────────────────────────────────────────────────

export type BackoffPolicy = {
    /** Delay for attempts 1..3 — a transient blip should be invisible to the cashier. */
    fastAttempts: number;
    fastDelayMs: number;
    baseMs: number;
    capMs: number;
    /** After this many attempts an entry is flagged `error` (banner) but keeps retrying. */
    errorAfterAttempts: number;
    /** Retry interval once flagged `error`. */
    errorIntervalMs: number;
};

export const DEFAULT_BACKOFF: BackoffPolicy = {
    fastAttempts: 3,
    fastDelayMs: 1_500,
    baseMs: 500,
    capMs: 30_000,
    errorAfterAttempts: 20,
    errorIntervalMs: 60_000,
};

/**
 * Full-jitter exponential backoff: `min(cap, base * 2^attempt) * (0.5 + rand/2)`.
 *
 * Full jitter (rather than none) matters at venue scale: twelve tills that all lost the uplink at
 * the same moment must not retry in lockstep when it comes back.
 */
export function computeBackoff(
    attempt: number,
    policy: BackoffPolicy = DEFAULT_BACKOFF,
    random: () => number = Math.random,
): number {
    if (attempt <= 0) return 0;
    if (attempt <= policy.fastAttempts) {
        return Math.round(policy.fastDelayMs * (0.5 + random() * 0.5));
    }
    if (attempt > policy.errorAfterAttempts) {
        return Math.round(policy.errorIntervalMs * (0.5 + random() * 0.5));
    }
    const exponent = attempt - policy.fastAttempts;
    const raw = Math.min(policy.capMs, policy.baseMs * 2 ** exponent);
    return Math.round(raw * (0.5 + random() * 0.5));
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue
// ─────────────────────────────────────────────────────────────────────────────

export type OutboxDeps = {
    storage: OutboxStorage;
    now?: () => EpochMs;
    random?: () => number;
    newId?: () => string;
    policy?: BackoffPolicy;
};

export type EnqueueInput = {
    kind: OutboxKind;
    payload: unknown;
    targetUuid?: Uuid | null;
    barrier?: boolean;
};

export class Outbox {
    private readonly storage: OutboxStorage;
    private readonly now: () => EpochMs;
    private readonly random: () => number;
    private readonly newId: () => string;
    private readonly policy: BackoffPolicy;

    constructor(deps: OutboxDeps) {
        this.storage = deps.storage;
        this.now = deps.now ?? (() => Date.now());
        this.random = deps.random ?? Math.random;
        this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
        this.policy = deps.policy ?? DEFAULT_BACKOFF;
    }

    /**
     * Add work. When a `pending` entry for the same target and kind already exists its payload is
     * replaced (coalescing) and the entry keeps its original `seq`, preserving causal order.
     */
    async enqueue(input: EnqueueInput): Promise<OutboxEntry> {
        const target = input.targetUuid ?? null;
        const barrier = input.barrier ?? false;

        if (target !== null && !barrier) {
            const existing = (await this.storage.all()).find(
                (e) => e.state === 'pending' && e.targetUuid === target && e.kind === input.kind,
            );
            if (existing) {
                const merged: OutboxEntry = { ...existing, payload: input.payload };
                await this.storage.put(merged);
                return merged;
            }
        }

        const entry: OutboxEntry = {
            id: this.newId() as Uuid,
            seq: await this.storage.nextSeq(),
            kind: input.kind,
            payload: input.payload,
            targetUuid: target,
            state: 'pending',
            attempts: 0,
            nextAttemptAt: this.now(),
            lastError: null,
            createdAt: this.now(),
            barrier,
        };
        await this.storage.put(entry);
        return entry;
    }

    /**
     * The next batch to send.
     *
     * Rules, in order:
     *   1. Nothing is claimed while an entry is `inflight` for the same target.
     *   2. A `barrier` entry drains alone and only when it is the lowest-seq claimable entry.
     *   3. At most one entry per target per batch (per-order serialization).
     *   4. `parallelism` targets at a time.
     */
    async claim(parallelism = 4): Promise<OutboxEntry[]> {
        const now = this.now();
        const all = (await this.storage.all()).sort((a, b) => a.seq - b.seq);

        const inflightTargets = new Set(
            all.filter((e) => e.state === 'inflight').map((e) => e.targetUuid ?? e.id),
        );
        if (all.some((e) => e.state === 'inflight' && e.barrier)) return [];

        const claimable = all.filter(
            (e) =>
                (e.state === 'pending' || e.state === 'error') &&
                e.nextAttemptAt <= now &&
                !inflightTargets.has(e.targetUuid ?? e.id),
        );

        const picked: OutboxEntry[] = [];
        const seenTargets = new Set<string>();

        for (const entry of claimable) {
            const key = entry.targetUuid ?? entry.id;
            if (seenTargets.has(key)) continue;

            if (entry.barrier) {
                // A barrier only runs first and alone.
                if (picked.length === 0) picked.push(entry);
                break;
            }

            picked.push(entry);
            seenTargets.add(key);
            if (picked.length >= parallelism) break;
        }

        for (const entry of picked) {
            await this.storage.put({ ...entry, state: 'inflight', attempts: entry.attempts + 1 });
        }

        return picked.map((e) => ({ ...e, state: 'inflight' as const, attempts: e.attempts + 1 }));
    }

    /** The send succeeded and the server accepted the record: the entry is done. */
    async succeed(id: Uuid): Promise<void> {
        await this.storage.delete(id);
    }

    /**
     * The send failed. Retryable errors get backed off; anything permanent is quarantined so a
     * manager can decide, and the cashier can keep ringing up the next order regardless.
     */
    async fail(id: Uuid, error: SyncError): Promise<OutboxEntry | undefined> {
        const entry = await this.storage.get(id);
        if (!entry) return undefined;

        if (!isRetryable(error)) {
            const quarantined: OutboxEntry = { ...entry, state: 'quarantined', lastError: error };
            await this.storage.put(quarantined);
            return quarantined;
        }

        const delay = computeBackoff(entry.attempts, this.policy, this.random);
        const next: OutboxEntry = {
            ...entry,
            state: entry.attempts >= this.policy.errorAfterAttempts ? 'error' : 'pending',
            nextAttemptAt: this.now() + delay,
            lastError: error,
        };
        await this.storage.put(next);
        return next;
    }

    /** Manual "retry now" from the sync panel — clears the backoff and un-quarantines. */
    async retryNow(id: Uuid): Promise<void> {
        const entry = await this.storage.get(id);
        if (!entry) return;
        await this.storage.put({ ...entry, state: 'pending', nextAttemptAt: this.now(), lastError: null });
    }

    async retryAll(): Promise<number> {
        const all = await this.storage.all();
        const stuck = all.filter((e) => e.state === 'error' || e.state === 'quarantined');
        for (const entry of stuck) {
            await this.storage.put({ ...entry, state: 'pending', nextAttemptAt: this.now(), lastError: null });
        }
        return stuck.length;
    }

    /** Recover entries left `inflight` by a crash or a hard reload. */
    async recoverInflight(): Promise<number> {
        const all = await this.storage.all();
        const stranded = all.filter((e) => e.state === 'inflight');
        for (const entry of stranded) {
            await this.storage.put({ ...entry, state: 'pending', nextAttemptAt: this.now() });
        }
        return stranded.length;
    }

    async stats(): Promise<OutboxStats> {
        const all = await this.storage.all();
        const now = this.now();
        return {
            total: all.length,
            pending: all.filter((e) => e.state === 'pending').length,
            inflight: all.filter((e) => e.state === 'inflight').length,
            error: all.filter((e) => e.state === 'error').length,
            quarantined: all.filter((e) => e.state === 'quarantined').length,
            oldestAgeMs: all.length ? now - Math.min(...all.map((e) => e.createdAt)) : 0,
            /** Never allow a session close while anything is unsent (spec 03 §3.6.6 rule 5). */
            blocksSessionClose: all.some((e) => e.state !== 'quarantined'),
        };
    }

    /** Milliseconds until the next entry becomes claimable; `null` when the queue is idle. */
    async msUntilNextAttempt(): Promise<number | null> {
        const all = await this.storage.all();
        const waiting = all.filter((e) => e.state === 'pending' || e.state === 'error');
        if (waiting.length === 0) return null;
        return Math.max(0, Math.min(...waiting.map((e) => e.nextAttemptAt)) - this.now());
    }
}

export type OutboxStats = {
    total: number;
    pending: number;
    inflight: number;
    error: number;
    quarantined: number;
    oldestAgeMs: number;
    blocksSessionClose: boolean;
};

/** In-memory storage — the reference implementation and the one the unit tests use. */
export function createMemoryOutboxStorage(): OutboxStorage {
    const rows = new Map<string, OutboxEntry>();
    let seq = 0;
    return {
        async put(entry) {
            rows.set(entry.id, entry);
        },
        async get(id) {
            return rows.get(id);
        },
        async delete(id) {
            rows.delete(id);
        },
        async all() {
            return [...rows.values()].sort((a, b) => a.seq - b.seq);
        },
        async nextSeq() {
            return ++seq;
        },
    };
}
