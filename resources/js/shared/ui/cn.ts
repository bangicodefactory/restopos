import clsx, { type ClassValue } from 'clsx';

/**
 * Class name joiner.
 *
 * Deliberately **not** `tailwind-merge`: it is 6 kB of runtime that exists to paper over
 * conflicting utility classes, and the primitives here take a `className` that is appended last, so
 * the caller already wins by cascade order. If a component ever needs real conflict resolution,
 * that is a sign the component needs a variant, not a merge library.
 */
export function cn(...values: ClassValue[]): string {
    return clsx(values);
}

/** Touch target floor: WCAG 2.5.5 minimum. Every interactive primitive applies at least this. */
export const TOUCH_TARGET = 'min-h-touch min-w-touch';

/** The focus ring used everywhere, so keyboard and scanner users are never lost. */
export const FOCUS_RING =
    'outline-none focus-visible:ring-4 focus-visible:ring-brand-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-kitchen-bg';

/** Press feedback that survives a gloved finger and a 60 Hz tablet. */
export const PRESSABLE = 'transition-[transform,background-color,box-shadow] duration-press active:scale-[0.985] select-none touch-manipulation';
