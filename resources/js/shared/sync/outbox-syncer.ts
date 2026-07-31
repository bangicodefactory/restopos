import { generateUuid } from '@domain/sequence/index';
import { Outbox, type OutboxEntry, type OutboxStats } from '@domain/sync/outbox';
import type { OrderCommand, SyncPushRequest, SyncPushResponse, SyncRecordResult } from '@domain/sync/wire';
import type { SyncError } from '@domain/sync/wire';
import type { Uuid } from '@domain/types';

import { createDexieOutboxStorage, withQuotaRescue, type PosDb } from '../db';
import { ApiError, browserOnline, type ApiClient } from './http';

/**
 * The push engine (spec 03 §3.6).
 *
 * The rules it exists to enforce, in priority order:
 *
 *   1. **Never block the sale.** A failed sync of order 411 must not prevent ringing up 412. Every
 *      failure path here ends in "record it and carry on".
 *   2. **Never lose money.** Nothing is deleted from the outbox until the server has acknowledged
 *      it; an entry stranded `inflight` by a crash is recovered at boot.
 *   3. **Never double-post.** Every attempt-group carries an `Idempotency-Key`, and every record is
 *      keyed by a client-minted uuid the server upserts on.
 *
 * Triggers to drain: `online`, realtime reconnect, app foreground, every 15 s while entries exist,
 * and immediately on enqueue.
 */

export type SyncEvent =
    | { type: 'drain:start'; entries: number }
    | { type: 'drain:end'; sent: number; failed: number }
    | { type: 'entry:ok'; id: Uuid; result: SyncRecordResult }
    | { type: 'entry:failed'; id: Uuid; error: SyncError }
    | { type: 'entry:quarantined'; id: Uuid; result?: SyncRecordResult }
    | { type: 'online'; online: boolean }
    | { type: 'stats'; stats: OutboxStats };

export type SyncListener = (event: SyncEvent) => void;

export type OutboxSyncerOptions = {
    api: ApiClient;
    db: PosDb;
    configId: number;
    deviceId: () => string | null;
    employeeId: () => number | null;
    clientVersion: string;
    /** Applied when the server acknowledges a record: merge ids, set syncState, store baseline. */
    onResult?: (result: SyncRecordResult) => Promise<void> | void;
    parallelism?: number;
    pollIntervalMs?: number;
};

export class OutboxSyncer {
    readonly outbox: Outbox;

    private readonly listeners = new Set<SyncListener>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private draining = false;
    private stopped = true;
    private disposers: Array<() => void> = [];

    constructor(private readonly options: OutboxSyncerOptions) {
        this.outbox = new Outbox({
            storage: createDexieOutboxStorage(options.db),
            newId: () => generateUuid(),
        });
    }

