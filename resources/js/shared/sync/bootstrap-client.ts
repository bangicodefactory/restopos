import type { BootstrapProfile, BootstrapResponse } from '@domain/sync/wire';

import { META, applyPayload, getMeta, resetForConfigRevision, setMeta, type PosDb } from '../db';
import type { ApiClient } from './http';

/**
 * Full bootstrap (spec 01 §5.1, spec 03 §3.2).
 *
 * `GET /api/pos/bootstrap` (device-scoped: the config is derived from the device token, never the
 * path) with an `If-None-Match` of the ETag we stored last time. A
 * register that re-opens five minutes later gets a 304 and skips straight to delta sync — which is
 * the difference between an eight-second wait and an instant one at every shift change.
 *
 * The one non-obvious rule: **`config_revision` is checked before the payload is applied.** A
 * changed revision means the cached dataset is wholesale invalid (payment methods changed,
 * pricelist swapped, currency changed) and must be purged first, or the client will happily price
 * an order against a catalog the server no longer recognises.
 */

export type BootstrapProgress = {
    phase: 'fetching' | 'purging' | 'applying' | 'done' | 'not_modified';
    entity?: string;
    entities?: number;
    records?: number;
};

export type BootstrapOptions = {
    profile?: BootstrapProfile;
    /** Ignore the stored ETag and force a full re-download. */
    force?: boolean;
    onProgress?: (progress: BootstrapProgress) => void;
    signal?: AbortSignal;
};

export type BootstrapOutcome = {
    applied: boolean;
    notModified: boolean;
    reset: boolean;
    configRevision: number;
    serverTime: string | null;
    records: number;
};

export class BootstrapClient {
    constructor(
        private readonly api: ApiClient,
        private readonly db: PosDb,
    ) {}

    async run(options: BootstrapOptions = {}): Promise<BootstrapOutcome> {
        const notify = options.onProgress ?? ((): void => {});
        const storedEtag = options.force ? null : await getMeta<string | null>(this.db, META.bootstrapEtag, null);

        notify({ phase: 'fetching' });

        const response = await this.api.get<BootstrapResponse>('pos/bootstrap', {
            query: { profile: options.profile ?? 'register' },
            etag: storedEtag,
            ...(options.signal ? { signal: options.signal } : {}),
            // A cold bootstrap on a slow venue link legitimately takes a while.
            timeoutMs: 120_000,
        });

        if (response.notModified || response.data === null) {
            notify({ phase: 'not_modified' });
            const revision = await getMeta<number>(this.db, META.configRevision, 0);
            return {
                applied: false,
                notModified: true,
                reset: false,
                configRevision: revision,
                serverTime: await getMeta<string | null>(this.db, META.watermarkGlobal, null),
                records: 0,
            };
        }

        const payload = response.data;
        const storedRevision = await getMeta<number>(this.db, META.configRevision, 0);
        const mustReset = storedRevision !== 0 && storedRevision !== payload.config_revision;

        if (mustReset) {
            notify({ phase: 'purging' });
            await resetForConfigRevision(this.db, payload.config_revision);
        }

        notify({ phase: 'applying', entities: Object.keys(payload.data).length });
        const result = await applyPayload(this.db, payload);

        if (response.etag) await setMeta(this.db, META.bootstrapEtag, response.etag);

        notify({ phase: 'done', entities: result.entities.length, records: result.upserted });

        return {
            applied: true,
            notModified: false,
            reset: mustReset,
            configRevision: payload.config_revision,
            serverTime: payload.server_time,
            records: result.upserted,
        };
    }

    /** Have we ever completed a bootstrap on this device? Drives the boot screen. */
    async hasData(): Promise<boolean> {
        return (await this.db.configs.count()) > 0 && (await this.db.products.count()) > 0;
    }

    /**
     * Client/server version gate. An out-of-date register must refuse to open a session rather
     * than corrupt data with a payload shape it does not understand.
     */
    static isClientTooOld(clientVersion: string, minVersion: string | undefined): boolean {
        if (!minVersion) return false;
        return compareSemver(clientVersion, minVersion) < 0;
    }
}

/** Numeric-segment semver comparison; pre-release suffixes are ignored on purpose. */
export function compareSemver(a: string, b: string): number {
    const pa = a.split('.').map((p) => Number.parseInt(p, 10) || 0);
    const pb = b.split('.').map((p) => Number.parseInt(p, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return 0;
}
