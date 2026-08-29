import type { ScaleReading, WeightUnit } from './types';

/**
 * The ASCII frames RS-232 scales speak (spec 03 §7.7).
 *
 * Split out from `web-serial.ts` on purpose. The port cannot be opened without Chromium, a user
 * gesture and a physical scale, so nothing in that file is verifiable here — but the part that
 * turns bytes into a number is a pure function, and it is also the part that gets a decimal point
 * wrong and puts 12 kg of cheese on a bill. It is tested; the port plumbing is not, and this file
 * is where the line between the two is drawn.
 *
 * Two families cover the scales a bistro actually buys:
 *
 *  - **Mettler-Toledo SICS** — `S S      0.200 kg`. Leading `S`, then a status letter
 *    (`S` stable, `D` dynamic/moving, `I` invalid command, `+`/`-` out of range).
 *  - **Toledo Dialog 06 / CAS** — `ST,GS,   0.200kg`. Two comma-separated codes, then the value.
 *    `ST` stable / `US` unstable; `GS` gross / `NT` net.
 *
 * Anything else returns null. A frame we cannot read must never become a weight of zero: zero is a
 * legitimate reading (an empty pan) and the zero check in `reader.ts` depends on it meaning that.
 */

/**
 * The units a line may be sold in. The lookup is the *only* place a unit is validated — the two
 * frame patterns below deliberately match any alphabetic suffix rather than an alternation of
 * these three.
 *
 * Spelling it `(kg|g|lb)` in the pattern would push the check into the regex, where a frame
 * reporting ounces stops being "a frame in a unit we do not sell in" and becomes "not a frame at
 * all". Both end in null, so the behaviour is identical and nothing observable changes — but the
 * branch below then becomes unreachable, and unreachable code is code no test can defend.
 */
const UNITS: Record<string, WeightUnit> = { kg: 'kg', g: 'g', lb: 'lb' };

/** `S S      0.200 kg` and its `S D` unstable sibling. */
const SICS = /^S\s+([SD])\s+(-?\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i;

/** `ST,GS,   0.200kg` / `US,NT,-0.005 kg`. */
const DIALOG = /^(ST|US),(GS|NT),\s*([+-]?\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i;

/**
 * Parse one complete frame. `at` is passed in rather than read from the clock so the caller owns
 * the timestamp, and so this stays a pure function.
 */
export function parseScaleFrame(frame: string, at: number): ScaleReading | null {
    const line = frame.trim();
    if (line === '') return null;

    const sics = SICS.exec(line);
    if (sics) {
        const [, status, value, unit] = sics;
        return build(value, unit, status?.toUpperCase() === 'S', 0, at);
    }

    const dialog = DIALOG.exec(line);
    if (dialog) {
        const [, stability, , value, unit] = dialog;
        // `tare: 0` for both `GS` and `NT`, and that is not an oversight. Neither frame carries a
        // tare *figure*: `NT` means the device already subtracted one and is reporting net, so
        // there is nothing left for the reader to subtract; `GS` means no device tare is in play.
        // The mode code is still matched because a frame with neither is not a Dialog 06 frame.
        return build(value, unit, stability?.toUpperCase() === 'ST', 0, at);
    }

    return null;
}

function build(
    value: string | undefined,
    unit: string | undefined,
    stable: boolean,
    tare: number,
    at: number,
): ScaleReading | null {
    if (value === undefined || unit === undefined) return null;

    const weight = Number.parseFloat(value);
    if (!Number.isFinite(weight)) return null;

    const resolved = UNITS[unit.toLowerCase()];
    // A unit we do not sell in — ounces on a scale someone brought back from the US. Refused
    // rather than assumed to be kilograms, which would be a 28x error on the bill.
    if (resolved === undefined) return null;

    return { weight, unit: resolved, stable, tare, at };
}

/**
 * Split a rolling serial buffer into complete frames.
 *
 * Serial delivers bytes, not messages: one `read()` can carry half a frame, three frames, or a
 * frame and a half. Returning the remainder rather than dropping it is the difference between a
 * scale that works and one that reports a weight every few seconds — the split-frame case is how
 * `0.200` becomes `0.2` and then `00`.
 */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
    const parts = buffer.split(/\r\n|\r|\n/);
    const rest = parts.pop() ?? '';
    return { frames: parts.filter((part) => part.trim() !== ''), rest };
}
