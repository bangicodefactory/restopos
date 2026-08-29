import { attachScanner, type ScannerOptions } from './scanner';

/**
 * Where a barcode comes from (REG-080, REG-081, XCT-059).
 *
 * A till has a wedge scanner; a tablet has a camera. Both produce the same thing — a string — and
 * everything downstream of that string is already written and already tested: `routeScan` parses it
 * through the nomenclature, and `resolveScanMiss` asks the server when the catalogue does not know
 * it. The only thing genuinely new about a camera is *acquiring* the string.
 *
 * So that is all this is: one interface with two implementations and a lifecycle. The parser is not
 * duplicated, and neither is the miss handling.
 *
 * ## What is not here, and why
 *
 * There is **no decoding library**. `package.json` has nine runtime dependencies; a wasm barcode
 * decoder would be the tenth and the largest, and nothing in CI could exercise it — there is no
 * camera, no `getUserMedia`, and no `BarcodeDetector` in jsdom or node. A dependency that can only
 * be verified by a human holding a tablet does not belong in the tree on the strength of a green
 * build that never touched it.
 *
 * The camera source therefore uses the platform's own `BarcodeDetector` (Chrome/Edge on Android and
 * ChromeOS — which is the tablet-till case) and reports itself unsupported everywhere else, so the
 * selector falls back to the wedge rather than pretending. Every collaborator is injected, which is
 * what makes the parts that *can* be tested — selection, the decode→`routeScan` seam, and the
 * release of the camera on screen exit — testable without any of them.
 *
 * **AC1 of BAN-421 ("a barcode scanned through the device camera adds the same line an HID scan
 * would") is a hand test.** The seam either side of the decoder is covered; the decoder is not.
 */

export type BarcodeSourceKind = 'hid' | 'camera';

/** Stops a running source and releases everything it acquired. Must be idempotent. */
export type StopSource = () => void;

