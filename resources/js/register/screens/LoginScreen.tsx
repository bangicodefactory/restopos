import type { EmployeeRow } from '@domain/types';
import { persistCashier, useSessionStore, verifyPin } from '@shared/auth';
import { Button, NumPad, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useState } from 'react';

import { tryRuntime } from '../data/runtime';
import { useT } from '../i18n';
import { useCatalog } from '../hooks/use-register';

/**
 * Cashier selection and PIN (REG-040 … REG-042, REG-049).
 *
 * Verification is **offline**, against the per-device HMAC verifiers shipped in the bootstrap
 * payload: switching cashier has to take under 100 ms with the network unplugged, hundreds of times
 * a shift. Because the HMAC key is per device, a bootstrap payload lifted off terminal A is useless
 * on terminal B.
 *
 * The same component is the lock screen: after the idle timeout the register locks rather than
 * logging out, so the next tap needs a PIN but the open orders are still there.
 */

export type LoginScreenProps = {
    /** Lock mode keeps the current cashier pre-selected and hides the grid. */
    mode?: 'login' | 'lock';
    onDone?: () => void;
};

export function LoginScreen({ mode = 'login', onDone }: LoginScreenProps): JSX.Element {
    const t = useT();
    const catalog = useCatalog();
    const cashier = useSessionStore((state) => state.cashier);
    const setCashier = useSessionStore((state) => state.setCashier);

    const employees = catalog.employees;
    const [selected, setSelected] = useState<EmployeeRow | null>(
        mode === 'lock' && cashier
            ? (employees.find((employee) => employee.id === cashier.employee_id) ?? null)
            : null,
    );
    const [pin, setPin] = useState('');
    const [error, setError] = useState<string | null>(null);

    const finish = async (employee: EmployeeRow): Promise<void> => {
        setCashier(employee);
        const runtime = tryRuntime();
        if (runtime) {
            await persistCashier(runtime.db, useSessionStore.getState().cashier);
        }
        setPin('');
        setSelected(null);
        onDone?.();
    };

    const pick = async (employee: EmployeeRow): Promise<void> => {
        setError(null);
        // No PIN configured ⇒ selection alone is the login (REG-040 with employee login off).
        if (!employee.has_pin) {
            await finish(employee);
            return;
        }
        setSelected(employee);
    };

    const submit = async (value: string): Promise<void> => {
        const runtime = tryRuntime();
        if (!runtime?.deviceKey || !selected) return;
        const result = await verifyPin(
            { db: runtime.db, deviceKey: runtime.deviceKey, employees },
            selected.id,
            value,
        );
        if (result.ok) {
            await finish(result.employee);
            return;
        }
        setPin('');
        setError(
            result.reason === 'locked'
                ? t('reg.login.locked', { seconds: Math.ceil((result.retryAfterMs ?? 0) / 1000) })
                : t('reg.login.wrongPin'),
        );
    };

    return (
        <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col justify-center gap-6 p-6">
            <h1 className="text-3xl font-bold">
                {mode === 'lock' ? t('reg.login.lockTitle') : t('reg.login.title')}
            </h1>

            {selected === null ? (
                <>
                    {employees.length === 0 ? (
                        <p className="text-slate-600">{t('reg.login.noEmployees')}</p>
                    ) : null}
                    <div className="grid grid-cols-2 gap-3 till:grid-cols-4">
                        {employees.map((employee) => (
                            <button
                                key={employee.id}
                                type="button"
                                onClick={() => void pick(employee)}
                                className="min-h-touch-xl rounded-pos bg-white px-3 py-4 text-lg font-semibold shadow-pos ring-1 ring-slate-200"
                            >
                                {employee.name}
                                <span className="mt-1 block text-xs font-normal text-slate-500">
                                    {employee.default_role}
                                </span>
                            </button>
                        ))}
                    </div>
                </>
            ) : (
                <div className="mx-auto w-full max-w-sm space-y-3">
                    <p className="text-center text-lg">{t('reg.login.pinFor', { name: selected.name })}</p>
                    <div
                        className={cn(
                            'rounded-pos bg-slate-900 px-4 py-4 text-center font-mono text-3xl tracking-[0.5em] text-white',
                            error && 'ring-2 ring-danger',
                        )}
                    >
                        {'•'.repeat(pin.length) || '····'}
                    </div>
                    {error ? <p className="text-center text-danger">{error}</p> : null}

                    <NumPad
                        value={pin}
                        onChange={(next) => {
                            setPin(next);
                            setError(null);
                        }}
                        onConfirm={(value) => void submit(value)}
                        mode="plain"
                        decimals={0}
                        scannerGuardMs={0}
                        confirmLabel={mode === 'lock' ? t('reg.login.unlock') : t('reg.login.openRegister')}
                    />

                    {mode === 'login' ? (
                        <Button variant="ghost" block onClick={() => setSelected(null)}>
                            {t('common.back')}
                        </Button>
                    ) : null}
                </div>
            )}
        </main>
    );
}
