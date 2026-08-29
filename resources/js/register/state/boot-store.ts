import type { OutboxEntry, OutboxStats } from '@domain/sync/index';
import { createPosStore } from '@shared/store';

/**
 * Boot lifecycle and connectivity — the only two things in the whole register that are allowed to
 * block the cashier.
 *
 * Everything else degrades: a failed sync is a badge, a failed print is a retry dialog, a closed
 * session is a toast. Pairing and the first bootstrap genuinely cannot be faked offline, so they
 * get a screen of their own and nothing else does.
 */

export type BootPhase =
    | 'starting'
    | 'pairing'
    | 'bootstrapping'
    | 'ready'
    | 'error'
    /** Paired and has data, but the config revision changed and a reload is running. */
    | 'reloading';

export type BootSlice = {
    phase: BootPhase;
    message: string | null;
    progressLabel: string | null;
    /** 0..1, `null` while indeterminate. */
    progress: number | null;
    error: string | null;
    configRevision: number;
    hasLocalData: boolean;

    setPhase: (phase: BootPhase, message?: string | null) => void;
    setProgress: (label: string | null, progress?: number | null) => void;
    setError: (error: string | null) => void;
    setLocalData: (hasLocalData: boolean, configRevision: number) => void;
};

export const useBootStore = createPosStore<BootSlice>((set) => ({
    phase: 'starting',
    message: null,
    progressLabel: null,
    progress: null,
    error: null,
    configRevision: 0,
    hasLocalData: false,

    setPhase: (phase, message = null) =>
        set((state) => {
            state.phase = phase;
            state.message = message;
            if (phase !== 'error') state.error = null;
        }),

    setProgress: (label, progress = null) =>
        set((state) => {
            state.progressLabel = label;
            state.progress = progress;
        }),

    setError: (error) =>
        set((state) => {
            state.error = error;
            if (error !== null) state.phase = 'error';
        }),

    setLocalData: (hasLocalData, configRevision) =>
        set((state) => {
            state.hasLocalData = hasLocalData;
            state.configRevision = configRevision;
        }),
}));

export type SyncSlice = {
    online: boolean;
    realtime: 'connected' | 'degraded' | 'off';
    /**
     * A sale is being flushed to the replica and drained to the server (REG-367).
     *
     * The periodic delta pull reads this and defers while it is true. A delta landing between
     * "paid" and "flushed" rewrites the very rows `commitPaidOrder` is persisting, which loses the
     * sale rather than merely showing a stale one.
     */
    paymentInFlight: boolean;
    stats: OutboxStats | null;
    lastSyncAt: number | null;
    /** Entries the server refused or that have exhausted their fast retries (spec 03 §3.6.6). */
    problems: OutboxEntry[];
    /** Non-blocking per-record failures, surfaced as chips rather than modals. */
    notices: Array<{ id: string; orderUuid: string | null; message: string; at: number }>;

    setOnline: (online: boolean) => void;
    setRealtime: (realtime: 'connected' | 'degraded' | 'off') => void;
    setPaymentInFlight: (paymentInFlight: boolean) => void;
    setStats: (stats: OutboxStats) => void;
    setProblems: (problems: OutboxEntry[]) => void;
    noteSync: () => void;
    pushNotice: (notice: { orderUuid: string | null; message: string }) => void;
    dismissNotice: (id: string) => void;
};

let noticeSeq = 0;

export const useSyncStore = createPosStore<SyncSlice>((set) => ({
    online: globalThis.navigator?.onLine !== false,
    realtime: 'off',
    paymentInFlight: false,
    stats: null,
    lastSyncAt: null,
    problems: [],
    notices: [],

    setOnline: (online) =>
        set((state) => {
            state.online = online;
        }),

    setRealtime: (realtime) =>
        set((state) => {
            state.realtime = realtime;
        }),

    setPaymentInFlight: (paymentInFlight) =>
        set((state) => {
            state.paymentInFlight = paymentInFlight;
        }),

    setStats: (stats) =>
        set((state) => {
            state.stats = stats;
        }),

    setProblems: (problems) =>
        set((state) => {
            state.problems = problems;
        }),

    noteSync: () =>
        set((state) => {
            state.lastSyncAt = Date.now();
        }),

    pushNotice: (notice) =>
        set((state) => {
            noticeSeq += 1;
            state.notices.push({ ...notice, id: `n${noticeSeq}`, at: Date.now() });
            // The drawer lists everything; the inline strip only ever shows the last few.
            if (state.notices.length > 20) state.notices.splice(0, state.notices.length - 20);
        }),

    dismissNotice: (id) =>
        set((state) => {
            state.notices = state.notices.filter((notice) => notice.id !== id);
        }),
}));
