/**
 * `Devices/Index` — `GET /devices` (spec 03 §2.2).
 *
 * Paired devices, the pairing-code flow, and revocation.
 *
 * **Pairing.** A code is minted for a *config* and a device type
 * (`POST /pos-configs/{config}/pairing-codes`, JSON rather than a redirect — spec 05 §12.1) and
 * is short-lived. The panel shows it large and monospaced with a live countdown, because it is
 * read aloud across a room or typed on a tablet at the other end of a counter, and it stops
 * showing it the moment it expires rather than leaving a dead code on screen for someone to keep
 * trying.
 *
 * **Revocation is honest about what it cannot do.** Revoking kills the device's tokens
 * immediately, but an *offline* till keeps working until it reconnects — that is unavoidable and
 * correct: a till mid-shift must not brick itself. The confirmation says so in as many words,
 * because the compensating control (its queued orders arrive quarantined) only makes sense if the
 * operator knows the till is still selling.
 */

import { Head } from '@inertiajs/react';
import { Button, FOCUS_RING, cn, useToast } from '@shared/ui';
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { AppLayout } from '../../components/layout/AppLayout';
import { ConfirmAction } from '../../components/ui/ConfirmAction';
import { CopyButton } from '../../components/ui/CopyButton';
import { Badge, Card, CardBody, CardHeader, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { dateTime, relative } from '../../lib/format';
import { HttpError, postJson } from '../../lib/http';
import { useGuardedDelete } from '../../lib/guardedRequest';
import { routes } from '../../lib/routes';

import {
    DEVICE_TYPES,
    DEVICE_TYPE_LABEL,
    FRESHNESS_TONE,
    freshnessOf,
    shortUserAgent,
    type DeviceRow,
    type DevicesIndexProps,
    type PairingCodeResponse,
} from './types';

export default function DevicesIndex({ devices, configs }: DevicesIndexProps): JSX.Element {
    const t = useT();
    const revoke = useGuardedDelete();
    const [search, setSearch] = useState('');
    const [configFilter, setConfigFilter] = useState('');

    const rows = useMemo(
        () =>
            configFilter === ''
                ? devices
                : devices.filter((device) => String(device.pos_config_id) === configFilter),
        [configFilter, devices],
    );

    const columns: Column<DeviceRow>[] = [
        {
            id: 'name',
            header: t('device.title'),
            locked: true,
            cell: (row) => (
                <span className="flex flex-col">
                    <span className="font-medium text-slate-900">
                        {row.name ?? `${DEVICE_TYPE_LABEL[row.device_type] ?? row.device_type} #${row.device_identifier}`}
                    </span>
                    <span className="font-mono text-xs text-slate-500">{row.uuid}</span>
                </span>
            ),
            sortValue: (row) => row.name ?? String(row.device_identifier),
            searchValue: (row) => `${row.name ?? ''} ${row.uuid} ${row.device_type}`,
            exportValue: (row) => row.name ?? '',
        },
        {
            id: 'device_type',
            header: t('device.type'),
            cell: (row) => <Badge tone="brand">{DEVICE_TYPE_LABEL[row.device_type] ?? row.device_type}</Badge>,
            sortValue: (row) => row.device_type,
            exportValue: (row) => row.device_type,
        },
        {
            id: 'pos_config',
            header: t('report.config'),
            cell: (row) => row.pos_config_name ?? `#${row.pos_config_id}`,
            sortValue: (row) => row.pos_config_name ?? String(row.pos_config_id),
            searchValue: (row) => row.pos_config_name,
            exportValue: (row) => row.pos_config_name,
        },
        {
            id: 'device_identifier',
            header: t('device.identifier'),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{row.device_identifier}</span>,
            sortValue: (row) => row.device_identifier,
            exportValue: (row) => row.device_identifier,
        },
        {
            id: 'last_seen_at',
            header: t('device.lastSeen'),
            cell: (row) => {
                const freshness = freshnessOf(row.last_seen_at);
                return (
                    <span className="flex flex-col">
                        <Badge tone={FRESHNESS_TONE[freshness] ?? 'neutral'}>{relative(row.last_seen_at)}</Badge>
                        <span className="pt-0.5 text-xs text-slate-500">{dateTime(row.last_seen_at)}</span>
                    </span>
                );
            },
            sortValue: (row) => row.last_seen_at,
            exportValue: (row) => row.last_seen_at,
        },
        {
            id: 'last_synced_at',
            header: t('device.lastSync'),
            defaultHidden: true,
            cell: (row) => <span className="tabular-nums">{dateTime(row.last_synced_at)}</span>,
            sortValue: (row) => row.last_synced_at,
            exportValue: (row) => row.last_synced_at,
        },
        {
            id: 'user_agent',
            header: t('device.userAgent'),
            defaultHidden: true,
            cell: (row) => (
                <span className="text-xs text-slate-600" title={row.user_agent ?? undefined}>
                    {shortUserAgent(row.user_agent)}
                </span>
            ),
            searchValue: (row) => row.user_agent,
            exportValue: (row) => row.user_agent,
        },
        {
            id: 'active',
            header: t('state.active'),
            align: 'center',
            cell: (row) => (
                <Badge tone={row.active ? 'ok' : 'danger'}>
                    {row.active ? t('state.active') : t('device.revoked')}
                </Badge>
            ),
            sortValue: (row) => row.active,
            exportValue: (row) => (row.active ? '1' : '0'),
        },
        {
            id: 'actions',
            header: '',
            align: 'end',
            cell: (row) => (
                <ConfirmAction
                    size="sm"
                    label={t('device.revoke')}
                    title={t('device.revoke')}
                    message={t('device.revokeConfirm', {
                        name: row.name ?? `#${row.device_identifier}`,
                    })}
                    confirmPhrase={String(row.device_identifier)}
                    disabled={!row.active}
                    onConfirm={() => revoke(routes.devices.destroy(row.uuid))}
                />
            ),
        },
    ];

    return (
        <AppLayout title={t('device.title')} description={t('device.intro')}>
            <Head title={t('device.title')} />

            <div className="space-y-6">
                <PairingPanel configs={configs} />

                <DataTable
                    columns={columns}
                    rows={rows}
                    getRowId={(row) => row.id}
                    storageKey="devices"
                    caption={t('device.title')}
                    search={{ value: search, onChange: setSearch }}
                    filters={
                        <>
                            <label className="sr-only" htmlFor="device-config-filter">
                                {t('report.config')}
                            </label>
                            <select
                                id="device-config-filter"
                                value={configFilter}
                                onChange={(event) => setConfigFilter(event.target.value)}
                                className={cn(
                                    'min-h-touch rounded-pos bg-white px-3 text-sm ring-1 ring-inset ring-slate-300',
                                    FOCUS_RING,
                                )}
                            >
                                <option value="">
                                    {t('report.config')} — {t('state.all')}
                                </option>
                                {configs.map((config) => (
                                    <option key={config.id} value={String(config.id)}>
                                        {config.name}
                                    </option>
                                ))}
                            </select>
                            {configFilter === '' ? null : (
                                <Button variant="ghost" size="md" onClick={() => setConfigFilter('')}>
                                    {t('action.clearFilters')}
                                </Button>
                            )}
                        </>
                    }
                    exportFilename="appareils"
                    perPage={50}
                    emptyTitle={t('state.empty')}
                    emptyHint={t('device.emptyHint')}
                />

                <Notice tone="info" title={t('device.offlineRevokeTitle')}>
                    {t('device.offlineRevoke')}
                </Notice>
            </div>
        </AppLayout>
    );
}

// ───────────────────────────────────────────────────────────── pairing

function PairingPanel({ configs }: { configs: DevicesIndexProps['configs'] }): JSX.Element {
    const t = useT();
    const toast = useToast();
    // Pairing codes are minted per config by uuid (the route binds by uuid, not id).
    const [configUuid, setConfigUuid] = useState<string>(configs[0]?.uuid ?? '');
    const [deviceType, setDeviceType] = useState<string>('register');
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [code, setCode] = useState<PairingCodeResponse | null>(null);
    const [remaining, setRemaining] = useState(0);

    // A pairing code that has expired must stop being shown, not linger for someone to retype.
    useEffect(() => {
        if (code === null) return undefined;
        setRemaining(code.ttl_seconds);
        const timer = setInterval(() => {
            setRemaining((value) => {
                if (value <= 1) {
                    setCode(null);
                    return 0;
                }
                return value - 1;
            });
        }, 1_000);
        return () => clearInterval(timer);
    }, [code]);

    const mint = useCallback(async () => {
        if (configUuid === '') {
            toast.show({ tone: 'danger', title: t('device.pairingNeedsConfig') });
            return;
        }

        setBusy(true);
        try {
            const response = await postJson<PairingCodeResponse>(routes.posConfigs.pairingCodes(configUuid), {
                device_type: deviceType,
                name: name.trim() === '' ? null : name.trim(),
            });
            setCode(response);
        } catch (error) {
            toast.show({
                tone: 'danger',
                title: t('config.pairingFailed'),
                message: error instanceof HttpError ? error.message : undefined,
            });
        } finally {
            setBusy(false);
        }
    }, [configUuid, deviceType, name, t, toast]);

    return (
        <Card>
            <CardHeader title={t('config.pairing')} description={t('device.pairingHint')} />
            <CardBody className="space-y-4">
                <div className="flex flex-wrap items-end gap-3">
                    <label className="flex flex-col gap-1 text-sm font-medium text-slate-700" htmlFor="pairing-config">
                        {t('report.config')}
                        <select
                            id="pairing-config"
                            value={configUuid}
                            onChange={(event) => setConfigUuid(event.target.value)}
                            className={cn(
                                'min-h-touch rounded-pos bg-white px-3 text-sm ring-1 ring-inset ring-slate-300',
                                FOCUS_RING,
                            )}
                        >
                            {configs.length === 0 ? <option value="">{t('state.none')}</option> : null}
                            {configs.map((config) => (
                                <option key={config.id} value={config.uuid}>
                                    {config.name}
                                </option>
                            ))}
                        </select>
                    </label>

                    <label className="flex flex-col gap-1 text-sm font-medium text-slate-700" htmlFor="pairing-type">
                        {t('device.type')}
                        <select
                            id="pairing-type"
                            value={deviceType}
                            onChange={(event) => setDeviceType(event.target.value)}
                            className={cn(
                                'min-h-touch rounded-pos bg-white px-3 text-sm ring-1 ring-inset ring-slate-300',
                                FOCUS_RING,
                            )}
                        >
                            {DEVICE_TYPES.map((type) => (
                                <option key={type} value={type}>
                                    {DEVICE_TYPE_LABEL[type] ?? type}
                                </option>
                            ))}
                        </select>
                    </label>

                    <label className="flex flex-col gap-1 text-sm font-medium text-slate-700" htmlFor="pairing-name">
                        {t('device.name')}
                        <input
                            id="pairing-name"
                            type="text"
                            value={name}
                            maxLength={80}
                            placeholder={t('device.nameOptional')}
                            onChange={(event) => setName(event.target.value)}
                            className={cn(
                                'min-h-touch rounded-pos bg-white px-3 text-sm ring-1 ring-inset ring-slate-300',
                                FOCUS_RING,
                            )}
                        />
                    </label>

                    <Button size="md" loading={busy} disabled={configs.length === 0} onClick={() => void mint()}>
                        {t('config.pairing')}
                    </Button>
                </div>

                {code === null ? null : (
                    <div
                        role="status"
                        aria-live="polite"
                        className="rounded-pos bg-brand-50 p-4 text-center ring-1 ring-brand-200"
                    >
                        <div className="text-sm text-brand-800">{t('config.pairingCode')}</div>
                        <div className="mt-1 font-mono text-4xl font-bold tracking-[0.3em] text-brand-900">
                            {code.code}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center justify-center gap-3 text-xs text-brand-800">
                            <span className="tabular-nums">
                                {t('config.pairingExpires', { seconds: remaining })}
                            </span>
                            <span>{dateTime(code.expires_at)}</span>
                            <CopyButton value={code.code} />
                        </div>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}
