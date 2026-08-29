import { describe, expect, it } from 'vitest';

import {
    attachBarcodeSource,
    cameraBarcodeSource,
    detectCapabilities,
    fakeBarcodeSource,
    selectBarcodeSource,
    type CameraStream,
} from './barcode-source';
import { installCatalog, makeNomenclature, makeProduct, makeRule, makeVariant } from './__fixtures__/catalog';
import { routeScan } from './scanner';

/**
 * BAN-421 — the camera scanner, minus the decoder (REG-081, XCT-059).
 *
 * **AC1 ("a barcode scanned through the device camera adds the same line an HID scan would") is a
 * hand test and is not covered here.** Reading a barcode out of a video frame needs a camera and a
 * platform decoder, and CI has neither; the alternative — a wasm decoding library — would be the
 * tenth and largest runtime dependency in a `package.json` with nine, added on the strength of a
 * green build that never executed it.
 *
 * What *is* covered is everything either side of the decoder, which is where the bugs actually live:
 * which source gets chosen, that a decoded string reaches `routeScan` unchanged, and that the camera
 * is released on the way out — including the unmount-while-opening race that leaves the indicator
 * light on until the tab closes.
 */

const PLAIN_EAN = '5901234123457';

describe('selectBarcodeSource', () => {
    it('runs the camera only when the device can', () => {
        expect(selectBarcodeSource('camera', { camera: true })).toBe('camera');
    });

    it('falls back to the wedge rather than leaving the till unable to scan', () => {
        // A preference is not a capability. Honouring "camera" on a device with none would attach no
        // source at all, and the hardware scanner sitting on the counter would stop working.
        expect(selectBarcodeSource('camera', { camera: false })).toBe('hid');
    });

    it('leaves the wedge alone when it is what was asked for', () => {
        expect(selectBarcodeSource('hid', { camera: true })).toBe('hid');
    });
});

describe('detectCapabilities', () => {
    it('needs both the decoder and a camera, not either', () => {
        const withDetector = { BarcodeDetector: class {}, navigator: {} } as unknown as typeof globalThis;
        const withCamera = { navigator: { mediaDevices: { getUserMedia: () => {} } } } as unknown as typeof globalThis;
        const both = {
            BarcodeDetector: class {},
            navigator: { mediaDevices: { getUserMedia: () => {} } },
        } as unknown as typeof globalThis;

        expect(detectCapabilities(withDetector).camera).toBe(false);
        expect(detectCapabilities(withCamera).camera).toBe(false);
        expect(detectCapabilities(both).camera).toBe(true);
    });

    it('reports no camera under the test runner, which is the honest answer', () => {
        expect(detectCapabilities().camera).toBe(false);
    });
});

describe('the decode → routeScan seam', () => {
    it('routes a code from a non-HID source exactly as a wedge scan', () => {
        // AC4: the nomenclature parser is invoked from one place for both sources. A camera source
        // that re-implemented any of this is the failure mode; a string is the whole contract.
        installCatalog({
            products: [makeProduct({ id: 1, name: 'Coffee' })],
            variants: [makeVariant({ id: 11, product_id: 1, barcode: PLAIN_EAN })],
            nomenclature: makeNomenclature([makeRule({ id: 1, rule_type: 'product', pattern: '.*', sequence: 1 })]),
        });

        const source = fakeBarcodeSource('camera');
        const seen: string[] = [];
        const detach = attachBarcodeSource(source, (code) => seen.push(code));

        source.emit(PLAIN_EAN);
        detach();

        expect(seen).toEqual([PLAIN_EAN]);
        const action = routeScan(seen[0]!);
        expect(action.kind).toBe('product');
        expect(action.kind === 'product' && action.variant.id).toBe(11);
    });
});

/** `start` is async even for the wedge, so let its resolution land before asserting on teardown. */
async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('attachBarcodeSource', () => {
    it('stops the source and delivers nothing afterwards', async () => {
        const source = fakeBarcodeSource();
        const seen: string[] = [];
        const detach = attachBarcodeSource(source, (code) => seen.push(code));
        await settle();

        detach();
        source.emit(PLAIN_EAN);

        expect(source.stops).toBe(1);
        expect(source.running).toBe(false);
        expect(seen).toEqual([]);
    });

    it('is safe to detach twice', async () => {
        const source = fakeBarcodeSource();
        const detach = attachBarcodeSource(source, () => {});
        await settle();

        detach();
        detach();

        expect(source.stops).toBe(1);
    });

    it('releases a source that finishes starting after the screen was left', async () => {
        // The leak REG-081 actually warns about: `getUserMedia` takes a moment, the cashier taps
        // away, and the effect cleanup runs before there is anything to stop. Without this the
        // camera stays open — and its light stays on — until the tab is closed.
        let resolveStart: (stop: () => void) => void = () => {};
        let stopped = 0;

        const slow = {
            kind: 'camera' as const,
            start: () =>
                new Promise<() => void>((resolve) => {
                    resolveStart = resolve;
                }),
        };

        const detach = attachBarcodeSource(slow, () => {});
        detach();
        resolveStart(() => {
            stopped += 1;
        });

        await Promise.resolve();
        await Promise.resolve();

        expect(stopped).toBe(1);
    });

    it('does not crash the screen when the camera permission is refused', async () => {
        const refused = {
            kind: 'camera' as const,
            start: () => Promise.reject(new Error('NotAllowedError')),
        };

        const detach = attachBarcodeSource(refused, () => {});
        await Promise.resolve();
        await Promise.resolve();

        expect(() => detach()).not.toThrow();
    });
});