    subscribe(listener: SyncListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(event: SyncEvent): void {
        for (const listener of this.listeners) listener(event);
    }

    /** Queue an order push. Coalesces with any pending entry for the same order. */
    async enqueueOrder(command: OrderCommand): Promise<OutboxEntry> {
        const entry = await withQuotaRescue(this.options.db, () =>
            this.outbox.enqueue({ kind: 'order.sync', payload: command, targetUuid: command.uuid }),
        );
        void this.drain();
        return entry;
    }

    /** Queue a non-order intent. Session lifecycle entries are barriers: they drain alone. */
    async enqueueCommand(
        kind: Exclude<OutboxEntry['kind'], 'order.sync'>,
        payload: unknown,
        targetUuid: Uuid | null = null,
    ): Promise<OutboxEntry> {
        const barrier = kind === 'session.open' || kind === 'session.close';
        const entry = await withQuotaRescue(this.options.db, () =>
            this.outbox.enqueue({ kind, payload, targetUuid, barrier }),
        );
        void this.drain();
        return entry;
    }

    /** Wire up the ambient triggers and recover anything a crash left in flight. */
    async start(): Promise<void> {
        if (!this.stopped) return;
        this.stopped = false;

        await this.outbox.recoverInflight();

        const online = (): void => {
            this.emit({ type: 'online', online: true });
            void this.drain();
        };
        const offline = (): void => this.emit({ type: 'online', online: false });
        const visibility = (): void => {
            if (globalThis.document?.visibilityState === 'visible') void this.drain();
        };

        globalThis.addEventListener?.('online', online);
        globalThis.addEventListener?.('offline', offline);
        globalThis.document?.addEventListener('visibilitychange', visibility);

        this.disposers = [
            () => globalThis.removeEventListener?.('online', online),
            () => globalThis.removeEventListener?.('offline', offline),
            () => globalThis.document?.removeEventListener('visibilitychange', visibility),
        ];

        void this.drain();
        this.scheduleNext();
    }

    stop(): void {
        this.stopped = true;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        for (const dispose of this.disposers) dispose();
        this.disposers = [];
    }

    async stats(): Promise<OutboxStats> {
        const stats = await this.outbox.stats();
        this.emit({ type: 'stats', stats });
        return stats;
    }

    /**
     * Send one batch. Safe to call concurrently — overlapping calls collapse into one.
     *
     * Note the deliberate asymmetry: a transport failure fails *every* entry in the batch (they
     * never left the device), while a 200 response is unpacked per record, because the server
     * processes each order independently and a poisoned order must not block the queue behind it.
     */
    async drain(): Promise<{ sent: number; failed: number }> {
        if (this.draining || this.stopped) return { sent: 0, failed: 0 };
        if (!browserOnline()) return { sent: 0, failed: 0 };

        this.draining = true;
        let sent = 0;
        let failed = 0;

        try {
            const batch = await this.outbox.claim(this.options.parallelism ?? 4);
            if (batch.length === 0) return { sent: 0, failed: 0 };

            this.emit({ type: 'drain:start', entries: batch.length });

            const orders = batch
                .filter((entry) => entry.kind === 'order.sync')
                .map((entry) => entry.payload as OrderCommand);
            const commands = batch
                .filter((entry) => entry.kind !== 'order.sync')
                .map((entry) => ({
                    uuid: entry.id,
                    kind: entry.kind as Exclude<OutboxEntry['kind'], 'order.sync'>,
                    payload: entry.payload,
                    at: new Date(entry.createdAt).toISOString(),
                }));

            const body: SyncPushRequest = {
                device_id: this.options.deviceId() ?? '',
                employee_id: this.options.employeeId(),
                client_version: this.options.clientVersion,
                client_time: new Date().toISOString(),
                orders,
                ...(commands.length > 0 ? { commands } : {}),
            };

            let response: SyncPushResponse | null;
            try {
                const result = await this.options.api.post<SyncPushResponse>('pos/sync', body, {
                    idempotencyKey: generateUuid(),
                    timeoutMs: 30_000,
                });
                response = result.data;
            } catch (error) {
                const sync: SyncError = error instanceof ApiError ? error.sync : { kind: 'unknown', message: String(error) };
                for (const entry of batch) {
                    await this.outbox.fail(entry.id, sync);
                    this.emit({ type: 'entry:failed', id: entry.id, error: sync });
                }
                return { sent: 0, failed: batch.length };
            }

            const byUuid = new Map((response?.results ?? []).map((r) => [String(r.uuid), r]));

            for (const entry of batch) {
                const key = entry.kind === 'order.sync' ? String((entry.payload as OrderCommand).uuid) : String(entry.id);
                const result = byUuid.get(key);

                if (!result) {
                    // The server accepted the request but said nothing about this record: treat it
                    // as unknown and retry rather than silently dropping it.
                    await this.outbox.fail(entry.id, { kind: 'unknown', message: 'no result for record' });
                    failed++;
                    continue;
                }

                await this.options.onResult?.(result);

                if (result.status === 'ok' || result.status === 'superseded') {
                    await this.outbox.succeed(entry.id);
                    sent++;
                    this.emit({ type: 'entry:ok', id: entry.id, result });
                    continue;
                }

                if (result.status === 'conflict') {
                    // The server returned its state; the caller re-diffs and enqueues a fresh push.
                    await this.outbox.fail(entry.id, {
                        kind: 'conflict',
                        reason: result.conflict?.code ?? 'stale_write',
                        serverState: result.conflict?.serverState ?? null,
                    });
                    failed++;
                    this.emit({ type: 'entry:quarantined', id: entry.id, result });
                    continue;
                }

                await this.outbox.fail(entry.id, {
                    kind: 'rejected',
                    code: result.error?.code ?? result.conflict?.code ?? 'rejected',
                    message: result.error?.message ?? result.conflict?.message ?? 'Rejected by server',
                });
                failed++;
                this.emit({ type: 'entry:quarantined', id: entry.id, result });
            }

            this.emit({ type: 'drain:end', sent, failed });
            return { sent, failed };
        } finally {
            this.draining = false;
            void this.stats();
            this.scheduleNext();
        }
    }

    /**
     * Re-arm the timer for whichever comes first: the earliest backoff deadline, or the 15 s
     * safety poll. No timer is armed when the queue is empty.
     */
    private scheduleNext(): void {
        if (this.stopped) return;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;

        void this.outbox.msUntilNextAttempt().then((ms) => {
            if (this.stopped || ms === null) return;
            const delay = Math.min(ms, this.options.pollIntervalMs ?? 15_000);
            this.timer = setTimeout(() => void this.drain(), Math.max(250, delay));
        });
    }

    /**
     * Hand the queue to the service worker's Background Sync on `pagehide`, where supported.
     * Strictly a bonus (spec 03 §8.5): the in-page outbox is correct on its own, and every push
     * carries an idempotency key so a double-send is harmless.
     */
    async registerBackgroundSync(): Promise<boolean> {
        const registration = await globalThis.navigator?.serviceWorker?.ready;
        const sync = (registration as unknown as { sync?: { register(tag: string): Promise<void> } } | undefined)?.sync;
        if (!sync) return false;
        try {
            await sync.register('pos-order-sync');
            return true;
        } catch {
            return false;
        }
    }
}
