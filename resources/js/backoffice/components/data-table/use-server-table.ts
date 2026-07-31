/**
 * Server-driven list state, bound to Inertia v2 partial reloads.
 *
 * The list controllers read their filters straight off the query string and echo them back in a
 * `filters` prop, so this hook keeps exactly one copy of that state — the URL — and pushes
 * changes with `router.get(url, params, { only })`. `only` is what makes it a partial reload: a
 * search keystroke re-runs the product query and re-serialises `products`, not the deferred
 * `categories` list and not the shared auth block.
 *
 * `replace: true` keeps the browser history from filling with one entry per keystroke, while the
 * URL still reflects the current view, so a filtered list stays a shareable link.
 */

import { router } from '@inertiajs/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cleanParams, type QueryValue } from '../../lib/query';

export type ServerQueryOptions = {
    /** Path to reload, e.g. `/products`. */
    url: string;
    /** Props to re-fetch. Omit to reload everything (rarely what you want). */
    only?: string[];
    /** The `filters` prop as the controller echoed it. */
    initial: Record<string, QueryValue>;
    /** Debounce for free-text fields; 0 applies immediately. */
    debounceMs?: number;
};

export type ServerQuery = {
    params: Record<string, QueryValue>;
    processing: boolean;
    /** Set one parameter. Free-text callers pass `debounce`. */
    set: (key: string, value: QueryValue, options?: { debounce?: boolean }) => void;
    /** Set several at once (a date range, a cleared filter set). */
    merge: (patch: Record<string, QueryValue>) => void;
    reset: () => void;
    /** True when at least one filter is active. */
    dirty: boolean;
};

export function useServerQuery({ url, only, initial, debounceMs = 250 }: ServerQueryOptions): ServerQuery {
    const [params, setParams] = useState<Record<string, QueryValue>>(initial);
    const [processing, setProcessing] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (timer.current !== null) clearTimeout(timer.current);
        },
        [],
    );

    const push = useCallback(
        (next: Record<string, QueryValue>) => {
            router.get(url, cleanParams(next), {
                preserveState: true,
                preserveScroll: true,
                replace: true,
                ...(only ? { only } : {}),
                onStart: () => setProcessing(true),
                onFinish: () => setProcessing(false),
            });
        },
        [only, url],
    );

    const schedule = useCallback(
        (next: Record<string, QueryValue>, debounce: boolean) => {
            if (timer.current !== null) clearTimeout(timer.current);
            if (!debounce || debounceMs <= 0) {
                push(next);
                return;
            }
            timer.current = setTimeout(() => push(next), debounceMs);
        },
        [debounceMs, push],
    );

    const set = useCallback<ServerQuery['set']>(
        (key, value, options) => {
            setParams((current) => {
                // Any filter change resets to page 1: page 7 of an unfiltered list is page 0 of a
                // filtered one, and Laravel answers an out-of-range page with an empty array.
                // `page` is cleared *before* the computed key so `set('page', n)` still works.
                const next = { ...current, page: undefined, [key]: value };
                schedule(next, options?.debounce ?? false);
                return next;
            });
        },
        [schedule],
    );

    const merge = useCallback<ServerQuery['merge']>(
        (patch) => {
            setParams((current) => {
                const next = { ...current, ...patch, page: undefined };
                schedule(next, false);
                return next;
            });
        },
        [schedule],
    );

    const reset = useCallback(() => {
        setParams({});
        schedule({}, false);
    }, [schedule]);

    const dirty = Object.keys(cleanParams(params)).length > 0;

    return { params, processing, set, merge, reset, dirty };
}
