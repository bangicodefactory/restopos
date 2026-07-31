import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Idle detection.
 *
 * Two consumers, two very different consequences:
 *   - the register locks the cashier out after `employee_idle_logout_seconds` (config, default 300)
 *     so the next person cannot ring up a sale under someone else's name;
 *   - the update manager only applies a pending service-worker update while the till has been idle
 *     for a minute, because swapping the bundle mid-transaction is how you lose an order.
 */

const ACTIVITY_EVENTS = [
    'pointerdown',
    'pointermove',
    'keydown',
    'wheel',
    'touchstart',
    'visibilitychange',
] as const;

export type IdleOptions = {
    timeoutMs: number;
    /** Suspend the timer (e.g. while a payment terminal is waiting for a card). */
    enabled?: boolean;
    onIdle?: () => void;
    onActive?: () => void;
};

export type IdleState = {
    idle: boolean;
    lastActivityAt: number;
    /** Force the timer back to zero — call after a programmatic action the user did not trigger. */
    reset: () => void;
};

export function useIdle(options: IdleOptions): IdleState {
    const { timeoutMs, enabled = true } = options;
    const [idle, setIdle] = useState(false);
    const lastActivity = useRef(Date.now());
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const callbacks = useRef({ onIdle: options.onIdle, onActive: options.onActive });
    callbacks.current = { onIdle: options.onIdle, onActive: options.onActive };

    const arm = useCallback(() => {
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            setIdle((wasIdle) => {
                if (!wasIdle) callbacks.current.onIdle?.();
                return true;
            });
        }, timeoutMs);
    }, [timeoutMs]);

    const reset = useCallback(() => {
        lastActivity.current = Date.now();
        setIdle((wasIdle) => {
            if (wasIdle) callbacks.current.onActive?.();
            return false;
        });
        arm();
    }, [arm]);

    useEffect(() => {
        if (!enabled) {
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = null;
            return;
        }

        const onActivity = (): void => {
            lastActivity.current = Date.now();
            setIdle((wasIdle) => {
                if (wasIdle) callbacks.current.onActive?.();
                return false;
            });
            arm();
        };

        for (const event of ACTIVITY_EVENTS) {
            globalThis.addEventListener?.(event, onActivity, { passive: true });
        }
        arm();

        return () => {
            for (const event of ACTIVITY_EVENTS) globalThis.removeEventListener?.(event, onActivity);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = null;
        };
    }, [enabled, arm]);

    return { idle, lastActivityAt: lastActivity.current, reset };
}

/**
 * "Is it safe to do something disruptive right now?" — the gate the update manager uses.
 * Every condition is supplied by the caller so this stays free of store dependencies.
 */
export function useSafeMoment(conditions: {
    idle: boolean;
    hasOpenOrders: boolean;
    outboxEmpty: boolean;
    sessionClosing: boolean;
}): boolean {
    return conditions.idle && !conditions.hasOpenOrders && conditions.outboxEmpty && !conditions.sessionClosing;
}
