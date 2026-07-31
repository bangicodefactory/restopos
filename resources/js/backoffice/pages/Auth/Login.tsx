/**
 * `Auth/Login` — `GET /login`, props `{ canResetPassword }` (spec 05 §12).
 *
 * The one screen with no layout chrome. The note at the bottom is not decoration: conflating
 * back-office users with cashiers is the classic POS security failure, and the login screen is
 * where an operator would otherwise try their employee PIN.
 */

import { Head, useForm } from '@inertiajs/react';
import { Button } from '@shared/ui';
import type { JSX } from 'react';

import { TextField, ToggleField } from '../../components/form';
import { Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import type { LoginForm, LoginProps } from './types';

export default function Login({ canResetPassword }: LoginProps): JSX.Element {
    const t = useT();
    const form = useForm<LoginForm>({ email: '', password: '', remember: false });

    const submit = (event: React.FormEvent): void => {
        event.preventDefault();
        form.post(routes.login(), { onFinish: () => form.reset('password') });
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-12">
            <Head title={t('auth.login')} />

            <div className="w-full max-w-md">
                <div className="mb-6 flex items-center gap-3">
                    <span
                        aria-hidden
                        className="flex h-10 w-10 items-center justify-center rounded-pos bg-brand-600 text-lg font-bold text-white"
                    >
                        R
                    </span>
                    <div>
                        <div className="text-xl font-bold text-slate-900">RestoPOS</div>
                        <div className="text-sm text-slate-500">{t('app.title')}</div>
                    </div>
                </div>

                <form
                    onSubmit={submit}
                    className="space-y-5 rounded-pos-lg bg-white p-6 shadow-pos ring-1 ring-slate-200"
                >
                    <h1 className="text-lg font-semibold text-slate-900">{t('auth.login')}</h1>

                    <TextField
                        label={t('auth.email')}
                        type="email"
                        autoComplete="username"
                        required
                        value={form.data.email}
                        error={form.errors.email}
                        onChange={(value) => form.setData('email', value)}
                    />

                    <TextField
                        label={t('auth.password')}
                        type="password"
                        autoComplete="current-password"
                        required
                        value={form.data.password}
                        error={form.errors.password}
                        onChange={(value) => form.setData('password', value)}
                    />

                    <ToggleField
                        label={t('auth.remember')}
                        checked={form.data.remember}
                        onChange={(checked) => form.setData('remember', checked)}
                    />

                    <Button type="submit" block loading={form.processing} disabled={form.processing}>
                        {t('auth.submit')}
                    </Button>

                    {canResetPassword ? (
                        <a href="/forgot-password" className="block text-center text-sm text-brand-700 hover:underline">
                            {t('auth.forgot')}
                        </a>
                    ) : (
                        <p className="text-center text-xs text-slate-500">{t('auth.disabled')}</p>
                    )}
                </form>

                <Notice tone="info" className="mt-4">
                    {t('auth.notCashier')}
                </Notice>
            </div>
        </div>
    );
}
