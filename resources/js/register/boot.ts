import { nextOrderReference } from '@domain/sequence/index';
import type { SyncRecordResult } from '@domain/sync/wire';
import {
    clearPairing,
    hardwareFingerprint,
    loadDevice,
    loadDeviceKey,
    restoreCashier,
    storePairing,
    useSessionStore,
    type PairingResponse,
} from '@shared/auth';
import { META, createDexieCounterStore, destroyDatabase, getDb, getMeta, requestPersistence } from '@shared/db';
import { ApiClient, ApiError, BootstrapClient, DeltaPuller, OutboxSyncer } from '@shared/sync';

import { loadCatalogIndex } from './data/catalog-load';
import { setCatalog } from './data/catalog';
import { createPersistence, loadOrdersFromDb } from './data/persistence';
import { APP_VERSION, clearRuntime, configIdFromUrl, getRuntime, setRuntime, tryRuntime } from './data/runtime';
import { applyServerAck, configureOrderActions, hydrateOrders, markSyncState } from './domain/order-actions';
import { bindingsFromCatalog, createPrinterRouter } from './domain/printing';
import { fetchCurrentSession } from './domain/session-actions';
import { useBootStore, useSyncStore } from './state/boot-store';
import { unsyncedCount, useOrderStore } from './state/order-store';

/**
 * Boot (spec 03 §3.3 "Hydration").
 *
 * Order matters and is load-bearing:
 *
 *   1. open IndexedDB and read the device credentials — no network;
 *   2. hydrate the catalog and the open orders from the local replica — no network;
 *   3. **render**;
 *   4. only then consult the server: manifest, delta, outbox drain, realtime.
 *
 * The register is interactive before step 4 finishes. That is a hard requirement rather than an
 * optimisation: if the first paint depends on a fetch, the offline story is a lie. The only two
 * things allowed to block are pairing (there is nothing to work with) and the very first bootstrap
 * (likewise).
 */

let catalogVersion = 0;

export type BootResult = { paired: boolean; hasData: boolean };

function apiFor(token: () => string | null): ApiClient {
    return new ApiClient({ token, clientVersion: APP_VERSION });
}

export async function boot(): Promise<BootResult> {
    const bootStore = useBootStore.getState();
    bootStore.setPhase('starting');

    const configId = configIdFromUrl();
    const db = getDb(configId);
    void requestPersistence();

    const device = await loadDevice(db);
    if (!device) {
        bootStore.setPhase('pairing');
        return { paired: false, hasData: false };
    }

    const deviceKey = await loadDeviceKey(db);
    const api = apiFor(() => device.token);
    const bootstrap = new BootstrapClient(api, db);
    const delta = new DeltaPuller(api, db);
    const counters = createDexieCounterStore(db);

    const syncer = new OutboxSyncer({
        api,
        db,
        configId,
        deviceId: () => device.info.device_id,
        employeeId: () => useSessionStore.getState().cashier?.employee_id ?? null,
        clientVersion: APP_VERSION,
        onResult: (result) => applySyncResult(result),
    });

    const printer = createPrinterRouter();

    setRuntime({
        db,
        api,
        bootstrap,
        delta,
        syncer,
        printer,
        counters,
        device,
        deviceKey,
        configId,
        appVersion: APP_VERSION,
    });

    const persistence = createPersistence(db, syncer);
    persistence.attachLifecycle();

    configureOrderActions({
        context: () => ({
            configId,
            companyId: 1,
            currencyId: 1,
            sessionId: useSessionStore.getState().session?.id ?? 0,
            deviceId: null,
            deviceSeq: device.info.device_seq,
            employeeId: useSessionStore.getState().cashier?.employee_id ?? null,
            multiDevice: false,
            nextReference: () => nextOrderReference(counters, device.info),
        }),
        persist: persistence.persist,
        enqueue: persistence.enqueue,
        onChange: () => {},
    });

    const hasData = await bootstrap.hasData();
    const configRevision = await getMeta<number>(db, META.configRevision, 0);
    bootStore.setLocalData(hasData, configRevision);

    if (!hasData) {
        // Nothing local: this one genuinely blocks.
        bootStore.setPhase('bootstrapping');
        const ok = await runBootstrap();
        if (!ok) return { paired: true, hasData: false };
    }

    await hydrateLocal();
    bootStore.setPhase('ready');

    await restoreCashier(db);
    void syncer.start();
    void afterFirstPaint();

    return { paired: true, hasData: true };
}

/** Everything that needs the network. Deliberately not awaited by `boot()`. */
async function afterFirstPaint(): Promise<void> {
    const runtime = tryRuntime();
    if (!runtime) return;

    try {
        const outcome = await runtime.bootstrap.run({ profile: 'register' });
        if (outcome.applied || outcome.reset) await hydrateLocal();
    } catch {
        // Offline: the local replica is authoritative until the link returns.
    }

    try {
        const result = await runtime.delta.pull({ drain: true });
        if (result.needsBootstrap) {
            useBootStore.getState().setPhase('reloading');
            await runBootstrap();
            await hydrateLocal();
            useBootStore.getState().setPhase('ready');
        } else if (result.applied) {
            await hydrateLocal();
        }
        useSyncStore.getState().noteSync();
    } catch {
        // Same: a failed delta is a stale catalog, not a stopped till.
    }

    void fetchCurrentSession();
    runtime.printer.startStatusPolling();
}

