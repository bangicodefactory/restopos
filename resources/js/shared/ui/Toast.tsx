import { createContext, useCallback, useContext, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';

import { cn } from './cn';

/**
 * Toasts.
 *
 * Rule from spec 03 §3.6.6: a sync failure is a toast, not a modal. **Never block the sale.** The
 * only things allowed to take the screen away from a cashier are an auth failure and a forced
 * update; everything else lands here.
 *
 * Toasts are announced with `role="status"` / `aria-live="polite"` so a screen reader user hears
 * "3 orders pending" without losing their place in the order.
 */

export type ToastTone = 'info' | 'success' | 'warn' | 'danger' | 'offline';

export type Toast = {
    id: string;
    tone: ToastTone;
    title: string;
    message?: string;
    /** `0` pins the toast until dismissed — used for "you are offline". */
    durationMs?: number;
    action?: { label: string; onClick: () => void };
};

export type ToastApi = {
    show: (toast: Omit<Toast, 'id'> & { id?: string }) => string;
    dismiss: (id: string) => void;
    clear: () => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const TONES: Record<ToastTone, string> = {
    info: 'bg-info-soft text-info-fg ring-info/30',
    success: 'bg-ok-soft text-ok-fg ring-ok/30',
    warn: 'bg-warn-soft text-warn-fg ring-warn/30',
    danger: 'bg-danger-soft text-danger-fg ring-danger/30',
    offline: 'bg-offline-soft text-offline-fg ring-offline/30',
};

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

    const dismiss = useCallback((id: string) => {
        const timer = timers.current.get(id);
        if (timer) {
            clearTimeout(timer);
            timers.current.delete(id);
        }
        setToasts((current) => current.filter((toast) => toast.id !== id));
    }, []);

    const show = useCallback<ToastApi['show']>(
        (input) => {
            // A stable id lets a repeated event (e.g. "offline") replace itself instead of stacking.
            const id = input.id ?? `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
            const toast: Toast = { ...input, id };

            setToasts((current) => [...current.filter((t) => t.id !== id), toast]);

            const existing = timers.current.get(id);
            if (existing) clearTimeout(existing);

            const duration = toast.durationMs ?? 4_000;
            if (duration > 0) {
                timers.current.set(
                    id,
                    setTimeout(() => dismiss(id), duration),
                );
            }
            return id;
        },
        [dismiss],
    );

    const clear = useCallback(() => {
        for (const timer of timers.current.values()) clearTimeout(timer);
        timers.current.clear();
        setToasts([]);
    }, []);

    const api = useMemo<ToastApi>(() => ({ show, dismiss, clear }), [show, dismiss, clear]);

    return (
        <ToastContext.Provider value={api}>
            {children}
            <div
                className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]"
                role="status"
                aria-live="polite"
            >
                {toasts.map((toast) => (
                    <div
                        key={toast.id}
                        className={cn(
                            'pointer-events-auto flex w-full max-w-md animate-toast-in items-start gap-3 rounded-pos px-4 py-3 shadow-pos-lg ring-1',
                            TONES[toast.tone],
                        )}
                    >
                        <div className="min-w-0 flex-1">
                            <div className="font-semibold">{toast.title}</div>
                            {toast.message ? <div className="mt-0.5 text-sm opacity-90">{toast.message}</div> : null}
                        </div>
                        {toast.action ? (
                            <button
                                type="button"
                                className="min-h-touch shrink-0 rounded-pos px-3 font-semibold underline"
                                onClick={() => {
                                    toast.action?.onClick();
                                    dismiss(toast.id);
                                }}
                            >
                                {toast.action.label}
                            </button>
                        ) : null}
                        <button
                            type="button"
                            aria-label="Dismiss"
                            className="min-h-touch min-w-touch shrink-0 rounded-pos px-2 text-lg opacity-70 hover:opacity-100"
                            onClick={() => dismiss(toast.id)}
                        >
                            ✕
                        </button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

/**
 * Outside a provider this returns a no-op API rather than throwing: a toast is never important
 * enough to crash a till, and the customer display legitimately has no toast layer.
 */
export function useToast(): ToastApi {
    const context = useContext(ToastContext);
    return (
        context ?? {
            show: () => '',
            dismiss: () => {},
            clear: () => {},
        }
    );
}
