import { applyRounding, HALF_UP, type RoundingMode } from './rounding';

/** §2.1.5 — the internal working scale. No intermediate value carries more fractional digits. */
export const MAX_SCALE = 12;

/** §2.1.6 — unit prices are reported at scale 4, matching `decimal(16,4)` in the schema. */
export const PRICE_SCALE = 4;

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

const POW10: bigint[] = [];
function pow10(n: number): bigint {
    if (n < 0) {
        throw new Error(`pow10 of negative exponent ${n}`);
    }
    for (let i = POW10.length; i <= n; i++) {
        POW10[i] = i === 0 ? 1n : POW10[i - 1]! * 10n;
    }
    return POW10[n]!;
}

/**
 * An exact decimal — docs/spec/04-tax-engine.md §2.
 *
 * Value = (-1)^neg * unscaled * 10^-scale. Backed by `bigint`; **no IEEE-754 anywhere** (§1.3).
 * Immutable: every operation returns a new instance.
 */
export class Decimal {
    /** @internal */
    private constructor(
        readonly neg: boolean,
        readonly unscaled: bigint,
        readonly scale: number,
    ) {}

    /** §2.1.1 / §2.1.2 — the only constructor; normalises negative zero away. */
    static make(neg: boolean, unscaled: bigint, scale: number): Decimal {
        if (unscaled < 0n) {
            throw new Error('unscaled must be non-negative');
        }
        if (scale < 0) {
            throw new Error('scale must be non-negative');
        }
        return new Decimal(unscaled === 0n ? false : neg, unscaled, scale);
    }

    /** §1.2 — parse a decimal string. Rejects exponents, leading `+`, bare `.5` and `1.`. */
    static of(value: string | Decimal): Decimal {
        if (value instanceof Decimal) {
            return value;
        }
        if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
            throw new Error(`invalid decimal string ${JSON.stringify(value)}`);
        }
        const neg = value.charCodeAt(0) === 45; // '-'
        const body = neg ? value.slice(1) : value;
        const dot = body.indexOf('.');
        if (dot === -1) {
            return Decimal.make(neg, BigInt(body), 0);
        }
        const frac = body.slice(dot + 1);
        return Decimal.make(neg, BigInt(body.slice(0, dot) + frac), frac.length);
    }

    /** Convenience for small integers produced by the algorithm itself (signs, counters). */
    static fromInt(n: number): Decimal {
        if (!Number.isSafeInteger(n)) {
            throw new Error(`not a safe integer: ${n}`);
        }
        return Decimal.make(n < 0, BigInt(Math.abs(n)), 0);
    }

    /** §2.1.4 */
    toString(): string {
        const digits = this.unscaled.toString();
        let body: string;
        if (this.scale === 0) {
            body = digits;
        } else {
            const padded = digits.padStart(this.scale + 1, '0');
            const cut = padded.length - this.scale;
            body = `${padded.slice(0, cut)}.${padded.slice(cut)}`;
        }
        return this.neg && this.unscaled !== 0n ? `-${body}` : body;
    }

    toJSON(): string {
        return this.toString();
    }

    /** @internal signed unscaled value re-based on `scale` (which must be >= this.scale). */
    private signedAt(scale: number): bigint {
        const v = this.unscaled * pow10(scale - this.scale);
        return this.neg ? -v : v;
    }

    private static fromSigned(v: bigint, scale: number): Decimal {
        return Decimal.make(v < 0n, v < 0n ? -v : v, scale);
    }

    isZero(): boolean {
        return this.unscaled === 0n;
    }

    signum(): number {
        if (this.unscaled === 0n) return 0;
        return this.neg ? -1 : 1;
    }

    negate(): Decimal {
        return Decimal.make(!this.neg, this.unscaled, this.scale);
    }

    abs(): Decimal {
        return Decimal.make(false, this.unscaled, this.scale);
    }

    /** §2.2.1 — exact, result scale = max(scales). */
    add(other: string | Decimal): Decimal {
        const o = Decimal.of(other);
        const s = Math.max(this.scale, o.scale);
        return Decimal.fromSigned(this.signedAt(s) + o.signedAt(s), s);
    }

    /** §2.2.1 */
    sub(other: string | Decimal): Decimal {
        return this.add(Decimal.of(other).negate());
    }

    /** §2.2.2 — exact product, then clamped to MAX_SCALE (§2.2.3). */
    mul(other: string | Decimal): Decimal {
        const o = Decimal.of(other);
        return Decimal.make(this.neg !== o.neg, this.unscaled * o.unscaled, this.scale + o.scale).clamp();
    }

    /** §2.2.3 */
    clamp(): Decimal {
        return this.scale <= MAX_SCALE ? this : this.withScale(MAX_SCALE, HALF_UP);
    }

    /** §2.2.4 */
    div(other: string | Decimal, scale: number = MAX_SCALE, mode: RoundingMode = HALF_UP): Decimal {
        const o = Decimal.of(other);
        if (o.unscaled === 0n) {
            throw new Error('division by zero');
        }
        const shift = scale + o.scale - this.scale;
        const num = shift > 0 ? this.unscaled * pow10(shift) : this.unscaled;
        const den = shift < 0 ? o.unscaled * pow10(-shift) : o.unscaled;
        const q = num / den;
        const r = num % den;
        return Decimal.make(this.neg !== o.neg, applyRounding(q, r, den, mode), scale);
    }

    /** §2.2.7 */
    withScale(n: number, mode: RoundingMode = HALF_UP): Decimal {
        if (n < 0) {
            throw new Error('scale must be non-negative');
        }
        if (n >= this.scale) {
            return Decimal.make(this.neg, this.unscaled * pow10(n - this.scale), n);
        }
        const den = pow10(this.scale - n);
        const q = this.unscaled / den;
        const r = this.unscaled % den;
        return Decimal.make(this.neg, applyRounding(q, r, den, mode), n);
    }

    /** §3.3.2 — round to the nearest multiple of `step`. A zero step is a no-op. */
    roundToStep(step: string | Decimal, mode: RoundingMode = HALF_UP): Decimal {
        const s = Decimal.of(step);
        if (s.isZero()) {
            return this;
        }
        return this.div(s, 0, mode).mul(s);
    }

    /** §2.2.6 — value comparison; `1.50` equals `1.5`. */
    compare(other: string | Decimal): number {
        const o = Decimal.of(other);
        const s = Math.max(this.scale, o.scale);
        const a = this.signedAt(s);
        const b = o.signedAt(s);
        return a > b ? 1 : a < b ? -1 : 0;
    }

    eq(other: string | Decimal): boolean {
        return this.compare(other) === 0;
    }

    lt(other: string | Decimal): boolean {
        return this.compare(other) < 0;
    }

    gt(other: string | Decimal): boolean {
        return this.compare(other) > 0;
    }

    lte(other: string | Decimal): boolean {
        return this.compare(other) <= 0;
    }

    gte(other: string | Decimal): boolean {
        return this.compare(other) >= 0;
    }
}

export const ZERO = Decimal.of('0');
export const ONE = Decimal.of('1');
export const HUNDRED = Decimal.of('100');
export const MINUS_ONE = Decimal.of('-1');
