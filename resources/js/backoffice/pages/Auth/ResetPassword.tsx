/**
 * `Auth/ResetPassword`.
 *
 * Same status as `Auth/ForgotPassword`: no `password.update` route exists, so the form is
 * rendered disabled with the reason stated. Wiring it up is a controller and a route, not a
 * redesign.
 */

import { Head } from '@inertiajs/react';
import { Button } from '@shared/ui';
import { useState, type JSX } from 'react';

import { TextField } from '../../components/form';
import { Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import type { ResetPasswordProps } from './types';

export default function ResetPassword({ email = '' }: ResetPasswordProps): JSX.Element {
    const t = useT();
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');

    return (
        <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-12">
            <Head title={t('auth.resetTitle')} />

            <div className="w-full max-w-md space-y-4">
                <div className="space-y-4 rounded-pos-lg bg-white p-6 shadow-pos ring-1 ring-slate-200">
                    <h1 className="text-lg font-semibold text-slate-900">{t('auth.resetTitle')}</h1>

                    <TextField label={t('auth.email')} type="email" value={email} onChange={() => {}} disabled />
                    <TextField
                        label={t('auth.password')}
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        onChange={setPassword}
                        disabled
                        lockedReason={t('auth.disabled')}
                    />
                    <TextField
                        label={t('auth.passwordConfirm')}
                        type="password"
                        autoComplete="new-password"
                        value={confirmation}
                        onChange={setConfirmation}
                        disabled
                    />

                    <Button block disabled>
                        {t('auth.resetSubmit')}
                    </Button>
                </div>

                <Notice tone="warn">{t('auth.disabled')}</Notice>

                <a href={routes.login()} className="block text-center text-sm text-brand-700 hover:underline">
                    {t('action.back')}
                </a>
            </div>
        </div>
    );
}
