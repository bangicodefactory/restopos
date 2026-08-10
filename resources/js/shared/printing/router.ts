import { computeBackoff, DEFAULT_BACKOFF } from '@domain/sync/outbox';
import type { EscPosDoc } from '@domain/escpos/index';
import { drawerKickDoc } from '@domain/escpos/index';
import { generateUuid } from '@domain/sequence/index';

import { BrowserPrintTransport } from './browser-print';
import { EposNetworkTransport } from './epos-network';
import {
    UNKNOWN_STATUS,
    printError,
    type PrintJob,
    type PrintOutcome,
    type PrintTransport,
    type PrinterBinding,
    type PrinterRole,
    type PrinterStatus,
    type TransportKind,
} from './types';
import { WebUsbTransport } from './web-usb';

/**
 * Printer routing, retry and queueing (spec 03 §7.3).
 *
 * Responsibilities, all of which the apps would otherwise each reinvent:
 *
 *  - **Route a kitchen ticket to the right printer per category.** A drinks line goes to the bar,
 *    a steak to the grill; a line whose category matches several printers prints on each of them,
 *    and a line matching none goes to the fallback prep printer so it is never silently lost.
 *  - **Retry with backoff.** Printers go offline (paper, cover, someone unplugged the switch). A
 *    failed job is retried on the same schedule the sync outbox uses, and non-retryable failures
 *    (permission, unsupported) stop immediately instead of hammering.
 *  - **Queue while offline.** Jobs survive in memory and drain when the printer answers again.
 *  - **Remember what worked.** The transport that last succeeded for a binding is tried first.
 */

export type RouterEvent =
    | { type: 'job:queued'; job: PrintJob }
    | { type: 'job:done'; job: PrintJob; outcome: PrintOutcome }
    | { type: 'job:failed'; job: PrintJob; outcome: PrintOutcome; attempts: number }
    | { type: 'job:dropped'; job: PrintJob; reason: string }
    | { type: 'status'; printerId: string; status: PrinterStatus };

export type RouterOptions = {
    bindings: PrinterBinding[];
    transports?: Partial<Record<TransportKind, PrintTransport>>;
    /** Attempts before a job is dropped and surfaced to the cashier. */
    maxAttempts?: number;
    statusIntervalMs?: number;
    now?: () => number;
    random?: () => number;
};

type QueuedJob = { job: PrintJob; attempts: number; nextAttemptAt: number; lastError?: string };

export class PrinterRouter {
    private bindings: PrinterBinding[];
    private readonly transports: Partial<Record<TransportKind, PrintTransport>>;
    private readonly queue: QueuedJob[] = [];
    private readonly listeners = new Set<(event: RouterEvent) => void>();
    private readonly preferred = new Map<string, TransportKind>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private statusTimer: ReturnType<typeof setInterval> | null = null;
    private draining = false;

    constructor(private readonly options: RouterOptions) {
        this.bindings = options.bindings;
        this.transports = options.transports ?? {
            epos: new EposNetworkTransport(),
            webusb: new WebUsbTransport(),
            browser: new BrowserPrintTransport(),
        };
    }

