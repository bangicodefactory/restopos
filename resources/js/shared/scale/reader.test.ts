import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeScaleTransport } from './fake';
import { parseScaleFrame, splitFrames } from './protocol';
import { ScaleReader } from './reader';
import { resolveScaleTransport } from './resolve';
import { toKilograms } from './types';

/**
 * XCT-058 — the scale reader, the frame parser and the `iot_scale` gate.
 *
 * The ticket asked for this at `tests/js/register/scale-driver.test.ts`. That directory does not
 * exist and `vitest.config.ts` does not scan it, so a test written there would have passed review
 * by never running — the same trap the config's own comments record for the service worker and the
 * kitchen `.tsx` glob. It is colocated instead.
 *
 * What is NOT covered here, stated plainly: `WebSerialScaleTransport` opening a real port.
 * `navigator.serial` needs Chromium, a user gesture and a physical RS-232 scale. Its two decisions
 * that *are* pure — framing and parsing — are in `protocol.ts` and are covered below.
 */

const INTERVAL = 250;

function reader(transport: FakeScaleTransport, options: Partial<{ stableSamples: number }> = {}): ScaleReader {
    return new ScaleReader({ transport, intervalMs: INTERVAL, stableSamples: options.stableSamples ?? 2 });
}

/** Run `count` polls' worth of fake time and let the promises inside each tick settle. */
async function tick(count = 1): Promise<void> {
    for (let i = 0; i < count; i += 1) {
        await vi.advanceTimersByTimeAsync(INTERVAL);
    }
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('polling window (spec 03 §7.7 — 4 Hz, and never while closed)', () => {
    it('polls four times a second once started', async () => {
        const scale = new FakeScaleTransport().place(0);
        const r = reader(scale);

        await r.start();
        expect(scale.reads).toBe(0);

        await tick(4);
        expect(scale.reads).toBe(4);
    });

    it('stops polling and closes the port on stop', async () => {
        const scale = new FakeScaleTransport().place(0.2);
        const r = reader(scale);

        await r.start();
        await tick(2);
        const during = scale.reads;
        expect(during).toBeGreaterThan(0);

        await r.stop();
        expect(scale.disconnects).toBe(1);
        expect(r.isRunning()).toBe(false);

        await tick(10);
        expect(scale.reads).toBe(during);
    });

    it('does not open a second interval when started twice', async () => {
        const scale = new FakeScaleTransport().place(0);
        const r = reader(scale);

        await r.start();
        await r.start();
        expect(scale.connects).toBe(1);

        await tick(4);
        expect(scale.reads).toBe(4);
    });

    it('does not start polling when the dialog closed while connecting', async () => {
        // The race the guard after `await connect()` exists for: the cashier cancels before the
        // port answers. Without it the interval starts on a reader nobody is watching.
        const scale = new FakeScaleTransport().place(0.2);
        const r = reader(scale);

        const starting = r.start();
        await r.stop();
        await starting;

        expect(r.isRunning()).toBe(false);
        await tick(4);
        expect(scale.reads).toBe(0);
    });

    it('reports unavailable without connecting when the transport cannot run here', async () => {
        const scale = new FakeScaleTransport({ available: false });
        const r = reader(scale);

        await r.start();

        expect(r.getState().status).toBe('unavailable');
        expect(scale.connects).toBe(0);
        expect(r.isRunning()).toBe(false);
    });

    it('reports unavailable when the operator declines the port', async () => {
        const scale = new FakeScaleTransport({ acceptsConnect: false });
        const r = reader(scale);

        await r.start();

        expect(scale.connects).toBe(1);
        expect(r.getState().status).toBe('unavailable');
        expect(r.isRunning()).toBe(false);
    });
});

describe('stability (rule 2)', () => {
    it('refuses a reading the device calls unstable, however large', async () => {
        const scale = new FakeScaleTransport().place(0.4, { stable: false });
        const r = reader(scale);

        await r.start();
        await tick(6);

        expect(r.getState().netKg).toBe(0.4);
        expect(r.getState().stable).toBe(false);
        expect(r.acceptable()).toBe(false);
    });

    it('requires the value to hold for two consecutive stable polls', async () => {
        const scale = new FakeScaleTransport().place(0);
        const r = reader(scale);

        await r.start();
        await tick(3); // sees zero, settles, arms the zero latch
        expect(r.getState().zeroed).toBe(true);

        scale.place(0.2);
        await tick(1);
        // First poll at the new value: stable flag yes, but it has not *held* yet.
        expect(r.getState().stable).toBe(false);
        expect(r.acceptable()).toBe(false);

        await tick(1);
        expect(r.getState().stable).toBe(true);
        expect(r.acceptable()).toBe(true);
    });

    it('resets the streak when the pan moves again', async () => {
        const scale = new FakeScaleTransport().place(0);
        const r = reader(scale);

        await r.start();
        await tick(3);
        scale.place(0.2);
        await tick(3);
        expect(r.acceptable()).toBe(true);

        scale.place(0.25, { stable: false });
        await tick(1);
        expect(r.getState().stable).toBe(false);
        expect(r.acceptable()).toBe(false);
    });
});

describe('the zero check (rule 4 — the mechanical half of REG-077)', () => {
    it('refuses the very first weighing until the pan has been seen empty', async () => {
        // The scale already has cheese on it when the dialog opens. Nobody watched it go on.
        const scale = new FakeScaleTransport().place(0.2);
        const r = reader(scale);

        await r.start();
        await tick(6);

        expect(r.getState().netKg).toBe(0.2);
        expect(r.getState().stable).toBe(true);
        expect(r.getState().zeroed).toBe(false);
        expect(r.acceptable()).toBe(false);
    });

    it('refuses a second weighing until the item comes off', async () => {
        const scale = new FakeScaleTransport().place(0);
        const r = reader(scale);

        await r.start();
        await tick(3);
        scale.place(0.2);
        await tick(3);
        expect(r.acceptable()).toBe(true);

        r.accepted();
        expect(r.acceptable()).toBe(false);

        // Adding a gram is the cheap way round Odoo's "the weight must differ" rule. It does not
        // work here: the pan never returned to zero.
        scale.place(0.201);
        await tick(3);
        expect(r.getState().stable).toBe(true);
        expect(r.acceptable()).toBe(false);

        scale.place(0);
        await tick(3);
        scale.place(0.201);
        await tick(3);
        expect(r.acceptable()).toBe(true);
    });

    it('does not arm on an unstable pass through zero', async () => {
        const scale = new FakeScaleTransport().place(0.2);
        const r = reader(scale);

        await r.start();
        await tick(3);
        expect(r.getState().zeroed).toBe(false);

        // Swinging through zero on the way somewhere else is not the item being removed.
        scale.place(0, { stable: false });
        await tick(3);
        expect(r.getState().zeroed).toBe(false);
    });

    it('treats a weight inside the deadband as not a sale', async () => {
        const scale = new FakeScaleTransport().place(0);
        const r = reader(scale);

        await r.start();
        await tick(3);
        expect(r.getState().zeroed).toBe(true);

        scale.place(0.001); // 1 g: load-cell drift, not cheese
        await tick(3);
        expect(r.getState().stable).toBe(true);
        expect(r.acceptable()).toBe(false);
    });
});

describe('tare and zero (rule 3)', () => {
    it('software-tares a container out of the net weight', async () => {
        const scale = new FakeScaleTransport().place(0);
        const r = reader(scale);

        await r.start();
        await tick(3);

        scale.place(0.05); // the tub
        await tick(3);
        r.tare();
        expect(r.getState().tareKg).toBe(0.05);
        expect(r.getState().netKg).toBe(0);

        scale.place(0.25); // tub plus olives
        await tick(3);
        expect(r.getState().netKg).toBe(0.2);
        expect(r.acceptable()).toBe(true);
    });

    it('asks the device to zero when the transport can', async () => {
        const scale = new FakeScaleTransport({ zero: true }).place(0.05);
        const r = reader(scale);

        await r.start();
        await tick(3);
        await r.zero();

        expect(scale.zeroCalls).toBe(1);
        // The device absorbed it, so there is nothing for the software tare to hold.
        expect(r.getState().tareKg).toBe(0);
        expect(r.getState().netKg).toBe(0);
    });

    it('falls back to a software tare when the device refuses to zero', async () => {
        const scale = new FakeScaleTransport({ zero: false }).place(0.05);
        const r = reader(scale);

        await r.start();
        await tick(3);
        await r.zero();

        expect(scale.zeroCalls).toBe(1);
        expect(r.getState().tareKg).toBe(0.05);
        expect(r.getState().netKg).toBe(0);
    });

    it('falls back to a software tare when the transport has no zero command at all', async () => {
        const scale = new FakeScaleTransport().place(0.05);
        expect(scale.zero).toBeUndefined();
        const r = reader(scale);

        await r.start();
        await tick(3);
        await r.zero();

        expect(r.getState().tareKg).toBe(0.05);
    });

    it('a tare arms the zero latch — the pan is empty by definition afterwards', async () => {
        const scale = new FakeScaleTransport().place(0.05);
        const r = reader(scale);

        await r.start();
        await tick(3);
        expect(r.getState().zeroed).toBe(false);

        r.tare();
        expect(r.getState().zeroed).toBe(true);

        scale.place(0.25);
        await tick(3);
        expect(r.acceptable()).toBe(true);
    });
});

describe('units', () => {
    it('converts to kilograms', () => {
        expect(toKilograms(200, 'g')).toBeCloseTo(0.2, 9);
        expect(toKilograms(1, 'lb')).toBeCloseTo(0.45359237, 9);
        expect(toKilograms(0.2, 'kg')).toBe(0.2);
    });

    it('reads a scale that reports grams as kilograms on the line', async () => {
        const scale = new FakeScaleTransport({ unit: 'g' }).place(0);
        const r = reader(scale);

        await r.start();
        await tick(3);
        scale.place(200);
        await tick(3);

        expect(r.getState().netKg).toBe(0.2);
        expect(r.acceptable()).toBe(true);
    });
});

describe('transport failure', () => {
    it('surfaces a read error instead of holding the last weight as if it were live', async () => {
        const scale = new FakeScaleTransport().place(0);
        const r = reader(scale);

        await r.start();
        await tick(3);
        scale.place(0.2);
        await tick(3);
        expect(r.acceptable()).toBe(true);

        scale.breakNextRead('port lost');
        await tick(1);

        expect(r.getState().status).toBe('error');
        expect(r.getState().error).toBe('port lost');
        expect(r.acceptable()).toBe(false);
    });

    it('treats a silent tick as nothing to report, not as a zero', async () => {
        const scale = new FakeScaleTransport().place(0);
        const r = reader(scale);

        await r.start();
        await tick(3);
        scale.place(0.2);
        await tick(3);
        expect(r.getState().netKg).toBe(0.2);

        scale.goSilent(2);
        await tick(2);

        expect(r.getState().netKg).toBe(0.2);
        expect(r.getState().status).toBe('live');
        expect(r.acceptable()).toBe(true);
    });

    it('recovers after a failed read', async () => {
        const scale = new FakeScaleTransport().place(0);
        const r = reader(scale);

        await r.start();
        await tick(3);
        scale.breakNextRead('glitch');
        await tick(1);
        expect(r.getState().status).toBe('error');

        await tick(3);
        expect(r.getState().status).toBe('live');
    });
});

describe('the iot_scale gate', () => {
    const webserial = new FakeScaleTransport();

    it('returns no transport when the config has the scale switched off', () => {
        expect(resolveScaleTransport({ iot_scale: false }, { webserial })).toBeNull();
    });

    it('returns no transport when there is no config at all', () => {
        expect(resolveScaleTransport(null, { webserial })).toBeNull();
    });

    it('returns no transport for a config that predates the flag', () => {
        // The field is absent, not false. Defaulting an absent flag to *on* would turn a driver on
        // at every till that has never heard of one.
        expect(resolveScaleTransport({}, { webserial })).toBeNull();
    });

    it('returns the transport when iot_scale is on', () => {
        expect(resolveScaleTransport({ iot_scale: true }, { webserial })).toBe(webserial);
    });

    it('skips a transport that cannot run in this browser', () => {
        const absent = new FakeScaleTransport({ available: false });
        const proxy = new FakeScaleTransport();

        expect(resolveScaleTransport({ iot_scale: true }, { webserial: absent, proxy })).toBe(proxy);
        expect(resolveScaleTransport({ iot_scale: true }, { webserial: absent })).toBeNull();
    });

    it('honours the preference order', () => {
        const proxy = new FakeScaleTransport();
        expect(resolveScaleTransport({ iot_scale: true }, { webserial, proxy }, ['proxy', 'webserial'])).toBe(proxy);
    });
});

describe('frame parsing (the testable half of WebSerial)', () => {
    it('reads a stable Mettler SICS frame', () => {
        expect(parseScaleFrame('S S      0.200 kg', 7)).toEqual({
            weight: 0.2,
            unit: 'kg',
            stable: true,
            tare: 0,
            at: 7,
        });
    });

    it('marks a dynamic SICS frame unstable', () => {
        expect(parseScaleFrame('S D      0.204 kg', 7)?.stable).toBe(false);
    });

    it('reads a Toledo Dialog 06 frame, stable and unstable', () => {
        expect(parseScaleFrame('ST,GS,   0.200kg', 1)).toEqual({
            weight: 0.2,
            unit: 'kg',
            stable: true,
            tare: 0,
            at: 1,
        });
        expect(parseScaleFrame('US,NT,  -0.005 kg', 1)).toEqual({
            weight: -0.005,
            unit: 'kg',
            stable: false,
            tare: 0,
            at: 1,
        });
    });

    it('keeps the unit the device reported', () => {
        expect(parseScaleFrame('ST,GS,   200g', 1)?.unit).toBe('g');
        expect(parseScaleFrame('S S      1.5 lb', 1)?.unit).toBe('lb');
    });

    it('returns null for a frame it cannot read rather than a weight of zero', () => {
        // Zero means "the pan is empty" and arms the next weighing. A garbled frame must never say
        // that. Each of these is a real failure mode: line noise, a truncated frame, an error
        // response, a value with no unit, and a unit nothing here sells in.
        for (const junk of ['', '   ', 'S I', 'S S 0.200', '?! garbage', 'ST,GS,', 'S S 0.200 oz']) {
            expect(parseScaleFrame(junk, 1)).toBeNull();
        }
    });

    it('splits a rolling buffer and keeps the incomplete tail', () => {
        expect(splitFrames('S S 0.100 kg\r\nS S 0.2')).toEqual({
            frames: ['S S 0.100 kg'],
            rest: 'S S 0.2',
        });
    });

    it('reassembles a frame split across two serial chunks', () => {
        const first = splitFrames('S S 0.2');
        expect(first.frames).toEqual([]);

        const second = splitFrames(`${first.rest}00 kg\r\n`);
        expect(second.frames).toEqual(['S S 0.200 kg']);
        expect(parseScaleFrame(second.frames[0] ?? '', 1)?.weight).toBe(0.2);
    });

    it('drops blank lines between frames', () => {
        expect(splitFrames('S S 0.100 kg\r\n\r\nS S 0.200 kg\r\n').frames).toEqual([
            'S S 0.100 kg',
            'S S 0.200 kg',
        ]);
    });
});
