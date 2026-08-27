/**
 * An image picker that yields a **media id** (BAN-393).
 *
 * `ImageField` hands back a `File` and a data URL and says the owning form decides what to do with
 * them. Before this, no form could decide anything: there was no upload route in the application, so
 * every picker in the back office was a `Notice` explaining why it was not a picker.
 *
 * The upload is its own request rather than part of the form's submit. Two reasons:
 *
 *  1. **An Inertia submit redirects.** The editor needs the *id* so it can put it in the field it is
 *     editing, and a redirect hands back a page, not a value.
 *  2. **A form must stay saveable.** If the image rode along with the submit, every later save of
 *     that record would re-upload it — and a validation error elsewhere on the form would throw the
 *     upload away.
 *
 * So: pick a file, it uploads, the field holds an id. The preview shows immediately from the local
 * data URL and switches to the served URL once the id exists, which means a slow upload never leaves
 * the operator looking at an empty box wondering whether it worked.
 */

import { useCallback, useState, type JSX } from 'react';

import { ImageField } from './fields';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

type UploadResponse = {
    id: number;
    url: string;
    filename: string;
};

export function MediaField({
    label,
    collection,
    value,
    onChange,
    hint,
    disabled,
    lockedReason,
}: {
    label: string;
    /** Which `MediaCollection` this belongs to — it decides the disk and whether it is public. */
    collection: string;
    value: number | null;
    onChange: (mediaId: number | null) => void;
    hint?: string;
    disabled?: boolean;
    lockedReason?: string;
}): JSX.Element {
    const t = useT();
    const [preview, setPreview] = useState<string | null>(value === null ? null : routes.media.show(value));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const upload = useCallback(
        async (file: File | null, localPreview: string | null): Promise<void> => {
            if (file === null) {
                setPreview(null);
                setError(null);
                onChange(null);

                return;
            }

            // Shown straight away. The server round-trip can take a moment on a venue's connection,
            // and an empty box during it reads as "nothing happened".
            setPreview(localPreview);
            setBusy(true);
            setError(null);

            const body = new FormData();
            body.append('file', file);
            body.append('collection', collection);

            try {
                const response = await fetch(routes.media.store(), {
                    method: 'POST',
                    body,
                    headers: { Accept: 'application/json' },
                    credentials: 'same-origin',
                });

                if (!response.ok) {
                    // The server names what is wrong — wrong type, too large, no permission — and
                    // that is more use than a generic failure.
                    const payload = (await response.json().catch(() => null)) as
                        | { message?: string; errors?: Record<string, string[]> }
                        | null;

                    setError(payload?.errors?.file?.[0] ?? payload?.message ?? t('form.uploadFailed'));
                    setPreview(value === null ? null : routes.media.show(value));

                    return;
                }

                const media = (await response.json()) as UploadResponse;

                setPreview(media.url);
                onChange(media.id);
            } catch {
                setError(t('form.uploadFailed'));
                setPreview(value === null ? null : routes.media.show(value));
            } finally {
                setBusy(false);
            }
        },
        [collection, onChange, t, value],
    );

    return (
        <ImageField
            label={label}
            previewUrl={preview}
            error={error ?? undefined}
            hint={busy ? t('form.uploading') : hint}
            disabled={disabled || busy}
            lockedReason={lockedReason}
            onChange={(file, localPreview) => {
                void upload(file, localPreview);
            }}
        />
    );
}
