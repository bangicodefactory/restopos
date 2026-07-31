import type { CounterStore } from '@domain/sequence/index';
import type { StoredDevice } from '@shared/auth';
import type { PosDb } from '@shared/db';
import type { PrinterRouter } from '@shared/printing';
import type { ApiClient, BootstrapClient, DeltaPuller, OutboxSyncer } from '@shared/sync';

import type { Persistence } from './persistence';

/**
 * Process-wide singletons.
 *
 * A React context would be the idiomatic home for these, but they are needed from places that are
 * not components — the outbox drain callback, the BroadcastChannel publisher, the beforeunload
 * guard — and threading a context through those would mean either a global escape hatch anyway or
 * a lot of prop drilling. One module, one setter, called once at boot.
 */

export type RegisterRuntime = {
    db: PosDb;
    api: ApiClient;
    bootstrap: BootstrapClient;
    delta: DeltaPuller;
    syncer: OutboxSyncer;
    persistence: Persistence;
    printer: PrinterRouter;
    counters: CounterStore;
    device: StoredDevice;
    deviceKey: CryptoKey | null;
    configId: number;
    appVersion: string;
};

let runtime: RegisterRuntime | null = null;

export function setRuntime(next: RegisterRuntime): void {
    runtime = next;
}

export function tryRuntime(): RegisterRuntime | null {
    return runtime;
}

export function getRuntime(): RegisterRuntime {
    if (!runtime) throw new Error('register runtime is not booted');
    return runtime;
}

export function clearRuntime(): void {
    runtime = null;
}

/** The config id the shell was opened with — a hint only; the device token is authoritative. */
export function configIdFromUrl(fallback = 1): number {
    const match = /\/pos\/(\d+)/.exec(globalThis.location?.pathname ?? '');
    const parsed = match?.[1] !== undefined ? Number.parseInt(match[1], 10) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
}

export const APP_VERSION: string =
    typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.1.0';
