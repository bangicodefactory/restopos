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
import {
    META,
    createDexieCounterStore,
    destroyDatabase,
    getDb,
    getMeta,
    onUpgradeBlocked,
    requestPersistence,
} from '@shared/db';
import { ApiClient, ApiError, BootstrapClient, DeltaPuller, OutboxSyncer } from '@shared/sync';

import { loadCatalogIndex } from './data/catalog-load';
import { nextCatalogVersion, setCatalog } from './data/catalog';
import { mediaToWarm, warmMediaCache } from '@shared/media';

import { createPersistence, loadOrdersFromDb } from './data/persistence';
import { APP_VERSION, clearRuntime, configIdFromUrl, getRuntime, setRuntime, tryRuntime } from './data/runtime';
import { remapPlaceholderCustomer } from './domain/customer-remap';
import { conflictAction } from './data/conflict-reread';
import { fetchOrderGraphs } from './data/order-lookup';
import { applyServerAck, configureOrderActions, hydrateOrders, markSyncState } from './domain/order-actions';
import { bindingsFromCatalog, createPrinterRouter } from './domain/printing';
import { fetchCurrentSession, openSessionFromDb } from './domain/session-actions';
import { useBootStore, useSyncStore } from './state/boot-store';
import { linesOf, unsyncedCount, useOrderStore } from './state/order-store';
import { usePosSessionStore } from './state/session-store';

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

export type BootResult = { paired: boolean; hasData: boolean };

function apiFor(token: () => string | null): ApiClient {
    return new ApiClient({ token, clientVersion: APP_VERSION });
}