export async function runBootstrap(force = false): Promise<boolean> {
    const runtime = tryRuntime();
    if (!runtime) return false;
    const bootStore = useBootStore.getState();

    try {
        const outcome = await runtime.bootstrap.run({
            profile: 'register',
            force,
            onProgress: (progress) => {
                const label =
                    progress.phase === 'fetching'
                        ? 'downloading'
                        : progress.phase === 'purging'
                          ? 'purging'
                          : progress.phase === 'applying'
                            ? 'applying'
                            : 'ready';
                bootStore.setProgress(label, progress.phase === 'done' ? 1 : null);
            },
        });
        bootStore.setLocalData(true, outcome.configRevision);
        bootStore.setProgress(null, null);
        return true;
    } catch (error) {
        const reason =
            error instanceof ApiError && error.sync.kind === 'offline' ? 'offline' : String(error);
        bootStore.setError(reason);
        return false;
    }
}

/** Re-read the local replica into memory: the catalog index and the open-order graph. */
export async function hydrateLocal(): Promise<void> {
    const runtime = tryRuntime();
    if (!runtime) return;

    catalogVersion += 1;
    const catalog = await loadCatalogIndex(runtime.db, catalogVersion);
    setCatalog(catalog);
    runtime.printer.setBindings(bindingsFromCatalog(catalog));

    const payload = await loadOrdersFromDb(runtime.db);
    hydrateOrders(payload);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync results
// ─────────────────────────────────────────────────────────────────────────────

function applySyncResult(result: SyncRecordResult): void {
    const uuid = String(result.uuid);
    const sync = useSyncStore.getState();

    if (result.status === 'ok') {
        applyServerAck(uuid, {
            ...(result.order
                ? {
                      id: result.order.id,
                      name: result.order.name,
                      sequence_number: result.order.sequence_number,
                      amounts: {
                          amount_untaxed: result.order.amount_untaxed,
                          amount_tax: result.order.amount_tax,
                          amount_total: result.order.amount_total,
                          amount_paid: result.order.amount_paid,
                          amount_change: result.order.amount_change,
                          amount_due: result.order.amount_due,
                      },
                  }
                : {}),
            serverRev: result.server_rev,
            lineIds: Object.fromEntries((result.lines ?? []).map((line) => [String(line.uuid), line.id])),
            paymentIds: Object.fromEntries((result.payments ?? []).map((payment) => [String(payment.uuid), payment.id])),
            courseIds: Object.fromEntries((result.courses ?? []).map((course) => [String(course.uuid), course.id])),
        });
        sync.noteSync();

        // Warnings are informational: a manual price override legitimately produces a mismatch.
        for (const warning of result.warnings ?? []) {
            sync.pushNotice({ orderUuid: uuid, message: warning.code });
        }
        return;
    }

    if (result.status === 'superseded') {
        markSyncState(uuid, 'synced');
        sync.pushNotice({ orderUuid: uuid, message: 'superseded' });
        return;
    }

    markSyncState(uuid, result.status === 'conflict' ? 'error' : 'quarantined', {
        kind: 'rejected',
        code: result.error?.code ?? result.conflict?.code ?? 'rejected',
        message: result.error?.message ?? result.conflict?.message ?? 'rejected',
    });
    sync.pushNotice({ orderUuid: uuid, message: result.error?.code ?? result.conflict?.code ?? 'rejected' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing & reset
// ─────────────────────────────────────────────────────────────────────────────

export async function pairDevice(code: string, name: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const configId = configIdFromUrl();
    const db = getDb(configId);
    const api = new ApiClient({ token: () => null, clientVersion: APP_VERSION });

    try {
        const response = await api.post<PairingResponse>('devices/pair', {
            code: code.trim().toUpperCase(),
            device_type: 'register',
            name: name.trim() || 'Caisse',
            hardware_fingerprint: hardwareFingerprint(),
            app_version: APP_VERSION,
        });
        if (!response.data) return { ok: false, error: 'empty_response' };
        await storePairing(db, response.data, APP_VERSION);
        return { ok: true };
    } catch (error) {
        if (error instanceof ApiError) {
            return { ok: false, error: error.sync.kind === 'offline' ? 'offline' : error.message };
        }
        return { ok: false, error: String(error) };
    }
}

/** REG-376 — the support escape hatch. Refuses while unsynced sales exist. */
export async function hardReset(force = false): Promise<{ ok: true } | { ok: false; unsynced: number }> {
    const pending = unsyncedCount(useOrderStore.getState());
    if (pending > 0 && !force) return { ok: false, unsynced: pending };

    const runtime = tryRuntime();
    const configId = runtime?.configId ?? configIdFromUrl();
    if (runtime) {
        runtime.syncer.stop();
        await clearPairing(runtime.db);
    }
    await destroyDatabase(configId, { force: true });
    clearRuntime();
    useOrderStore.getState().resetAll();
    return { ok: true };
}

/** REG-376 (softer) — force a full catalog reload without touching credentials or orders. */
export async function reloadData(): Promise<boolean> {
    const ok = await runBootstrap(true);
    if (ok) await hydrateLocal();
    return ok;
}

/** Manual "sync now" from the status bar. */
export async function syncNow(): Promise<void> {
    const runtime = tryRuntime();
    if (!runtime) return;
    await runtime.syncer.drain();
    await runtime.delta.pull({ drain: true });
    await hydrateLocal();
    useSyncStore.getState().noteSync();
}

export function runtimeOrThrow(): ReturnType<typeof getRuntime> {
    return getRuntime();
}
