import { Button, Spinner, cn } from '@shared/ui';
import { useState, type JSX } from 'react';

import { useT, type Locale } from '../i18n';
import { LocaleSwitch } from './Chrome';

/**
 * Pairing and display selection (KDS-002).
 *
 * A display is a *shared* device: there is no cashier login, no personal identity and no access to
 * money. It is enrolled once with a short-lived pairing code from the back office, and from then on
 * it authenticates with a revocable device token. Both screens are deliberately plain and enormous
 * — they are used once, standing on a stepladder.
 */

function Shell({ title, children }: { title: string; children: JSX.Element }): JSX.Element {
    return (
        <div className="flex h-full items-center justify-center bg-kitchen-bg p-6 text-kitchen-text">
            <div className="w-full max-w-xl rounded-pos-lg bg-kitchen-surface p-6 shadow-pos-lg ring-1 ring-kitchen-border">
                <h1 className="mb-4 text-3xl font-black">{title}</h1>
                {children}
            </div>
        </div>
    );
}

export function PairingScreen({
    loading,
    error,
    onPair,
    onLocale,
}: {
    loading: boolean;
    error: string | null;
    onPair: (code: string, name: string) => void;
    onLocale: (locale: Locale) => void;
}): JSX.Element {
    const t = useT();
    const [code, setCode] = useState('');
    const [name, setName] = useState('');

    return (
        <Shell title={t('kds.pair.title')}>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    if (code.trim() !== '') onPair(code, name);
                }}
                className="flex flex-col gap-4"
            >
                <p className="text-lg text-kitchen-muted">{t('kds.pair.intro')}</p>

                <label className="flex flex-col gap-1">
                    <span className="text-lg font-bold">{t('kds.pair.code')}</span>
                    <input
                        value={code}
                        onChange={(event) => setCode(event.target.value.toUpperCase())}
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        maxLength={16}
                        className="min-h-touch-xl rounded-pos bg-kitchen-raised px-4 font-mono text-3xl tracking-[0.3em] text-kitchen-text ring-1 ring-inset ring-kitchen-border"
                    />
                </label>

                <label className="flex flex-col gap-1">
                    <span className="text-lg font-bold">{t('kds.pair.name')}</span>
                    <input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={60}
                        className="min-h-touch-lg rounded-pos bg-kitchen-raised px-4 text-xl text-kitchen-text ring-1 ring-inset ring-kitchen-border"
                    />
                </label>

                {error && (
                    <p role="alert" className="rounded-pos bg-kitchen-late/20 px-3 py-2 text-lg font-bold text-kitchen-late">
                        {t(error)}
                    </p>
                )}

                <Button type="submit" size="xl" loading={loading} disabled={code.trim() === ''} block>
                    {t('kds.pair.submit')}
                </Button>

                <div className="flex justify-center pt-2">
                    <LocaleSwitch onChange={onLocale} />
                </div>
            </form>
        </Shell>
    );
}

export function DisplayPicker({
    displays,
    loading,
    onChoose,
    onUnpair,
    onLocale,
}: {
    displays: Array<{ id: number; name: string; token: string }>;
    loading: boolean;
    onChoose: (display: { id: number; name: string; token: string }) => void;
    onUnpair: () => void;
    onLocale: (locale: Locale) => void;
}): JSX.Element {
    const t = useT();
    const [manual, setManual] = useState('');

    return (
        <Shell title={t('kds.display.choose')}>
            <div className="flex flex-col gap-4">
                <p className="text-lg text-kitchen-muted">{t('kds.display.intro')}</p>

                {loading && displays.length === 0 && <Spinner size="lg" label={t('common.loading')} />}

                {!loading && displays.length === 0 && (
                    <p className="rounded-pos bg-kitchen-raised px-3 py-2 text-lg">{t('kds.display.none')}</p>
                )}

                <ul className="flex flex-col gap-2">
                    {displays.map((display) => (
                        <li key={display.id}>
                            <button
                                type="button"
                                onClick={() => onChoose(display)}
                                className={cn(
                                    'min-h-touch-xl w-full rounded-pos bg-kitchen-raised px-4 text-start text-2xl font-bold',
                                    'ring-1 ring-inset ring-kitchen-border active:brightness-125',
                                )}
                            >
                                {display.name}
                            </button>
                        </li>
                    ))}
                </ul>

                <form
                    className="flex gap-2 pt-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const token = manual.trim();
                        if (token !== '') onChoose({ id: 0, name: token, token });
                    }}
                >
                    <input
                        value={manual}
                        onChange={(event) => setManual(event.target.value)}
                        placeholder={t('kds.display.manual')}
                        aria-label={t('kds.display.manual')}
                        className="min-h-touch-lg flex-1 rounded-pos bg-kitchen-raised px-4 font-mono text-lg text-kitchen-text ring-1 ring-inset ring-kitchen-border"
                    />
                    <Button type="submit" variant="secondary" disabled={manual.trim() === ''}>
                        {t('common.ok')}
                    </Button>
                </form>

                <div className="flex items-center justify-between pt-2">
                    <LocaleSwitch onChange={onLocale} />
                    <Button
                        variant="danger"
                        size="md"
                        onClick={() => {
                            if (globalThis.confirm?.(t('kds.display.unpairConfirm'))) onUnpair();
                        }}
                    >
                        {t('kds.display.unpair')}
                    </Button>
                </div>
            </div>
        </Shell>
    );
}

export function RevokedScreen({ onUnpair }: { onUnpair: () => void }): JSX.Element {
    const t = useT();
    return (
        <Shell title={t('kds.pair.title')}>
            <div className="flex flex-col gap-4">
                <p role="alert" className="rounded-pos bg-kitchen-late/20 px-3 py-2 text-xl font-bold text-kitchen-late">
                    {t('kds.pair.revoked')}
                </p>
                <Button size="xl" block onClick={onUnpair}>
                    {t('kds.pair.submit')}
                </Button>
            </div>
        </Shell>
    );
}
