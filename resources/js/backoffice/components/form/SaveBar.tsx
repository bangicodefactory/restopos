/**
 * The save/cancel bar and the unsaved-changes guard.
 *
 * The guard covers both ways out of a form: a browser navigation (`beforeunload`) and an Inertia
 * visit (`router.on('before')`). It deliberately lets **partial reloads through** — a `WhenVisible`
 * fetch of a deferred prop, or a data-table filter refresh on the same page, is not the operator
 * leaving, and prompting there would train them to dismiss the prompt.
 */

import { router } from '@inertiajs/react';
import { Button, cn } from '@shared/ui';
import { useEffect, type JSX, type ReactNode } from 'react';

import { useT } from '../../i18n';
import { Badge, ProgressBar } from '../ui/primitives';

export function useDirtyGuard(dirty: boolean, message: string): void {
    useEffect(() => {
        if (!dirty) return undefined;

        const onBeforeUnload = (event: BeforeUnloadEvent): void => {
            event.preventDefault();
            // Browsers ignore custom text now; a non-empty returnValue is what triggers the prompt.
            event.returnValue = '';
        };

        globalThis.addEventListener('beforeunload', onBeforeUnload);

        const stop = router.on('before', (event) => {
            const visit = event.detail.visit;
            // Partial reloads and form submissions are not "leaving the page".
            if (visit.only.length > 0 || visit.method !== 'get') return true;
            return globalThis.confirm(message);
        });

        return () => {
            globalThis.removeEventListener('beforeunload', onBeforeUnload);
            stop();
        };
    }, [dirty, message]);
}

export type SaveBarProps = {
    dirty: boolean;
    processing: boolean;
    onSave: () => void;
    onCancel?: () => void;
    /** 0–100 for a determinate bar; omit for indeterminate. */
    progress?: number;
    errorCount?: number;
    saveLabel?: string;
    cancelLabel?: string;
    disabled?: boolean;
    extra?: ReactNode;
    /** Number of changed fields, shown as a chip. */
    dirtyCount?: number;
};

export function SaveBar({
    dirty,
    processing,
    onSave,
    onCancel,
    progress,
    errorCount = 0,
    saveLabel,
    cancelLabel,
    disabled = false,
    extra,
    dirtyCount,
}: SaveBarProps): JSX.Element {
    const t = useT();

    return (
        <div
            className={cn(
                'sticky bottom-0 z-20 -mx-4 mt-6 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur',
                'supports-[backdrop-filter]:bg-white/80',
            )}
        >
            {processing ? (
                <div className="mb-2">
                    <ProgressBar label={t('action.saving')} value={progress} />
                </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
                    {errorCount > 0 ? (
                        <Badge tone="danger">{t('form.errors', { count: errorCount })}</Badge>
                    ) : dirty ? (
                        <Badge tone="warn">
                            {dirtyCount === undefined ? t('state.unsaved') : t('form.dirtyBar', { count: dirtyCount })}
                        </Badge>
                    ) : (
                        <span className="text-slate-500">{t('state.saved')}</span>
                    )}
                    {extra}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    {onCancel ? (
                        <Button variant="ghost" size="md" onClick={onCancel} disabled={!dirty || processing}>
                            {cancelLabel ?? t('action.cancel')}
                        </Button>
                    ) : null}
                    <Button
                        variant="primary"
                        size="md"
                        onClick={onSave}
                        loading={processing}
                        disabled={disabled || processing || !dirty}
                    >
                        {processing ? t('action.saving') : (saveLabel ?? t('action.save'))}
                    </Button>
                </div>
            </div>
        </div>
    );
}