describe('cameraBarcodeSource', () => {
    function harness(codes: string[][]) {
        let tracksStopped = 0;
        let unpresented = 0;
        const scheduled: Array<() => void> = [];
        let cancelled = 0;
        let round = 0;
        let decodes = 0;

        const stream: CameraStream = {
            getTracks: () => [
                {
                    stop() {
                        tracksStopped += 1;
                    },
                },
            ],
        };

        const source = cameraBarcodeSource({
            openStream: () => Promise.resolve(stream),
            createDecoder: () =>
                Promise.resolve({
                    detect: () => {
                        decodes += 1;
                        const batch = codes[round] ?? [];
                        round += 1;
                        return Promise.resolve(batch.map((rawValue) => ({ rawValue })));
                    },
                }),
            present: () => () => {
                unpresented += 1;
            },
            frame: () => 'video',
            schedule: (run) => {
                scheduled.push(run);
                return () => {
                    cancelled += 1;
                };
            },
        });

        const step = async (): Promise<void> => {
            const next = scheduled.pop();
            next?.();
            // Let the decode microtasks settle.
            for (let i = 0; i < 6; i++) await Promise.resolve();
        };

        return {
            source,
            step,
            get tracksStopped() {
                return tracksStopped;
            },
            get unpresented() {
                return unpresented;
            },
            get cancelled() {
                return cancelled;
            },
            get decodes() {
                return decodes;
            },
            get pending() {
                return scheduled.length;
            },
        };
    }

    it('emits every code the platform decoder reads', async () => {
        const h = harness([[PLAIN_EAN, '4006381333931']]);
        const seen: string[] = [];

        await h.source.start((code) => seen.push(code));
        await h.step();

        expect(seen).toEqual([PLAIN_EAN, '4006381333931']);
    });

    it('releases the stream, the loop and the preview together', async () => {
        // All three, because each on its own looks fine on a desktop and leaks on a tablet: tracks
        // left running keep the indicator light on, a loop left running decodes a dead stream, and a
        // <video> still holding the stream shows a frozen frame that reads as "still scanning".
        const h = harness([[]]);
        const release = await h.source.start(() => {});

        release();

        expect(h.tracksStopped).toBe(1);
        expect(h.cancelled).toBe(1);
        expect(h.unpresented).toBe(1);
    });

    it('stops decoding once released, not merely stops emitting', async () => {
        // Asserting only on `seen` here was a test that could not fail: the guard *inside* the
        // result loop already blocks the emission, so deleting the guard at the top of the tick
        // survived. What that guard actually protects is the decode itself — a scheduler that fires
        // once more after its canceller (a stale rAF, a timer race) would otherwise run the decoder
        // against a stream whose tracks are already stopped, every frame, forever.
        const h = harness([[PLAIN_EAN], ['4006381333931']]);
        const seen: string[] = [];
        const release = await h.source.start((code) => seen.push(code));

        await h.step();
        const decodesBeforeRelease = h.decodes;
        release();
        await h.step();

        expect(seen).toEqual([PLAIN_EAN]);
        expect(h.decodes).toBe(decodesBeforeRelease);
    });

    it('keeps scanning after a frame the decoder chokes on', async () => {
        // A half-visible label throws. Tearing the scanner down over it would mean the camera stops
        // working the first time someone waves a barcode past it at an angle.
        let calls = 0;
        const stream: CameraStream = { getTracks: () => [{ stop: () => {} }] };
        const scheduled: Array<() => void> = [];

        const source = cameraBarcodeSource({
            openStream: () => Promise.resolve(stream),
            createDecoder: () =>
                Promise.resolve({
                    detect: () => {
                        calls += 1;
                        return calls === 1
                            ? Promise.reject(new Error('bad frame'))
                            : Promise.resolve([{ rawValue: PLAIN_EAN }]);
                    },
                }),
            frame: () => 'video',
            schedule: (run) => {
                scheduled.push(run);
                return () => {};
            },
        });

        const seen: string[] = [];
        await source.start((code) => seen.push(code));

        for (let round = 0; round < 2; round++) {
            scheduled.pop()?.();
            for (let i = 0; i < 6; i++) await Promise.resolve();
        }

        expect(seen).toEqual([PLAIN_EAN]);
    });

    it('closes the camera when the decoder cannot be built', async () => {
        // `getUserMedia` has already resolved at that point. Throwing without releasing leaves the
        // camera open on a screen that is not even scanning.
        let tracksStopped = 0;
        const source = cameraBarcodeSource({
            openStream: () =>
                Promise.resolve({ getTracks: () => [{ stop: () => (tracksStopped += 1) }] }),
            createDecoder: () => Promise.reject(new Error('barcode_detector_unavailable')),
            frame: () => 'video',
            schedule: (run) => {
                void run;
                return () => {};
            },
        });

        await expect(source.start(() => {})).rejects.toThrow('barcode_detector_unavailable');
        expect(tracksStopped).toBe(1);
    });

    it('never opens a second decode loop per start', async () => {
        const h = harness([[], [], []]);
        await h.source.start(() => {});

        await h.step();
        await h.step();

        expect(h.pending).toBe(1);
    });
});

describe('fakeBarcodeSource', () => {
    it('reports what a leak test needs to see', async () => {
        const source = fakeBarcodeSource();
        expect(source.running).toBe(false);

        const detach = attachBarcodeSource(source, () => {});
        expect(source.starts).toBe(1);
        expect(source.running).toBe(true);
        await settle();

        detach();
        expect(source.running).toBe(false);
    });
});
