import { toKilograms, type ScaleReading, type ScaleTransport } from './types';

/**
 * The scale reader (spec 03 §7.7, XCT-058).
 *
 * Everything decision-shaped about weighing is here, and nothing else is: the transports do I/O,
 * this does the rules. That division is what makes the rules testable, because a WebSerial
 * transport needs Chromium, a user gesture and an RS-232 scale, and none of the three is available
 * to a unit test.
 *
 * Four rules, in the order they bite:
 *
 *  1. **Poll at 4 Hz, and only while the dialog is open.** Spec 03 §7.7 is explicit about the
 *     "never otherwise": a serial port held open and read continuously is a port no other app can
 *     take, and on a shared IoT proxy it is a request every 250 ms forever.
 *  2. **Unstable is not a weight.** A pan still settling reads high or low by grams. The device
 *     says so; we refuse to accept while it does, and we require the value to *hold* for
 *     `stableSamples` consecutive polls, because the flag itself flickers on cheap hardware.
 *  3. **Tare is software-first.** `zero()` asks the device when the transport can, and falls back
 *     to subtracting the current gross. A container's weight must never reach a line.
 *  4. **The pan must return to zero between two weighings.** This is the mechanical half of the
 *     legal-metrology rule (REG-077). Odoo enforces "the weight must differ from the last accepted
 *     one", which a cashier defeats by adding a gram; requiring an observed zero in between means
 *     the item actually came off the scale. `acceptable()` refuses until it has seen one, and
 *     `accepted()` re-arms the requirement.
 *
 * The reader owns no React and no store. `subscribe()` is the whole surface a component needs.
 */

export type ScaleStatus = 'idle' | 'unavailable' | 'connecting' | 'live' | 'error';

export type ScaleState = {
    status: ScaleStatus;
    /** The last raw reading, exactly as the device gave it. Null until one arrives. */
    reading: ScaleReading | null;
    /** Gross weight in kilograms, before the software tare. */
    grossKg: number;
    /** `grossKg` minus the software tare — the number that would go on the line. */
    netKg: number;
    /** The software tare in kilograms. Device-side tare is already inside `grossKg`. */
    tareKg: number;
    /** Held stable for `stableSamples` consecutive polls, per rule 2. */
    stable: boolean;
    /** Has the pan been seen empty since the last accepted weight? Rule 4. */
    zeroed: boolean;
    error: string | null;
};

export type ScaleReaderOptions = {
    transport: ScaleTransport;
    /** 250 ms = 4 Hz (spec 03 §7.7). */
    intervalMs?: number;
    /** Consecutive stable polls at the same value before the reading counts as settled. */
    stableSamples?: number;
    /**
     * What counts as "nothing on the pan", in kilograms. A 2 g deadband: below any saleable
     * quantity, above the drift of a cheap load cell.
     */
    zeroToleranceKg?: number;
    /** Two readings within this many kilograms are the same reading. One gram. */
    epsilonKg?: number;
};

const INITIAL: ScaleState = {
    status: 'idle',
    reading: null,
    grossKg: 0,
    netKg: 0,
    tareKg: 0,
    stable: false,
    zeroed: false,
    error: null,
};

export class ScaleReader {
    private readonly transport: ScaleTransport;
    private readonly intervalMs: number;
    private readonly stableSamples: number;
    private readonly zeroToleranceKg: number;
    private readonly epsilonKg: number;

    private state: ScaleState = INITIAL;
    private readonly listeners = new Set<(state: ScaleState) => void>();
    private timer: ReturnType<typeof setInterval> | null = null;
    /** How many consecutive polls have agreed with `state.grossKg` and said `stable`. */
    private streak = 0;
    /** Guards against a slow `read()` overlapping the next tick. */
    private polling = false;

    constructor(options: ScaleReaderOptions) {
        this.transport = options.transport;
        this.intervalMs = options.intervalMs ?? 250;
        this.stableSamples = options.stableSamples ?? 2;
        this.zeroToleranceKg = options.zeroToleranceKg ?? 0.002;
        this.epsilonKg = options.epsilonKg ?? 0.001;
    }

    getState(): ScaleState {
        return this.state;
    }

    /** Whether polling is currently running. Rule 1 is only checkable if this is observable. */
    isRunning(): boolean {
        return this.timer !== null;
    }

