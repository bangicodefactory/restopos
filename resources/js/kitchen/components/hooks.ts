import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
} from 'react';

/**
 * The three browser affordances the board needs, and nothing else.
 */

/**
 * One clock for the whole board.
 *
 * Forty cards each running their own `setInterval` is forty React renders a second on a cheap
 * Android tablet. One tick at the top, passed down as a number, is one render — and it keeps every
 * timer on screen in lockstep, which matters when a cook is comparing two cards.
 */
export function useNow(intervalMs = 1_000): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        const onVisible = (): void => {
            // A backgrounded tab throttles timers to once a minute; catch up the instant it returns.
            if (globalThis.document?.visibilityState === 'visible') setNow(Date.now());
        };
        globalThis.document?.addEventListener('visibilitychange', onVisible);
        return () => {
            clearInterval(timer);
            globalThis.document?.removeEventListener('visibilitychange', onVisible);
        };
    }, [intervalMs]);

    return now;
}

export type LongPressHandlers = {
    onPointerDown: (event: ReactPointerEvent) => void;
    onPointerUp: (event: ReactPointerEvent) => void;
    onPointerLeave: () => void;
    onPointerCancel: () => void;
    onContextMenu: (event: ReactMouseEvent) => void;
};

/**
 * Tap vs long-press on the same element (KDS-009).
 *
 * A recall is destructive-ish and must not be reachable by a stray elbow, so it hides behind a
 * 550 ms hold. The tap is suppressed once the hold fires, otherwise every recall would also advance
 * the card. `onContextMenu` is cancelled because a long press on Android raises the context menu
 * over the card.
 */
export function useLongPress(
    onTap: () => void,
    onLongPress: (() => void) | null,
    holdMs = 550,
): LongPressHandlers {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fired = useRef(false);

    const clear = useCallback(() => {
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = null;
    }, []);

    useEffect(() => clear, [clear]);

    return {
        onPointerDown: (event) => {
            if (event.button !== 0 && event.pointerType === 'mouse') return;
            fired.current = false;
            if (!onLongPress) return;
            clear();
            timer.current = setTimeout(() => {
                fired.current = true;
                onLongPress();
            }, holdMs);
        },
        onPointerUp: () => {
            clear();
            if (fired.current) {
                fired.current = false;
                return;
            }
            onTap();
        },
        onPointerLeave: () => {
            clear();
            fired.current = false;
        },
        onPointerCancel: () => {
            clear();
            fired.current = false;
        },
        onContextMenu: (event) => event.preventDefault(),
    };
}

/**
 * The new-order chime (KDS-014).
 *
 * Synthesised with WebAudio rather than shipped as an asset: it is ~30 lines against a 20 kB file
 * that the service worker would have to precache, and a kitchen needs a hard, cutting two-tone
 * beep rather than a pleasant one. Autoplay policy means the context is created lazily and resumed
 * on the first interaction — until then the visual flash carries the alert on its own.
 */
export function useAlertSound(muted: boolean): (kind?: 'new' | 'warn') => void {
    const contextRef = useRef<AudioContext | null>(null);

    useEffect(() => {
        const unlock = (): void => {
            void contextRef.current?.resume();
        };
        globalThis.addEventListener?.('pointerdown', unlock, { once: true });
        return () => globalThis.removeEventListener?.('pointerdown', unlock);
    }, []);

    useEffect(() => {
        return () => {
            void contextRef.current?.close();
            contextRef.current = null;
        };
    }, []);

    return useCallback(
        (kind: 'new' | 'warn' = 'new') => {
            if (muted) return;
            const Ctor =
                globalThis.AudioContext ??
                (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!Ctor) return;

            try {
                contextRef.current ??= new Ctor();
                const context = contextRef.current;
                void context.resume();

                const now = context.currentTime;
                const tones = kind === 'new' ? [880, 1320] : [440, 330];
                tones.forEach((frequency, index) => {
                    const oscillator = context.createOscillator();
                    const gain = context.createGain();
                    oscillator.type = 'square';
                    oscillator.frequency.value = frequency;
                    // A short envelope: a click-free beep that carries over an extractor hood.
                    const start = now + index * 0.16;
                    gain.gain.setValueAtTime(0.0001, start);
                    gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
                    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
                    oscillator.connect(gain).connect(context.destination);
                    oscillator.start(start);
                    oscillator.stop(start + 0.16);
                });
            } catch {
                // No audio device, or a policy refusal. The visual alert stands alone.
            }
        },
        [muted],
    );
}
