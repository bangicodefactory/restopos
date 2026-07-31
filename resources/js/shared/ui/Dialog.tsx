import { useCallback, useEffect, useRef, type JSX, type ReactNode } from 'react';

import { IconButton } from './Button';
import { cn } from './cn';

/**
 * Modal dialog and bottom sheet, built on the native `<dialog>` element.
 *
 * Native gives us, for free and correctly: the top layer (no z-index war with the floor plan), a
 * focus trap, inert background, and Escape handling. What it does not give us is a way to stop
 * Escape when a dialog must be answered — a payment in flight cannot be dismissed by a stray
 * keyboard — so `dismissible` intercepts `cancel`.
 */

export type DialogProps = {
    open: boolean;
    onClose: () => void;
    title?: ReactNode;
    description?: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
    /** `false` blocks Escape and backdrop clicks. Use for anything with money in flight. */
    dismissible?: boolean;
    size?: 'sm' | 'md' | 'lg' | 'full';
    className?: string;
};

const SIZES = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-3xl',
    full: 'max-w-[95vw] h-[90vh]',
} as const;

export function Dialog({
    open,
    onClose,
    title,
    description,
    children,
    footer,
    dismissible = true,
    size = 'md',
    className,
}: DialogProps): JSX.Element {
    const ref = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        if (open && !element.open) element.showModal();
        if (!open && element.open) element.close();
    }, [open]);

    const onCancel = useCallback(
        (event: React.SyntheticEvent<HTMLDialogElement>) => {
            event.preventDefault();
            if (dismissible) onClose();
        },
        [dismissible, onClose],
    );

    const onBackdropClick = useCallback(
        (event: React.MouseEvent<HTMLDialogElement>) => {
            if (!dismissible) return;
            // A click on the dialog element itself (not its content box) is a backdrop click.
            if (event.target === ref.current) onClose();
        },
        [dismissible, onClose],
    );

    return (
        <dialog
            ref={ref}
            onCancel={onCancel}
            onClick={onBackdropClick}
            className={cn(
                'm-auto w-full rounded-pos-lg bg-white p-0 text-slate-900 shadow-pos-lg backdrop:bg-black/50',
                'open:animate-toast-in',
                SIZES[size],
                className,
            )}
        >
            <div className="flex max-h-[90vh] flex-col">
                {(title || dismissible) && (
                    <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
                        <div className="min-w-0">
                            {title ? <h2 className="text-xl font-semibold">{title}</h2> : null}
                            {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
                        </div>
                        {dismissible ? (
                            <IconButton label="Close" variant="ghost" size="md" onClick={onClose}>
                                ✕
                            </IconButton>
                        ) : null}
                    </header>
                )}

                <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>

                {footer ? (
                    <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-4">
                        {footer}
                    </footer>
                ) : null}
            </div>
        </dialog>
    );
}

export type SheetProps = Omit<DialogProps, 'size'> & {
    side?: 'bottom' | 'right';
};

/**
 * Bottom/side sheet. Same machinery, different geometry — bottom on a hand-held (thumb reach),
 * right on a landscape till (the product grid stays visible).
 */
export function Sheet({ side = 'bottom', className, ...props }: SheetProps): JSX.Element {
    return (
        <Dialog
            {...props}
            size="full"
            className={cn(
                'max-w-none',
                side === 'bottom'
                    ? 'mb-0 mt-auto h-auto max-h-[85vh] w-full rounded-b-none rounded-t-pos-lg'
                    : 'me-0 ms-auto h-full max-h-none w-[min(32rem,90vw)] rounded-e-none rounded-s-pos-lg',
                className,
            )}
        />
    );
}

/** Yes/no confirmation. The destructive action is never the default focus. */
export function ConfirmDialog({
    open,
    onClose,
    onConfirm,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
}: {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
}): JSX.Element {
    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={title}
            size="sm"
            footer={
                <>
                    <button
                        type="button"
                        className="min-h-touch-lg rounded-pos px-5 font-semibold text-slate-700 hover:bg-slate-100"
                        onClick={onClose}
                    >
                        {cancelLabel}
                    </button>
                    <button
                        type="button"
                        className={cn(
                            'min-h-touch-lg rounded-pos px-5 font-semibold text-white',
                            destructive ? 'bg-danger' : 'bg-brand-600',
                        )}
                        onClick={() => {
                            onConfirm();
                            onClose();
                        }}
                    >
                        {confirmLabel}
                    </button>
                </>
            }
        >
            <div className="text-base">{message}</div>
        </Dialog>
    );
}