    subscribe(listener: (state: ScaleState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private set(patch: Partial<ScaleState>): void {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener(this.state);
    }

    /**
     * Open the port and begin polling. Idempotent: a second call while live is a no-op, so a
     * dialog that re-renders does not open a second interval on the same port.
     */
    async start(): Promise<void> {
        if (this.timer !== null) return;

        if (!this.transport.isAvailable()) {
            this.set({ status: 'unavailable', error: null });
            return;
        }

        this.set({ status: 'connecting', error: null });

        let connected = false;
        try {
            connected = await this.transport.connect();
        } catch (error) {
            this.set({ status: 'error', error: messageOf(error) });
            return;
        }

        if (!connected) {
            this.set({ status: 'unavailable' });
            return;
        }

        // Checked after the await: `stop()` may have run while `connect()` was in flight — the
        // cashier closing the dialog before the port opened. Starting the interval anyway is how a
        // closed dialog ends up polling forever, which is exactly what rule 1 forbids.
        if (this.state.status !== 'connecting') {
            await this.transport.disconnect().catch(() => undefined);
            return;
        }

        this.set({ status: 'live' });
        this.timer = setInterval(() => void this.poll(), this.intervalMs);
    }

    /** Close the port and stop polling. Safe to call when never started. */
    async stop(): Promise<void> {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.streak = 0;
        this.set({ ...INITIAL });
        await this.transport.disconnect().catch(() => undefined);
    }

    /** One poll. Exposed so a test can step the machine without a timer. */
    async poll(): Promise<void> {
        if (this.polling) return;
        this.polling = true;

        try {
            const reading = await this.transport.read();
            if (reading === null) return;
            this.apply(reading);
        } catch (error) {
            // `stable` is deliberately left alone. The last reading really was settled; what
            // changed is that the reader is no longer live, and `acceptable()` gates on the
            // status. Clearing both would have made the status check in `acceptable()`
            // unreachable — two layers each covering for the other, which is the shape this
            // project has repeatedly found a dead guard hiding in.
            this.set({ status: 'error', error: messageOf(error) });
            this.streak = 0;
        } finally {
            this.polling = false;
        }
    }

    /**
     * Fold one reading into the state. Pure apart from the notification — this is the function the
     * tests drive, and it is the only place the stability streak and the zero latch move.
     */
    private apply(reading: ScaleReading): void {
        const grossKg = toKilograms(reading.weight, reading.unit);
        const same = Math.abs(grossKg - this.state.grossKg) < this.epsilonKg;

        this.streak = reading.stable && same ? this.streak + 1 : reading.stable ? 1 : 0;

        const netKg = round3(grossKg - this.state.tareKg);
        const stable = this.streak >= this.stableSamples;

        // The latch only arms on a *settled* zero. A pan swinging through zero on its way up is not
        // the item having been removed, and accepting it would give the cashier a way to weigh the
        // same block of cheese twice by nudging it.
        const zeroed = this.state.zeroed || (stable && Math.abs(netKg) <= this.zeroToleranceKg);

        this.set({
            status: 'live',
            reading,
            grossKg: round3(grossKg),
            netKg,
            stable,
            zeroed,
            error: null,
        });
    }

    /**
     * Zero the scale. Asks the device first; a transport without `zero()`, or one that refuses,
     * falls back to a software tare of whatever is on the pan right now.
     */
    async zero(): Promise<void> {
        if (this.transport.zero) {
            try {
                if (await this.transport.zero()) {
                    this.streak = 0;
                    this.set({ tareKg: 0, netKg: 0, stable: false, zeroed: true });
                    return;
                }
            } catch {
                // Fall through to the software tare: a scale that cannot be commanded is still a
                // scale, and refusing to weigh at all would be worse than taring in the browser.
            }
        }
        this.tare();
    }

    /** Software tare: the current gross becomes the new zero. */
    tare(): void {
        this.streak = 0;
        this.set({ tareKg: this.state.grossKg, netKg: 0, stable: false, zeroed: true });
    }

    /**
     * May the current reading be put on a line?
     *
     * All four conditions, and none of them is redundant: an unstable reading is wrong, a
     * zero-or-negative one is not a sale, an un-zeroed pan means the previous item never came off,
     * and a reader that is not live has no reading at all.
     */
    acceptable(): boolean {
        const { status, stable, netKg, zeroed } = this.state;
        return status === 'live' && stable && zeroed && netKg > this.zeroToleranceKg;
    }

    /**
     * Record that `netKg` went onto a line. Re-arms the zero requirement, so the next weighing
     * cannot be accepted until the pan has been seen empty again (rule 4).
     */
    accepted(): void {
        this.set({ zeroed: false });
    }
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
