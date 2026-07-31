import type { JSX } from 'react';

import { cn } from './cn';

const SIZES = { sm: 'h-4 w-4 border-2', md: 'h-5 w-5 border-2', lg: 'h-8 w-8 border-[3px]' } as const;

export type SpinnerProps = {
    size?: keyof typeof SIZES;
    className?: string;
    label?: string;
};

/** CSS-only spinner — no SVG, no animation library, works before fonts load. */
export function Spinner({ size = 'md', className, label }: SpinnerProps): JSX.Element {
    return (
        <span
            role="status"
            aria-label={label ?? 'Loading'}
            className={cn(
                'inline-block animate-spin rounded-full border-current border-r-transparent align-[-0.125em]',
                SIZES[size],
                className,
            )}
        />
    );
}

/** Full-area loading state for a panel that has nothing to show yet. */
export function LoadingPane({ label = 'Loading…' }: { label?: string }): JSX.Element {
    return (
        <div className="flex min-h-40 flex-1 flex-col items-center justify-center gap-3 text-slate-500">
            <Spinner size="lg" />
            <span className="text-sm">{label}</span>
        </div>
    );
}
