import { parseScaleFrame, splitFrames } from './protocol';
import type { ScaleReading, ScaleTransport } from './types';

/**
 * WebSerial scale transport (spec 03 §7.7).
 *
 * **This file is not verified by any test in this repo, and that is a statement about the
 * environment rather than an omission.** `navigator.serial` exists only in Chromium, `requestPort`
 * throws outside a user gesture, and neither answers anything without an RS-232 or USB-serial
 * scale physically attached. There is no fixture for that.
 *
 * What follows from it is the shape of this file: it is deliberately thin, and every decision it
 * could have made has been pushed somewhere that *is* testable —
 *
 *  - byte framing and number parsing → `protocol.ts` (pure, covered)
 *  - stability, tare, the zero check, the poll window → `reader.ts` (pure, covered)
 *  - what happens when a transport is unavailable, refuses, or throws → driven through
 *    `FakeScaleTransport` against the same `ScaleTransport` interface this implements
 *
 * So what is untested here is opening a port and draining a stream. If this file is wrong, the
 * symptom is "no reading arrives", which the dialog surfaces; it cannot be wrong in a way that
 * puts a wrong number on a bill, because it does not produce numbers.
 *
 * The port handle cannot be persisted, only the *grant* can — same constraint as WebUSB. So the
 * port is re-resolved from `getPorts()` on every connect and only `requestPort()` needs a gesture.
 */

const DEFAULT_BAUD = 9600;
/** A frame older than this is stale: the scale stopped talking, or the cable came out. */
const STALE_MS = 2000;

export type WebSerialScaleOptions = {
    baudRate?: number;
    /** Narrow `requestPort` to a known adapter. Empty means "show the operator everything". */
    filters?: Array<{ usbVendorId?: number; usbProductId?: number }>;
    now?: () => number;
};

export class WebSerialScaleTransport implements ScaleTransport {
    readonly kind = 'webserial' as const;

    private readonly baudRate: number;
    private readonly filters: Array<{ usbVendorId?: number; usbProductId?: number }>;
    private readonly now: () => number;

    private port: SerialPort | null = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private buffer = '';
    private latest: ScaleReading | null = null;
    private pump: Promise<void> | null = null;

    constructor(options: WebSerialScaleOptions = {}) {
        this.baudRate = options.baudRate ?? DEFAULT_BAUD;
        this.filters = options.filters ?? [];
        this.now = options.now ?? (() => Date.now());
    }

    isAvailable(): boolean {
        return typeof globalThis.navigator?.serial?.getPorts === 'function';
    }

    /** Must be called from a user gesture the first time; later boots reuse the stored grant. */
    async connect(): Promise<boolean> {
        const serial = globalThis.navigator?.serial;
        if (!serial) return false;
        if (this.port !== null) return true;

        const granted = await serial.getPorts();
        const port =
            granted[0] ?? (await serial.requestPort(this.filters.length > 0 ? { filters: this.filters } : undefined));
        if (!port) return false;

        await port.open({ baudRate: this.baudRate, dataBits: 8, stopBits: 1, parity: 'none' });
        this.port = port;
        this.buffer = '';
        this.latest = null;
        this.pump = this.drain();

        return true;
    }

    /**
     * Most scales stream continuously rather than answering a query, so the transport keeps the
     * newest complete frame and `read()` hands that back. Polling the *stream* at 4 Hz would be
     * meaningless; the reader polls this cache instead, which is what the 4 Hz rate is really for.
     */
    async read(): Promise<ScaleReading | null> {
        if (this.latest === null) return null;
        if (this.now() - this.latest.at > STALE_MS) return null;
        return this.latest;
    }

    async disconnect(): Promise<void> {
        const reader = this.reader;
        this.reader = null;

        if (reader) await reader.cancel().catch(() => undefined);
        await this.pump?.catch(() => undefined);
        this.pump = null;

        const port = this.port;
        this.port = null;
        this.latest = null;
        this.buffer = '';

        if (port) await port.close().catch(() => undefined);
    }

    private async drain(): Promise<void> {
        const readable = this.port?.readable;
        if (!readable) return;

        const decoder = new TextDecoder();
        this.reader = readable.getReader();

        try {
            for (;;) {
                const { value, done } = await this.reader.read();
                if (done) return;
                if (!value) continue;

                this.buffer += decoder.decode(value, { stream: true });
                const { frames, rest } = splitFrames(this.buffer);
                this.buffer = rest;

                for (const frame of frames) {
                    const reading = parseScaleFrame(frame, this.now());
                    // An unparseable frame is dropped, never turned into a zero. `reader.ts`'s
                    // zero check treats zero as "the pan is empty", so a garbled frame becoming
                    // zero would arm the next weighing on noise.
                    if (reading !== null) this.latest = reading;
                }
            }
        } finally {
            this.reader?.releaseLock();
        }
    }
}
