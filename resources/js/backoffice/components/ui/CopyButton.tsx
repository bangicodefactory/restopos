/**
 * Copy-to-clipboard with a visible, announced confirmation.
 *
 * Used for access tokens, pairing codes and self-order URLs — values an operator has to move to
 * another device and must not retype by hand.
 */

import { Button, useToast } from '@shared/ui';
import { useCallback, useState, type JSX } from 'react';

import { useT } from '../../i18n';

export function CopyButton({
    value,
    label,
    size = 'sm',
}: {
    value: string;
    label?: string;
    size?: 'sm' | 'md';
}): JSX.Element {
    const t = useT();
    const toast = useToast();
    const [copied, setCopied] = useState(false);

    const copy = useCallback(() => {
        const done = (): void => {
            setCopied(true);
            toast.show({ tone: 'success', title: t('action.copied'), durationMs: 1_800 });
            setTimeout(() => setCopied(false), 1_800);
        };

        // `navigator.clipboard` needs a secure context; the textarea fallback works on plain HTTP,
        // which is exactly where a venue's LAN back-office often runs.
        if (navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(value).then(done, () => fallback(value, done));
        } else {
            fallback(value, done);
        }
    }, [t, toast, value]);

    return (
        <Button variant="secondary" size={size} onClick={copy} aria-live="polite">
            {copied ? t('action.copied') : (label ?? t('action.copy'))}
        </Button>
    );
}

function fallback(value: string, done: () => void): void {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
        document.execCommand('copy');
        done();
    } finally {
        area.remove();
    }
}

/** A token/URL shown in a monospace field with its copy button. */
export function TokenField({ value, label }: { value: string; label: string }): JSX.Element {
    return (
        <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1">
                <span className="text-sm font-medium text-slate-700">{label}</span>
                <input
                    type="text"
                    readOnly
                    value={value}
                    onFocus={(event) => event.currentTarget.select()}
                    className="mt-1 min-h-touch w-full rounded-pos bg-slate-50 px-3 font-mono text-sm ring-1 ring-inset ring-slate-300"
                />
            </label>
            <CopyButton value={value} size="md" />
        </div>
    );
}