    subscribe(listener: (event: RouterEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(event: RouterEvent): void {
        for (const listener of this.listeners) listener(event);
    }

    setBindings(bindings: PrinterBinding[]): void {
        this.bindings = bindings;
    }

    getBindings(): readonly PrinterBinding[] {
        return this.bindings;
    }

    /**
     * Which printers should receive this content.
     *
     * Rules, in order:
     *   1. An explicit `printerId` wins.
     *   2. `prep` jobs go to every enabled prep printer whose `categoryIds` intersect the job's.
     *   3. A prep job matching no printer falls back to any prep printer with an empty category
     *      list (the "everything else" printer), then to the receipt printer. Never nowhere.
     *   4. `report` jobs go to a report printer if one is bound, otherwise to the receipt printer.
     *   5. Other roles go to the first enabled printer with that role.
     */
    resolveTargets(job: PrintJob): PrinterBinding[] {
        const enabled = this.bindings.filter((b) => b.enabled);

        if (job.printerId) {
            const explicit = enabled.find((b) => b.id === job.printerId);
            return explicit ? [explicit] : [];
        }

        if (job.role === 'prep') {
            const categories = job.categoryIds ?? [];
            const prep = enabled.filter((b) => b.role === 'prep');
            const matched = prep.filter((b) => b.categoryIds.some((id) => categories.includes(id)));
            if (matched.length > 0) return matched;

            const catchAll = prep.filter((b) => b.categoryIds.length === 0);
            if (catchAll.length > 0) return catchAll;

            const receipt = enabled.filter((b) => b.role === 'receipt');
            return receipt.slice(0, 1);
        }

        // A venue *may* bind a back-office printer for readings, and almost none will. Dropping the
        // job when they have not would make an X-report a button that silently does nothing — so it
        // falls back to the receipt printer, which is where a till roll X-report has always come
        // out anyway. Same shape as the prep fallback above, for the same reason: never nowhere.
        if (job.role === 'report') {
            const report = enabled.filter((b) => b.role === 'report');
            if (report.length > 0) return report.slice(0, 1);

            return enabled.filter((b) => b.role === 'receipt').slice(0, 1);
        }

        return enabled.filter((b) => b.role === job.role).slice(0, 1);
    }

    /** Enqueue a document. Returns the job so the caller can correlate the outcome event. */
    enqueue(
        doc: EscPosDoc,
        options: { role?: PrinterRole; printerId?: string; categoryIds?: number[]; copies?: number } = {},
    ): PrintJob {
        const job: PrintJob = {
            id: generateUuid(),
            doc,
            role: options.role ?? (doc.meta.kind === 'prep' ? 'prep' : 'receipt'),
            createdAt: this.now(),
            ...(options.printerId !== undefined ? { printerId: options.printerId } : {}),
            ...(options.categoryIds !== undefined ? { categoryIds: options.categoryIds } : {}),
            ...(options.copies !== undefined ? { copies: options.copies } : {}),
        };

        this.queue.push({ job, attempts: 0, nextAttemptAt: this.now() });
        this.emit({ type: 'job:queued', job });
        void this.drain();
        return job;
    }

    /** Open the cash drawer wired to the receipt printer's kick port. */
    async openDrawer(printerId?: string): Promise<PrintOutcome | null> {
        const binding = printerId
            ? this.bindings.find((b) => b.id === printerId)
            : this.bindings.find((b) => b.enabled && b.role === 'receipt');
        if (!binding) return null;

        const transport = this.transportFor(binding);
        if (!transport) return null;

        if (transport.openDrawer) return transport.openDrawer(binding);
        return transport.print(drawerKickDoc(), binding);
    }

    /** Send everything that is due. Safe to call at any time; overlapping calls collapse. */
    async drain(): Promise<void> {
        if (this.draining) return;
        this.draining = true;

        try {
            const now = this.now();
            const due = this.queue.filter((entry) => entry.nextAttemptAt <= now);

            for (const entry of due) {
                const targets = this.resolveTargets(entry.job);

                if (targets.length === 0) {
                    this.remove(entry);
                    this.emit({ type: 'job:dropped', job: entry.job, reason: 'no printer configured for this role' });
                    continue;
                }

                const outcomes: PrintOutcome[] = [];
                for (const binding of targets) {
                    for (let copy = 0; copy < (entry.job.copies ?? 1); copy++) {
                        outcomes.push(await this.printOn(entry.job.doc, binding));
                    }
                }

                const failure = outcomes.find((outcome) => !outcome.ok);
                if (!failure) {
                    this.remove(entry);
                    const first = outcomes[0];
                    if (first) this.emit({ type: 'job:done', job: entry.job, outcome: first });
                    continue;
                }

                entry.attempts += 1;
                entry.lastError = failure.ok ? undefined : failure.error.message;

                const permanent = !failure.ok && !failure.error.retryable;
                const exhausted = entry.attempts >= (this.options.maxAttempts ?? 8);

                if (permanent || exhausted) {
                    this.remove(entry);
                    this.emit({ type: 'job:failed', job: entry.job, outcome: failure, attempts: entry.attempts });
                    continue;
                }

                entry.nextAttemptAt = this.now() + computeBackoff(entry.attempts, DEFAULT_BACKOFF, this.options.random);
            }
        } finally {
            this.draining = false;
            this.scheduleNext();
        }
    }

    /**
     * Try the remembered-good transport first, then the binding's own, then the browser fallback.
     * A receipt the customer is waiting for must not be lost because the LAN printer moved.
     */
    private async printOn(doc: EscPosDoc, binding: PrinterBinding): Promise<PrintOutcome> {
        const order: TransportKind[] = [];
        const remembered = this.preferred.get(binding.id);
        if (remembered) order.push(remembered);
        if (!order.includes(binding.transport)) order.push(binding.transport);
        if (!order.includes('browser')) order.push('browser');

        let last: PrintOutcome = {
            ok: false,
            transport: binding.transport,
            printerId: binding.id,
            error: printError('unsupported', 'no transport available', false),
        };

        for (const kind of order) {
            const transport = this.transports[kind];
            if (!transport || !transport.isAvailable()) continue;

            const outcome = await transport.print(doc, binding);
            if (outcome.ok) {
                this.preferred.set(binding.id, kind);
                return outcome;
            }
            last = outcome;
            // A permission failure will not be fixed by trying again with the same transport, but
            // the next one in the list might work, so we keep going.
        }

        return last;
    }

    private transportFor(binding: PrinterBinding): PrintTransport | null {
        const kind = this.preferred.get(binding.id) ?? binding.transport;
        return this.transports[kind] ?? null;
    }

    /** Poll ePOS/agent printers so paper-out shows in the navbar before a cashier notices. */
    startStatusPolling(): void {
        if (this.statusTimer !== null) return;
        const interval = this.options.statusIntervalMs ?? 30_000;
        const poll = async (): Promise<void> => {
            for (const binding of this.bindings) {
                const transport = this.transportFor(binding);
                if (!transport?.status) continue;
                const status = await transport.status(binding);
                binding.status = status;
                this.emit({ type: 'status', printerId: binding.id, status });
            }
        };
        void poll();
        this.statusTimer = setInterval(() => void poll(), interval);
    }

    stop(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        if (this.statusTimer !== null) clearInterval(this.statusTimer);
        this.timer = null;
        this.statusTimer = null;
    }

    get pending(): number {
        return this.queue.length;
    }

    statusOf(printerId: string): PrinterStatus {
        return this.bindings.find((b) => b.id === printerId)?.status ?? UNKNOWN_STATUS;
    }

    private remove(entry: QueuedJob): void {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
    }

    private scheduleNext(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        if (this.queue.length === 0) return;
        const soonest = Math.min(...this.queue.map((entry) => entry.nextAttemptAt));
        this.timer = setTimeout(() => void this.drain(), Math.max(250, soonest - this.now()));
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }
}