export async function boot(): Promise<BootResult> {
    const bootStore = useBootStore.getState();
    bootStore.setPhase('starting');

    const configId = configIdFromUrl();

    // A schema upgrade held up by a stale tab makes `db.open()` hang forever, so the boot screen
    // would otherwise spin with nothing to act on. Say what is wrong before touching the database.
    onUpgradeBlocked(() => useBootStore.getState().setError('upgradeBlocked'));

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
    const persistence = createPersistence(db, syncer);

    setRuntime({
        db,
        api,
        bootstrap,
        delta,
        syncer,
        persistence,
        printer,
        counters,
        device,
        deviceKey,
        configId,
        appVersion: APP_VERSION,
    });

    persistence.attachLifecycle();

    configureOrderActions({
        context: () => ({
            configId,
            companyId: 1,
            currencyId: 1,
            // The open session lives in the register's own store (usePosSessionStore); the shared
            // useSessionStore only ever holds the cashier, so reading session from it stamped every
            // order with 0 and had the server reroute it into a conflict.
            sessionId: usePosSessionStore.getState().session?.id ?? 0,
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

    // Images last, and not awaited: the catalogue has to be usable before the pictures arrive, and a
    // venue with two hundred product photos on a slow line must not delay a service by one second
    // (BAN-480). Failures are per-image and already swallowed inside.
    void warmMediaCache(runtime.db, runtime.api, await mediaToWarm(runtime.db));
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

    const catalog = await loadCatalogIndex(runtime.db, nextCatalogVersion());
    setCatalog(catalog);
    runtime.printer.setBindings(bindingsFromCatalog(catalog));

    const payload = await loadOrdersFromDb(runtime.db);
    hydrateOrders(payload);

    // The open session, from the replica, before first paint. `fetchCurrentSession` will confirm it
    // against the server later; offline that call falls back to this same row. Without it the till
    // paints "open the session" and only corrects itself once the network answers — which offline
    // is never (BAN-504).
    const local = await openSessionFromDb();
    if (local) usePosSessionStore.getState().setSession(local);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync results
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull one order's graph from the server and replace the local copy.
 *
 * Returns whether anything landed, so the caller can decide what a failure means — a re-read that
 * silently did nothing and still marked the order synced would be the same lie as not re-reading.
 */
async function rereadOrder(orderUuid: string): Promise<boolean> {
    const runtime = tryRuntime();
    if (!runtime) return false;

    try {
        const graph = await fetchOrderGraphs(runtime.api, [orderUuid]);
        if (graph.orders.length === 0) return false;

        hydrateOrders(graph);

        // `toClientRows` stamps a fetched order `synced`, on the reasoning that a fetched order is by
        // definition synced. True of the server's content — and false the moment local work is still
        // attached to it (review of #68).
        //
        // A line the waiter typed while this order was in conflict survives the hydrate, because
        // nothing deletes rows the server did not mention. Left marked `synced`, it is never pushed:
        // it sits on the screen looking rung up while the kitchen, the bill and every other till
        // know nothing about it. Silent divergence, which is the failure mode this codebase treats
        // as worse than an error.
        //
        // So the order goes back to dirty when anything on it has never been acknowledged, and the
        // outbox takes it from there.
        const unacked = linesOf(useOrderStore.getState(), orderUuid).some((line) => line.id === null);

        if (unacked) markSyncState(orderUuid, 'local');

        for (const order of graph.orders) runtime.persistence.persist(order.uuid);

        return true;
    } catch {
        return false;
    }
}

function applySyncResult(result: SyncRecordResult): void {
    const uuid = String(result.uuid);
    const sync = useSyncStore.getState();

    if (result.status === 'ok') {
        // A `partner.create` result reconciles an offline customer's placeholder id to the real one
        // (issue #7). It carries no order, so handle it and stop before the order-ack path below.
        // (Other command results — cash_move, prep.sent — have no order either and fall through to
        // applyServerAck, which no-ops when the uuid matches no order.)
        if (result.partner) {
            const rt = tryRuntime();
            if (rt) {
                void remapPlaceholderCustomer(rt.db, result.partner).catch(() => {
                    // A failed remap leaves the placeholder in place, so a later order would unlink;
                    // surface it rather than swallowing it silently.
                    sync.pushNotice({ orderUuid: uuid, message: 'customer_remap_failed' });
                });
            }
            sync.noteSync();
            return;
        }

        applyServerAck(uuid, {
            ...(result.order
                ? {
                      id: result.order.id,
                      name: result.order.name,
                      sequence_number: result.order.sequence_number,
                      access_token: result.order.access_token,
                      tracking_number: result.order.tracking_number,
                      updated_at: result.order.updated_at,
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

    // REG-372 — act on the answer instead of just colouring the order red.
    //
    // The outbox has always told conflict, rejection and supersession apart, and the register did
    // nothing with that beyond marking the row. The waiter carried on looking at a bill the server
    // had already refused — worst of all on a table order, where the other till is looking at the
    // version that won.
    const action = conflictAction(result);

    if (action.kind === 'adopt') {
        // Two tills opened the same table and the server merged them (RST-058). The pushed uuid no
        // longer exists server-side, so re-reading *it* would 404; the survivor is what to fetch.
        markSyncState(uuid, 'synced');
        void rereadOrder(action.survivorUuid);

        if (useOrderStore.getState().selectedOrderUuid === uuid) {
            useOrderStore.getState().selectOrder(action.survivorUuid);
        }

        sync.pushNotice({ orderUuid: uuid, message: 'duplicate_table_order' });
        sync.noteSync();

        return;
    }

    if (action.kind === 'reread') {
        // Nothing is wrong with the sale — the till is behind. Marked synced only once the server's
        // copy has landed, so a failed re-read leaves the row visibly unresolved rather than
        // pretending it agreed.
        // No explicit `synced` here: the hydrate already stamps the fetched order, and claiming it
        // over local work that has not been acknowledged is exactly the lie guarded against above.
        void rereadOrder(uuid);

        sync.pushNotice({ orderUuid: uuid, message: result.status === 'superseded' ? 'superseded' : 'conflict_reread' });

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

/**
 * REG-376 (softer) / XCT-014 — repair the local database without revoking the device.
 *
 * Re-runs bootstrap and re-hydrates Dexie, keeping the pairing and the orders. Until BAN-405 this
 * existed but had exactly one occurrence in the tree — its own definition — so the only repair a
 * venue could actually reach was `hardReset`, which throws the credentials away and needs a
 * manager to re-pair the till mid-service.
 *
 * Refuses while sales are unsynced, mirroring `hardReset`'s guard. A full re-hydrate against a
 * server that has never seen those orders is exactly when losing them would be silent, and "repair"
 * is the button a cashier presses precisely when something already looks wrong.
 */
export async function reloadData(force = false): Promise<{ ok: true } | { ok: false; unsynced: number }> {
    const pending = unsyncedCount(useOrderStore.getState());
    if (pending > 0 && !force) return { ok: false, unsynced: pending };

    const ok = await runBootstrap(true);
    if (ok) await hydrateLocal();

    return ok ? { ok: true } : { ok: false, unsynced: 0 };
}

/**
 * Stop this tab writing, because another tab is the elected writer (REG-374, BAN-405).
 *
 * Only the outbox drain is stopped, and that is the whole point: two tabs draining one outbox both
 * push the same orders, and the second push of an order the server has already accepted is at best
 * wasted work and at worst a duplicate sale. Reads, the replica and the rendered screen are left
 * alone so a follower tab shows the till rather than a broken page.
 */
export function pauseWrites(): void {
    tryRuntime()?.syncer.stop();
}

/** This tab is the elected writer again — resume draining. Idempotent, like `start()` itself. */
export function resumeWrites(): void {
    void tryRuntime()?.syncer.start();
}

/**
 * A delta pull driven by a broadcast or by the periodic timer (REG-367).
 *
 * Deliberately **not** `syncNow`: this path must not drain the outbox. It runs up to twice a minute
 * per till plus once per peer broadcast, and a drain on every one of those re-pushes anything the
 * server has not yet acknowledged — which is how a slow ack turns into a duplicate sale. Pushing is
 * the outbox syncer's job and it has its own schedule.
 *
 * Also not a re-bootstrap. A full reload throws the catalogue away and blocks the till; a delta is
 * the whole point of the endpoint. `needsBootstrap` is the one case that genuinely cannot be
 * expressed as a delta — the config revision moved — and only then is the heavy path taken.
 *
 * Swallows its own failures: the scheduler treats a rejected pull as "owed", and a stale replica is
 * not a reason to put an error on a cashier's screen.
 */
export async function pullDelta(): Promise<void> {
    const runtime = tryRuntime();
    if (!runtime) return;

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
        // Offline, or the server refused. The local replica stays authoritative.
    }
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

/**
 * Force the in-memory order slice to match the server after a server-authoritative table op
 * (transfer / merge / unmerge — BAN-437). The register applies those on the server, which moves
 * lines between orders and tombstones the merged source; the local store cannot reconstruct that
 * itself. So: flush any pending local writes, pull the authoritative order deltas (moves + the
 * tombstone for the merged-away order) into IndexedDB, then rebuild the order slice from the
 * replica. The rebuild is a clean replace rather than an additive hydrate — otherwise the merged
 * source lingers and moved lines keep a stale index entry. Unsynced local orders survive because
 * `flushNow` has already written them to the same replica.
 */
export async function reloadAllOrders(): Promise<void> {
    const runtime = tryRuntime();
    if (!runtime) return;

    await runtime.persistence.flushNow();
    await runtime.delta.pull({ drain: true });

    const payload = await loadOrdersFromDb(runtime.db);
    useOrderStore.getState().resetAll();
    hydrateOrders(payload);
    useSyncStore.getState().noteSync();
}

export function runtimeOrThrow(): ReturnType<typeof getRuntime> {
    return getRuntime();
}
