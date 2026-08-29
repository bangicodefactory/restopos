import { WeightSource } from '@domain/enums';

/**
 * Scale contracts (spec 03 §7.7, XCT-058).
 *
 * Spec 03 names `packages/hardware/src/scale/` as the home for these. That package does not exist,
 * and `packages/domain` cannot host them either: CONVENTIONS bars it from runtime dependencies and
 * a WebSerial transport is nothing but a runtime dependency. So they live beside `shared/printing`,
 * which solved the same problem — one interface, several transports, one of which is a fake the
 * tests drive.
 *
 * The split is deliberate and is the whole reason this file is separate from `reader.ts`:
 *
 *  - a **transport** does I/O and no thinking. It hands back whatever the device said.
 *  - the **reader** does all the thinking and no I/O: unit conversion, tare, stability, the zero
 *    check, and the 4 Hz poll window. That is where every rule an inspector would ask about lives,
 *    and it is pure enough to unit-test without a scale, a browser or a user gesture.
 */

/** Re-exported so the scale module is one import for a component. Defined with the rest of
 * the PHP-mirrored enums, because `pos_order_lines.weight_source` is cast to it server-side. */
export { WeightSource };

export type WeightUnit = 'kg' | 'lb' | 'g';

/** Exactly the shape spec 03 §7.7 declares. */
export type ScaleReading = {
    /** Gross weight as the device reported it, in `unit`. */
    weight: number;
    unit: WeightUnit;
    /** The device's own stability flag. A moving pan reads `false`. */
    stable: boolean;
    /** Tare the *device* is applying, in `unit`. Software tare is the reader's business. */
    tare: number;
    /** Epoch milliseconds the reading was taken. */
    at: number;
};

export type ScaleTransportKind = 'webserial' | 'proxy' | 'fake';

/**
 * One way of talking to a scale.
 *
 * `read()` resolving `null` means "connected, nothing to report this tick" — a poll that raced the
 * device's own output cycle. It is not an error and must not knock the reader out of `live`.
 */
export type ScaleTransport = {
    readonly kind: ScaleTransportKind;
    /** Can this transport run in this browser at all? Checked before anything is attempted. */
    isAvailable(): boolean;
    /** May require a user gesture (WebSerial does). Resolves false when the operator declined. */
    connect(): Promise<boolean>;
    read(): Promise<ScaleReading | null>;
    /**
     * Ask the *device* to zero itself. Optional: many scales have no command interface, and the
     * reader falls back to a software tare when this is absent or resolves false.
     */
    zero?(): Promise<boolean>;
    disconnect(): Promise<void>;
};

/** Grams and pounds exist because scales are sold with them; the till stores kilograms. */
const KG_PER: Record<WeightUnit, number> = {
    kg: 1,
    g: 0.001,
    lb: 0.45359237,
};

export function toKilograms(weight: number, unit: WeightUnit): number {
    return weight * KG_PER[unit];
}
