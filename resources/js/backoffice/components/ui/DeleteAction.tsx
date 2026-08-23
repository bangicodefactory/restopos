/**
 * Removing a record, with the server's refusal actually reaching the operator.
 *
 * Almost every delete in this back office is guarded server-side and refuses by name — a tax an open
 * tab carries, a category a printer routes on, a payment method money has gone through. Those
 * refusals are `ValidationException`s, which arrive as Inertia `errors` and are rendered by whatever
 * form owns the matching field. A delete owns no field, so without `useGuardedDelete` the page
 * simply reloads with the record still there and nothing said.
 *
 * Confirmation is by **typing the name**, not by clicking "yes". These are records other things
 * point at, and the point of the friction is to make the operator read which record they picked.
 */

import { type JSX, type ReactNode } from 'react';

import { useT } from '../../i18n';
import { useGuardedDelete } from '../../lib/guardedRequest';

import { ConfirmAction } from './ConfirmAction';

export function DeleteAction({
    url,
    name,
    label,
    message,
    size = 'sm',
    disabled,
}: {
    /** The `DELETE` endpoint for this record. */
    url: string;
    /** What the operator must retype, and what the message names. */
    name: string;
    label?: ReactNode;
    /** Why this might not be reversible. The server still has the final say. */
    message?: ReactNode;
    size?: 'sm' | 'md';
    disabled?: boolean;
}): JSX.Element {
    const t = useT();
    const remove = useGuardedDelete();

    return (
        <ConfirmAction
            size={size}
            disabled={disabled}
            label={label ?? t('action.delete')}
            title={t('confirm.title')}
            message={message ?? t('confirm.deleteRecord', { name })}
            confirmPhrase={name}
            onConfirm={() => remove(url)}
        />
    );
}
