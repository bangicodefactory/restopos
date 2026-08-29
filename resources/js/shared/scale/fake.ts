import type { ScaleReading, ScaleTransport, WeightUnit } from './types';

/**
 * A scale you can drive from a test (or from a dev till with no hardware on the bench).
 *
 * Mirrors the injectable `transports` map in `shared/printing/router.ts` — the reason the printing
 * layer has been testable at all is that a fake sits behind the same interface as the real thing,
 * so the rules are exercised by the same code path production uses rather than by a mock of it.
 *
 * `place()` is the whole API: it is a hand putting something on the pan. `unstable` reproduces the
 * settling period, which is the state most of the guards exist for.
 */
export class FakeScaleTransport implements ScaleTransport {
    readonly kind = 'fake' as const;

    /** How many times `read()` has been called. Proves the poll rate without a wall clock. */
    reads = 0;
    connects = 0;
    disconnects = 0;
    zeroCalls = 0;

    private connected = false;
    private weight = 0;
    private unit: WeightUnit = 'kg';
    private stable = true;
    private deviceTare = 0;
    private available: boolean;
    private acceptsConnect: boolean;
    /** When set, `zero()` exists and answers this. Undefined means the transport has no `zero`. */
    private zeroAnswer: boolean | undefined;
    private failNextRead: string | null = null;
    /** `read()` resolves null this many more times — the "device said nothing this tick" case. */
    private silentReads = 0;

    constructor(
        options: {
            available?: boolean;
            acceptsConnect?: boolean;
            /** Omit to build a transport with no `zero()` at all, exercising the tare fallback. */
            zero?: boolean;
            unit?: WeightUnit;
        } = {},
    ) {
        this.available = options.available ?? true;
        this.acceptsConnect = options.acceptsConnect ?? true;
        this.zeroAnswer = options.zero;
        this.unit = options.unit ?? 'kg';

        if (options.zero !== undefined) {
            this.zero = async (): Promise<boolean> => {
                this.zeroCalls += 1;
                if (this.zeroAnswer === true) {
                    this.deviceTare += this.weight;
                    this.weight = 0;
                }
                return this.zeroAnswer === true;
            };
        }
    }

    zero?: () => Promise<boolean>;

    // ── the hand on the pan ──────────────────────────────────────────────────

    /** Put something on (or take it off, with 0). Settles immediately unless told otherwise. */
    place(weight: number, options: { stable?: boolean } = {}): this {
        this.weight = weight;
        this.stable = options.stable ?? true;
        return this;
    }

    /** The next `read()` throws. Used to prove a transport failure surfaces rather than lies. */
    breakNextRead(message: string): this {
        this.failNextRead = message;
        return this;
    }

    /** The next `count` reads resolve null: connected, nothing to report. */
    goSilent(count = 1): this {
        this.silentReads = count;
        return this;
    }

    // ── ScaleTransport ───────────────────────────────────────────────────────

    isAvailable(): boolean {
        return this.available;
    }

    async connect(): Promise<boolean> {
        this.connects += 1;
        this.connected = this.acceptsConnect;
        return this.connected;
    }

    async read(): Promise<ScaleReading | null> {
        this.reads += 1;

        if (this.failNextRead !== null) {
            const message = this.failNextRead;
            this.failNextRead = null;
            throw new Error(message);
        }
        if (this.silentReads > 0) {
            this.silentReads -= 1;
            return null;
        }
        if (!this.connected) return null;

        return {
            weight: this.weight,
            unit: this.unit,
            stable: this.stable,
            tare: this.deviceTare,
            at: Date.now(),
        };
    }

    async disconnect(): Promise<void> {
        this.disconnects += 1;
        this.connected = false;
    }
}
