import { Button, Spinner } from '@shared/ui';
import type { JSX } from 'react';
import { useState } from 'react';

import { boot, hardReset, pairDevice } from '../boot';
import { useT } from '../i18n';
import { useSyncStore } from '../state/boot-store';

/**
 * Device pairing (spec 05 §1).
 *
 * One of only two screens allowed to block, and for a reason that cannot be worked around: without
 * a device token there is nothing to work *with* — no catalog, no session, no identity. Everything
 * downstream of here works offline.
 *
 * The token, the device secret and the device uuid go into IndexedDB, never `localStorage`:
 * localStorage is synchronous, string-only, more readily scraped by injected script, and cleared by
 * the same "clear site data" flows the service worker survives.
 */

export function PairingScreen(): JSX.Element {
    const t = useT();
    const online = useSyncStore((state) => state.online);
    const [code, setCode] = useState('');
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        const result = await pairDevice(code, name);
        if (result.ok) {
            await boot();
        } else {
            setError(result.error === 'offline' ? t('reg.boot.pairingNeedsNetwork') : t('reg.boot.pairingFailed'));
        }
        setBusy(false);
    };

    return (
        <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 p-6">
            <header>
                <h1 className="text-3xl font-bold">{t('reg.boot.title')}</h1>
                <p className="mt-1 text-slate-600">{t('reg.boot.pairingHelp')}</p>
            </header>

            <label className="grid gap-1">
                <span className="font-semibold">{t('reg.boot.pairingCode')}</span>
                <input
                    data-testid="pairing-code"
                    type="text"
                    autoFocus
                    inputMode="text"
                    autoCapitalize="characters"
                    className="min-h-touch-xl rounded-pos border-2 border-slate-300 px-4 text-center font-mono text-2xl uppercase tracking-widest"
                    value={code}
                    onChange={(event) => setCode(event.target.value.toUpperCase())}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && code.length >= 4) void submit();
                    }}
                />
            </label>

            <label className="grid gap-1">
                <span className="font-semibold">{t('reg.boot.deviceName')}</span>
                <input
                    data-testid="pairing-name"
                    type="text"
                    className="min-h-touch-lg rounded-pos border border-slate-300 px-3"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Caisse bar"
                />
            </label>

            {!online ? <p className="text-warn-fg">{t('reg.boot.pairingNeedsNetwork')}</p> : null}
            {error ? <p className="text-danger">{error}</p> : null}

            <Button size="xl" block loading={busy} disabled={code.trim().length < 4} onClick={() => void submit()}>
                {busy ? <Spinner size="sm" /> : null}
                {t('reg.boot.pair')}
            </Button>

            <Button
                variant="ghost"
                onClick={async () => {
                    await hardReset(true);
                    globalThis.location?.reload();
                }}
            >
                {t('reg.boot.hardReset')}
            </Button>
        </main>
    );
}
