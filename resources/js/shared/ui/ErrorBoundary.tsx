import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react';

/**
 * Error boundary.
 *
 * A crash on a till is not a "something went wrong" page — it is a cashier holding a queue of six
 * people. So the fallback does three things in order: state plainly that the sale is safe (orders
 * live in IndexedDB, not in React state), offer a reload that does **not** clear storage, and show
 * the error only behind a disclosure so it does not read as a customer-facing failure.
 */

export type ErrorBoundaryProps = {
    children: ReactNode;
    /** Reported to the telemetry sink; keep it cheap and synchronous. */
    onError?: (error: Error, info: ErrorInfo) => void;
    fallback?: (state: { error: Error; reset: () => void }) => ReactNode;
    /** Changing this value resets the boundary — pass the route key. */
    resetKey?: string | number;
};

type State = { error: Error | null };

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
    override state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    override componentDidCatch(error: Error, info: ErrorInfo): void {
        this.props.onError?.(error, info);
        // Kept: a till in the field is debugged from a screenshot of the console.
        console.error('[restopos] render error', error, info.componentStack);
    }

    override componentDidUpdate(previous: ErrorBoundaryProps): void {
        if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
            this.setState({ error: null });
        }
    }

    private reset = (): void => this.setState({ error: null });

    override render(): ReactNode {
        const { error } = this.state;
        if (!error) return this.props.children;
        if (this.props.fallback) return this.props.fallback({ error, reset: this.reset });

        return (
            <div className="flex min-h-full flex-col items-center justify-center gap-4 p-8 text-center">
                <div className="text-2xl font-semibold">Something broke on screen</div>
                <p className="max-w-md text-slate-600">
                    Your orders are safe — they are stored on this device and will sync as usual. Reloading is safe.
                </p>
                <div className="flex gap-3">
                    <button
                        type="button"
                        className="min-h-touch-lg rounded-pos bg-brand-600 px-6 font-semibold text-white"
                        onClick={this.reset}
                    >
                        Try again
                    </button>
                    <button
                        type="button"
                        className="min-h-touch-lg rounded-pos px-6 font-semibold ring-1 ring-inset ring-slate-300"
                        onClick={() => globalThis.location?.reload()}
                    >
                        Reload
                    </button>
                </div>
                <details className="mt-4 max-w-xl text-left text-xs text-slate-500">
                    <summary className="cursor-pointer">Technical details</summary>
                    <pre className="mt-2 overflow-auto whitespace-pre-wrap">{error.stack ?? error.message}</pre>
                </details>
            </div>
        );
    }
}

/** Wrap one screen without adding a component to the tree by hand. */
export function withErrorBoundary<P extends object>(
    Wrapped: (props: P) => JSX.Element,
    options?: Omit<ErrorBoundaryProps, 'children'>,
): (props: P) => JSX.Element {
    return function WithErrorBoundary(props: P): JSX.Element {
        return (
            <ErrorBoundary {...options}>
                <Wrapped {...props} />
            </ErrorBoundary>
        );
    };
}
