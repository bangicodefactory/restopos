import { cn } from '@shared/ui';
import type { JSX } from 'react';

import { formatElapsed, urgencyOf, type UrgencyLevel, type UrgencyThresholds } from '../logic/elapsed';

/**
 * The age timer (KDS-011).
 *
 * Colour *and* weight change together: a dark kitchen is exactly the environment where relying on
 * hue alone fails — steam, glare, and a non-trivial share of cooks with colour-vision deficiency.
 * So `urgent` also grows, goes bold and pulses.
 */

const LEVEL_CLASS: Record<UrgencyLevel, string> = {
    fresh: 'bg-kitchen-raised text-kitchen-text ring-kitchen-border',
    warning: 'bg-kitchen-cooking/20 text-kitchen-cooking ring-kitchen-cooking/50',
    late: 'bg-kitchen-late/25 text-kitchen-late ring-kitchen-late/60',
    urgent: 'bg-kitchen-late text-white ring-white/70 animate-pulse-sync',
};

export function ElapsedBadge({
    seconds,
    thresholds,
    size = 'md',
    className,
}: {
    seconds: number;
    thresholds: UrgencyThresholds;
    size?: 'md' | 'lg';
    className?: string;
}): JSX.Element {
    const level = urgencyOf(seconds, thresholds);
    return (
        <span
            className={cn(
                'inline-flex items-center justify-center rounded-pos font-mono font-bold tabular-nums ring-1 ring-inset',
                size === 'lg' ? 'px-3 py-1 text-2xl' : 'px-2.5 py-0.5 text-xl',
                LEVEL_CLASS[level],
                className,
            )}
            // Announced as a plain duration; the colour is decoration.
            aria-label={`${Math.floor(seconds / 60)} min ${seconds % 60} s`}
        >
            {formatElapsed(seconds)}
        </span>
    );
}

export function urgencyRing(level: UrgencyLevel): string {
    switch (level) {
        case 'urgent':
            return 'ring-4 ring-kitchen-late';
        case 'late':
            return 'ring-2 ring-kitchen-late/70';
        case 'warning':
            return 'ring-2 ring-kitchen-cooking/70';
        case 'fresh':
            return 'ring-1 ring-kitchen-border';
    }
}
