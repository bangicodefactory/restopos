import { forwardRef, type ButtonHTMLAttributes, type JSX, type ReactNode } from 'react';

import { FOCUS_RING, PRESSABLE, cn } from './cn';
import { Spinner } from './Spinner';

/**
 * The button.
 *
 * Sized for a till, not a web form: the default is 56 px tall (`touch-lg`), never below the 44 px
 * WCAG floor, and it does not shrink on small screens because a small screen at a POS means a
 * hand-held terminal, where targets need to be *larger*, not smaller.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'kitchen';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

const VARIANTS: Record<ButtonVariant, string> = {
    primary: 'bg-brand-600 text-white shadow-pos hover:bg-brand-700 active:bg-brand-800 disabled:bg-brand-300',
    secondary:
        'bg-white text-slate-900 ring-1 ring-inset ring-slate-300 shadow-pos hover:bg-slate-50 active:bg-slate-100 disabled:text-slate-400',
    ghost: 'bg-transparent text-slate-700 hover:bg-slate-100 active:bg-slate-200 disabled:text-slate-400',
    danger: 'bg-danger text-white shadow-pos hover:brightness-110 active:brightness-95 disabled:opacity-50',
    success: 'bg-ok text-white shadow-pos hover:brightness-110 active:brightness-95 disabled:opacity-50',
    kitchen:
        'bg-kitchen-raised text-kitchen-text ring-1 ring-inset ring-kitchen-border hover:bg-kitchen-surface active:brightness-110',
};

const SIZES: Record<ButtonSize, string> = {
    sm: 'min-h-touch px-3 text-sm rounded-pos gap-1.5',
    md: 'min-h-touch px-4 text-base rounded-pos gap-2',
    lg: 'min-h-touch-lg px-5 text-lg rounded-pos gap-2.5',
    xl: 'min-h-touch-xl px-6 text-xl rounded-pos-lg gap-3',
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    loading?: boolean;
    block?: boolean;
    icon?: ReactNode;
    iconRight?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    {
        variant = 'primary',
        size = 'lg',
        loading = false,
        block = false,
        icon,
        iconRight,
        className,
        disabled,
        children,
        type = 'button',
        ...rest
    },
    ref,
): JSX.Element {
    return (
        <button
            ref={ref}
            type={type}
            disabled={disabled === true || loading}
            aria-busy={loading || undefined}
            className={cn(
                'inline-flex items-center justify-center font-semibold',
                'disabled:cursor-not-allowed disabled:shadow-none',
                PRESSABLE,
                FOCUS_RING,
                VARIANTS[variant],
                SIZES[size],
                block && 'w-full',
                className,
            )}
            {...rest}
        >
            {loading ? <Spinner size={size === 'sm' ? 'sm' : 'md'} /> : icon}
            {children}
            {iconRight}
        </button>
    );
});

/** Square icon-only button — same target rules, no label. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(function IconButton(
    { label, className, size = 'lg', children, ...rest },
    ref,
): JSX.Element {
    return (
        <Button
            ref={ref}
            aria-label={label}
            title={label}
            size={size}
            className={cn('aspect-square px-0', className)}
            {...rest}
        >
            {children}
        </Button>
    );
});
