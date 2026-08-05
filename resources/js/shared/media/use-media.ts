import { useEffect, useState } from 'react';

import type { PosDb } from '../db';
import type { ApiClient } from '../sync';

import { cacheMedia, imageKey, mediaBlob } from './store';

/**
 * An object URL for a media id, or null (BAN-480).
 *
 * Reads the blob store first and only reaches the network for something it does not hold, so a
 * scrolled grid on a warmed till makes no requests at all.
 *
 * The object URL is revoked when the component unmounts or the id changes. That matters more here
 * than it usually does: a product grid on a busy till mounts and unmounts hundreds of tiles a
 * minute, and an un-revoked URL pins its blob in memory for the life of the document — a leak that
 * looks exactly like "the register gets slower through the day".
 */
export function useMediaUrl(
    db: PosDb | null,
    api: ApiClient | null,
    mediaId: number | null | undefined,
    key = mediaId == null ? null : imageKey(mediaId),
): string | null {
    const [url, setUrl] = useState<string | null>(null);

    useEffect(() => {
        if (db === null || mediaId == null || key === null) {
            setUrl(null);

            return;
        }

        let objectUrl: string | null = null;
        let cancelled = false;

        const load = async (): Promise<void> => {
            let blob = await mediaBlob(db, key);

            if (blob === null && api !== null) {
                await cacheMedia(db, api, mediaId, key);
                blob = await mediaBlob(db, key);
            }

            // The tile scrolled away, or the id changed, while we were fetching. Creating the URL
            // now would leak it — nothing left to revoke it.
            if (cancelled || blob === null) return;

            objectUrl = URL.createObjectURL(blob);
            setUrl(objectUrl);
        };

        void load();

        return () => {
            cancelled = true;
            if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
        };
    }, [api, db, key, mediaId]);

    return url;
}