export type BarcodeSource = {
    readonly kind: BarcodeSourceKind;
    start(onCode: (code: string) => void): Promise<StopSource>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

export type SourceCapabilities = {
    /** `BarcodeDetector` exists and a camera can be opened. */
    camera: boolean;
};

/**
 * Which source to actually run.
 *
 * The wedge is the floor, never a choice that can fail: it needs no permission and no hardware
 * beyond the scanner already plugged in. A camera preference on a device that cannot do it silently
 * degrades to the wedge rather than leaving the till unable to scan at all.
 */
export function selectBarcodeSource(
    preference: BarcodeSourceKind,
    capabilities: SourceCapabilities,
): BarcodeSourceKind {
    if (preference === 'camera' && capabilities.camera) return 'camera';
    return 'hid';
}

/** Feature detection, kept in one place so the toggle and the selector cannot disagree. */
export function detectCapabilities(scope: typeof globalThis = globalThis): SourceCapabilities {
    const media = (scope as { navigator?: { mediaDevices?: { getUserMedia?: unknown } } }).navigator;

    return {
        camera:
            typeof (scope as { BarcodeDetector?: unknown }).BarcodeDetector === 'function' &&
            typeof media?.mediaDevices?.getUserMedia === 'function',
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// HID wedge
// ─────────────────────────────────────────────────────────────────────────────

export function hidBarcodeSource(options: Omit<ScannerOptions, 'onScan'> = {}): BarcodeSource {
    return {
        kind: 'hid',
        start(onCode) {
            return Promise.resolve(attachScanner({ ...options, onScan: onCode }));
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Camera
// ─────────────────────────────────────────────────────────────────────────────

/** The slice of `MediaStream` this module uses. Narrow on purpose: it is all that has to be faked. */
export type CameraStream = {
    getTracks(): ReadonlyArray<{ stop(): void }>;
};

export type BarcodeDecoder = {
    detect(frame: unknown): Promise<ReadonlyArray<{ rawValue: string }>>;
};

export type CameraSourceDeps = {
    /** Opens the camera. Rejects on a denied permission — `start` lets that propagate. */
    openStream: () => Promise<CameraStream>;
    createDecoder: () => Promise<BarcodeDecoder>;
    /**
     * Hand the live stream to whatever displays it (a `<video>`), returning its teardown.
     *
     * Separate from stopping the tracks, and both are needed: a `<video>` still holding a stopped
     * stream as `srcObject` keeps the last frame frozen on screen, which reads as "still scanning".
     */
    present?: (stream: CameraStream) => (() => void) | void;
    /** The thing to decode: a `<video>` element in production. */
    frame: () => unknown;
    /** Schedules the next decode attempt and returns its canceller (rAF or a timer). */
    schedule: (run: () => void) => () => void;
};

/**
 * A camera scanner built on the platform decoder.
 *
 * The release path is the part worth reading. `02-features.md` §REG-081 requires the camera be
 * released when the screen is left, and there are three ways to leak it that all look fine on a
 * desktop: stopping the loop but not the tracks (the indicator light stays on), stopping the tracks
 * but not the loop (a decode fires against a dead stream every frame), and unmounting *while*
 * `openStream()` is still pending, so the stop function does not exist yet when it is needed. The
 * first two are handled here; the third is handled by {@link attachBarcodeSource}, which is why
 * screens go through it rather than calling `start` directly.
 */
export function cameraBarcodeSource(deps: CameraSourceDeps): BarcodeSource {
    return {
        kind: 'camera',

        async start(onCode) {
            const stream = await deps.openStream();

            let stopped = false;
            let cancel: (() => void) | null = null;
            const unpresent = deps.present?.(stream) ?? null;

            const release = (): void => {
                if (stopped) return;
                stopped = true;
                cancel?.();
                cancel = null;
                unpresent?.();
                for (const track of stream.getTracks()) track.stop();
            };

            let decoder: BarcodeDecoder;
            try {
                decoder = await deps.createDecoder();
            } catch (error) {
                // The camera is open at this point; a decoder that fails to construct must not leave
                // it that way.
                release();
                throw error;
            }

            if (stopped) return release;

            const tick = (): void => {
                void (async () => {
                    if (stopped) return;

                    try {
                        for (const found of await decoder.detect(deps.frame())) {
                            if (stopped) return;
                            if (found.rawValue !== '') onCode(found.rawValue);
                        }
                    } catch {
                        // A dropped frame is not an error worth showing a cashier; keep looping.
                    }

                    if (!stopped) cancel = deps.schedule(tick);
                })();
            };

            cancel = deps.schedule(tick);

            return release;
        },
    };
}

/** The production camera source, wired to the browser. */
export function browserCameraSource(video: () => unknown): BarcodeSource {
    return cameraBarcodeSource({
        openStream: () =>
            (globalThis.navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' },
            }) as unknown) as Promise<CameraStream>,
        createDecoder: () => {
            const Detector = (globalThis as { BarcodeDetector?: new () => BarcodeDecoder }).BarcodeDetector;
            if (!Detector) return Promise.reject(new Error('barcode_detector_unavailable'));
            return Promise.resolve(new Detector());
        },
        present: (stream) => {
            const element = video() as HTMLVideoElement | null;
            if (!element) return;

            element.srcObject = stream as unknown as MediaStream;
            void element.play().catch(() => {
                // Autoplay refusal is not fatal — the decoder reads frames, not the poster.
            });

            return () => {
                element.srcObject = null;
            };
        },
        frame: video,
        schedule: (run) => {
            // ~10 decodes a second. A full-rate rAF loop on a 2019 tablet spends the whole frame
            // budget in the decoder and makes the rest of the till feel broken.
            const timer = setTimeout(run, 100);
            return () => clearTimeout(timer);
        },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start a source and return a **synchronous** detach — the shape a React effect cleanup needs.
 *
 * `start` is async (opening a camera is), and a screen can unmount before it resolves. Returning the
 * stop function directly would mean that unmount had nothing to call, and the camera would stay open
 * with its indicator light on until the tab closed. So the detach flips a flag the resolution
 * checks, and releases whatever arrives late.
 */
export function attachBarcodeSource(source: BarcodeSource, onCode: (code: string) => void): () => void {
    let detached = false;
    let stop: StopSource | null = null;

    void source
        .start((code) => {
            if (!detached) onCode(code);
        })
        .then((release) => {
            if (detached) release();
            else stop = release;
        })
        .catch(() => {
            // A refused camera permission is not a crash; the selector's fallback is the answer.
        });

    return () => {
        if (detached) return;
        detached = true;
        stop?.();
        stop = null;
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test double
// ─────────────────────────────────────────────────────────────────────────────

export type FakeBarcodeSource = BarcodeSource & {
    /** Deliver a code as if the decoder had read it. No-op once stopped. */
    emit(code: string): void;
    readonly starts: number;
    readonly stops: number;
    readonly running: boolean;
};

/**
 * A source that emits on command.
 *
 * This is the whole reason the interface exists: everything from "a code arrived" onwards — routing,
 * the lazy fetch, the line — is provable in CI against this, with no camera and no wasm.
 */
export function fakeBarcodeSource(kind: BarcodeSourceKind = 'camera'): FakeBarcodeSource {
    let listener: ((code: string) => void) | null = null;
    let starts = 0;
    let stops = 0;

    return {
        kind,

        start(onCode) {
            starts += 1;
            listener = onCode;
            return Promise.resolve(() => {
                // Counted only on the first stop: a double release is a bug in the caller, and a
                // counter that hid it would make the leak tests meaningless.
                if (listener === null) return;
                listener = null;
                stops += 1;
            });
        },

        emit(code) {
            listener?.(code);
        },

        get starts() {
            return starts;
        },
        get stops() {
            return stops;
        },
        get running() {
            return listener !== null;
        },
    };
}
