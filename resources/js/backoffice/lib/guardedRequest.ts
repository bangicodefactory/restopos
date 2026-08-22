/**
 * Requests the server is allowed to refuse, with the refusal actually reaching the operator.
 *
 * The back office guards most deletes on the server — a tax an open tab carries, a stage still
 * holding food, a payment method money has gone through — and each refusal is a
 * `ValidationException` naming what is in the way. Those arrive as Inertia `errors`, which a page
 * renders under the matching form field.
 *
 * A delete has no form field. `AppLayout` toasts `flash.success` and `flash.error` and nothing else,
 * so a refused delete used to reload the page, leave the record exactly where it was, and say
 * nothing at all — indistinguishable from a click that did not register. Found while reviewing #84:
 * the guard was right, the message was written, and it went nowhere.
 *
 * The message is the server's own, because it is the only thing that knows *which* open tab or
 * *how many* products are in the way.
 */

import { router } from '@inertiajs/react';
import { useToast } from '@shared/ui';
import { useCallback } from 'react';

/** The first thing the server said, whatever shape it used. */
function firstMessage(errors: Record<string, string>): string | null {
    for (const value of Object.values(errors)) {
        if (typeof value === 'string' && value.trim() !== '') return value;
    }

    return null;
}

/** `DELETE` that surfaces a server refusal as a toast rather than swallowing it. */
export function useGuardedDelete(): (url: string) => void {
    const toast = useToast();

    return useCallback(
        (url: string) => {
            router.delete(url, {
                preserveScroll: true,
                onError: (errors) => {
                    const message = firstMessage(errors as Record<string, string>);

                    if (message === null) return;

                    // Long, because these messages are instructions — "close the table first",
                    // "take it off those products" — not status noise.
                    toast.show({ id: 'refusal', tone: 'danger', title: message, durationMs: 12_000 });
                },
            });
        },
        [toast],
    );
}
