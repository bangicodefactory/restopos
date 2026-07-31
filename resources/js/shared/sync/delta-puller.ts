import type { DeltaResponse } from '@domain/sync/wire';

import { META, applyPayload, getMeta, resetForConfigRevision, type PosDb } from '../db';
import type { ApiClient } from './http';

/**
 * Incremental pull (spec 03 §3.5, spec 01 §5.5).
 *
 * Invoked on: the `catalog.changed` realtime event, reconnect, a 5-minute safety timer, and the
 * manual button in the sync panel.
 *
 * **Clock discipline** is the whole game here. Watermarks are *server* timestamps, never client
 * clocks. `since` is stored only after the IndexedDB write commits, and we send it back shifted a
 * second into the past: the `updated_at > :since` comparison is strict, so a row written in the
 * same microsecond as the boundary would otherwise be lost forever. Upserts are idempotent, so the
 * one-second overlap costs nothing and removes an entire class of "that product never updates" bug.
 */

export const WATERMARK_SAFETY_MS = 1_000;

export type DeltaResult = {
    applied: boolean;
    hasMore: boolean;
    upserted: number;
    deleted: number;
    serverTime: string | null;
    /** The server bumped `config_revision`: the caller must re-bootstrap. */
    needsBootstrap: boolean;
};

export type DeltaOptions = {
    entities?: string[];
    signal?: AbortSignal;
    /** Keep calling until the server stops setting `has_more`. */
    drain?: boolean;
    maxRounds?: number;
};

export class DeltaPuller {
    private running = false;

    constructor(
        private readonly api: ApiClient,
        private readonly db: PosDb,
    ) {}

    /** Serialised: two overlapping pulls would race on the watermark. */
    async pull(options: DeltaOptions = {}): Promise<DeltaResult> {
        if (this.running) {
            return { applied: false, hasMore: false, upserted: 0, deleted: 0, serverTime: null, needsBootstrap: false };
        }
        this.running = true;
        try {
            return await this.pullInner(options);
        } finally {
            this.running = false;
        }
    }

    private async pullInner(options: DeltaOptions): Promise<DeltaResult> {
        const maxRounds = options.drain ? (options.maxRounds ?? 20) : 1;
        let upserted = 0;
        let deleted = 0;
        let hasMore = false;
        let serverTime: string | null = null;

        for (let round = 0; round < maxRounds; round++) {
            const since = await this.since();

            const response = await this.api.get<DeltaResponse>('pos/delta', {
                query: {
                    since,
                    entities: options.entities?.join(',') ?? null,
                },
                ...(options.signal ? { signal: options.signal } : {}),
            });

            const payload = response.data;
            if (!payload) break;

            const stored = await getMeta<number>(this.db, META.configRevision, 0);
            if (stored !== 0 && stored !== payload.config_revision) {
                // A config change invalidates the cache wholesale; a delta cannot express that.
                await resetForConfigRevision(this.db, payload.config_revision);
                return {
                    applied: false,
                    hasMore: false,
                    upserted,
                    deleted,
                    serverTime: payload.server_time,
                    needsBootstrap: true,
                };
            }

            const result = await applyPayload(this.db, payload);
            upserted += result.upserted;
            deleted += result.deleted;
            serverTime = payload.server_time;
            hasMore = payload.has_more === true;

            if (!hasMore) break;
        }

        return { applied: upserted + deleted > 0, hasMore, upserted, deleted, serverTime, needsBootstrap: false };
    }

    /** The watermark to send, shifted back by the safety margin. `null` ⇒ the server sends all. */
    private async since(): Promise<string | null> {
        const stored = await getMeta<string | null>(this.db, META.watermarkGlobal, null);
        if (!stored) return null;
        return shiftBack(stored, WATERMARK_SAFETY_MS);
    }
}

/** ISO timestamp minus `ms`, preserving the ISO shape the server expects. */
export function shiftBack(iso: string, ms: number): string {
    const time = new Date(iso).getTime();
    if (Number.isNaN(time)) return iso;
    return new Date(time - ms).toISOString();
}
