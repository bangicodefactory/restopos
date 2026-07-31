/**
 * A destructive action, wrapped in a confirmation and a progress state.
 *
 * The rule for this app: **every destructive action confirms, every long action shows progress.**
 * Making that one component rather than a convention means it cannot be forgotten on the one
 * screen where it matters — revoking a device, rotating a QR token, force-closing a session.
 *
 * `ConfirmDialog` and `Button` come from `@shared/ui`; this adds the in-flight state and the
 * "type the name to confirm" escalation for the truly irreversible ones.
 */

import { Button, ConfirmDialog, FOCUS_RING, cn, type ButtonProps } from '@shared/ui';
import { useCallback, useState, type JSX, type ReactNode } from 'react';

import { useT } from '../../i18n';

import { ProgressBar } from './primitives';

export type ConfirmActionProps = {
    label: ReactNode;
    title: string;
    message: ReactNode;
    onConfirm: () => void;
    /** Extra friction: the operator must retype this exact string. */
    confirmPhrase?: string;
    confirmLabel?: string;
    destructive?: boolean;
    variant?: ButtonProps['variant'];
    size?: ButtonProps['size'];
    disabled?: boolean;
    /** True while the resulting request is in flight; renders a progress bar. */
    busy?: boolean;
    busyLabel?: string;
    icon?: ReactNode;
    className?: string;
};

export function ConfirmAction({
    label,
    title,
    message,
    onConfirm,
    confirmPhrase,
    confirmLabel,
    destructive = true,
    variant,
    size = 'md',
    disabled,
    busy = false,
    busyLabel,
    icon,
    className,
}: ConfirmActionProps): JSX.Element {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [typed, setTyped] = useState('');

    const close = useCallback(() => {
        setOpen(false);
        setTyped('');
    }, []);

    const phraseOk = confirmPhrase === undefined || typed.trim() === confirmPhrase;

    return (
        <>
            <Button
                variant={variant ?? (destructive ? 'danger' : 'secondary')}
                size={size}
                disabled={disabled === true || busy}
                loading={busy}
                icon={icon}
                onClick={() => setOpen(true)}
                className={className}
            >
                {label}
            </Button>

            {busy ? (
                <div className="mt-2">
                    <ProgressBar label={busyLabel ?? t('action.saving')} />
                </div>
            ) : null}

            {confirmPhrase === undefined ? (
                <ConfirmDialog
                    open={open}
                    onClose={close}
                    onConfirm={onConfirm}
                    title={title}
                    message={message}
                    confirmLabel={confirmLabel ?? t('action.confirm')}
                    cancelLabel={t('action.cancel')}
                    destructive={destructive}
                />
            ) : (
                <PhraseDialog
                    open={open}
                    onClose={close}
                    onConfirm={() => {
                        if (phraseOk) {
                            onConfirm();
                            close();
                        }
                    }}
                    title={title}
                    message={message}
                    phrase={confirmPhrase}
                    typed={typed}
                    onTyped={setTyped}
                    confirmLabel={confirmLabel ?? t('action.confirm')}
                    cancelLabel={t('action.cancel')}
                    enabled={phraseOk}
                />
            )}
        </>
    );
}

function PhraseDialog({
    open,
    onClose,
    onConfirm,
    title,
    message,
    phrase,
    typed,
    onTyped,
    confirmLabel,
    cancelLabel,
    enabled,
}: {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: ReactNode;
    phrase: string;
    typed: string;
    onTyped: (value: string) => void;
    confirmLabel: string;
    cancelLabel: string;
    enabled: boolean;
}): JSX.Element {
    return (
        <ConfirmDialog
            open={open}
            onClose={onClose}
            onConfirm={onConfirm}
            title={title}
            destructive
            confirmLabel={enabled ? confirmLabel : `${confirmLabel} …`}
            cancelLabel={cancelLabel}
            message={
                <div className="space-y-3">
                    <div>{message}</div>
                    <label className="block">
                        <span className="text-sm font-medium text-slate-700">
                            Tapez <code className="rounded bg-slate-100 px-1 font-mono">{phrase}</code> pour confirmer
                        </span>
                        <input
                            type="text"
                            value={typed}
                            autoComplete="off"
                            onChange={(event) => onTyped(event.target.value)}
                            className={cn(
                                'mt-1 min-h-touch w-full rounded-pos bg-white px-3 ring-1 ring-inset ring-slate-300',
                                FOCUS_RING,
                            )}
                        />
                    </label>
                </div>
            }
        />
    );
}
