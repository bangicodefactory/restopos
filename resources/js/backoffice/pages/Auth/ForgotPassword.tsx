/**
 * `Auth/ForgotPassword`.
 *
 * **Contract gap.** `routes/web.php` has no `password.request` / `password.email` route and
 * `AuthenticatedSessionController::create()` returns `canResetPassword: false`, so nothing ever
 * renders this component today. It exists so the flow is one route away, and it says plainly that
 * the feature is off rather than presenting a form that would POST into a 404.
 */

import { Head } from '@inertiajs/react';
import { Button } from '@shared/ui';
import { useState, type JSX } from 'react';

import { TextField } from '../../components/form';
import { Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import type { ForgotPasswordProps } from './types';

export default function ForgotPassword({ status = null }: ForgotPasswordProps): JSX.Element {
    const t = useT();
    const [email, setEmail] = useState('');

    return (
        <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-12">
            <Head title={t('auth.forgotTitle')} />

            <div className="w-full max-w-md space-y-4">
                <div className="rounded-pos-lg bg-white p-6 shadow-pos ring-1 ring-slate-200">
                    <h1 className="text-lg font-semibold text-slate-900">{t('auth.forgotTitle')}</h1>
                    <p className="mt-1 text-sm text-slate-600">{t('auth.forgotIntro')}</p>

                    {status ? (
                        <Notice tone="ok" className="mt-4">
                            {status}
                        </Notice>
                    ) : null}

                    <div className="mt-4 space-y-4">
                        <TextField
                            label={t('auth.email')}
                            type="email"
                            autoComplete="username"
                            value={email}
                            onChange={setEmail}
                            disabled
                            lockedReason={t('auth.disabled')}
                        />

                        <Button block disabled>
                            {t('auth.forgotSubmit')}
                        </Button>
                    </div>
                </div>

                <Notice tone="warn">{t('auth.disabled')}</Notice>

                <a href={routes.login()} className="block text-center text-sm text-brand-700 hover:underline">
                    {t('action.back')}
                </a>
            </div>
        </div>
    );
}
