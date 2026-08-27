/**
 * `PosConfigs/Index` — `GET /pos-configs` (BOF-006, BOF-008).
 *
 * The list is the hub for everything that is configured *per register*: settings, self-order,
 * the register shell itself. `config_revision` is surfaced as a column because it is the number
 * support asks for first — "did the till get your change?" is answered by comparing it.
 */

import { Head, Link, router, useForm } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { SelectField, TextField, ToggleField } from '../../components/form';
import { FormSection } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { ConfirmAction } from '../../components/ui/ConfirmAction';
import { DeleteAction } from '../../components/ui/DeleteAction';
import { Badge, BoolCell, Card, CardBody, CardHeader } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import type { PosConfigListRow, PosConfigsIndexProps } from './types';

export default function PosConfigsIndex({ configs, currencies }: PosConfigsIndexProps): JSX.Element {
    const t = useT();
    const [search, setSearch] = useState('');

    const columns: Column<PosConfigListRow>[] = [
        {
            id: 'name',
            header: t('nav.posConfigs'),
            locked: true,
            cell: (row) => row.name,
            sortValue: (row) => row.name,
            searchValue: (row) => row.name,
            exportValue: (row) => row.name,
        },
        {
            id: 'is_restaurant',
            header: t('dashboard.restaurant'),
            align: 'center',
            cell: (row) => <BoolCell value={row.is_restaurant} labels={[t('state.yes'), t('state.no')]} />,
            sortValue: (row) => row.is_restaurant,
            exportValue: (row) => (row.is_restaurant ? '1' : '0'),
        },
        {
            id: 'self_ordering_mode',
            header: t('self.mode'),
            cell: (row) =>
                row.self_ordering_mode === 'nothing' ? (
                    <span className="text-slate-400">—</span>
                ) : (
                    <Badge tone="brand">{row.self_ordering_mode}</Badge>
                ),
            sortValue: (row) => row.self_ordering_mode,
            searchValue: (row) => row.self_ordering_mode,
            exportValue: (row) => row.self_ordering_mode,
        },
        {
            id: 'config_revision',
            header: t('config.revision', { n: '' }).trim(),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{row.config_revision}</span>,
            sortValue: (row) => row.config_revision,
            exportValue: (row) => row.config_revision,
        },
        {
            id: 'active',
            header: t('state.active'),
            align: 'center',
            cell: (row) => (
                <Badge tone={row.active ? 'ok' : 'neutral'}>{row.active ? t('state.active') : t('state.inactive')}</Badge>
            ),
            sortValue: (row) => row.active,
            exportValue: (row) => (row.active ? '1' : '0'),
        },
        {
            id: 'actions',
            header: '',
            align: 'end',
            cell: (row) => (
                <div className="flex flex-wrap justify-end gap-2">
                    <Link
                        href={routes.posConfigs.edit(row.uuid)}
                        className={cn('rounded-pos px-2 py-1 text-sm text-brand-700 hover:underline', FOCUS_RING)}
                    >
                        {t('nav.settings')}
                    </Link>
                    <Link
                        href={routes.selfOrder.settings(row.uuid)}
                        className={cn('rounded-pos px-2 py-1 text-sm text-brand-700 hover:underline', FOCUS_RING)}
                    >
                        {t('self.title')}
                    </Link>
                    <a
                        href={routes.shells.register(row.id)}
                        className={cn('rounded-pos px-2 py-1 text-sm text-slate-600 hover:underline', FOCUS_RING)}
                    >
                        {t('dashboard.openRegister')}
                    </a>
                    {/*
                      * A second till in a venue differs from the first in its name and almost
                      * nothing else, and the settings screen has eleven tabs. Reproducing them by
                      * hand is how a venue ends up with two registers that quietly disagree about
                      * tax display or cash rounding.
                      */}
                    <ConfirmAction
                        size="sm"
                        label={t('config.duplicate')}
                        title={t('config.duplicate')}
                        message={t('config.duplicateConfirm', { name: row.name })}
                        onConfirm={() => router.post(routes.posConfigs.duplicate(row.uuid), {}, { preserveScroll: true })}
                    />
                    {/*
                      * Archived, never deleted: every session and order this register took names
                      * it. Refused while a session is open, and the server says so.
                      */}
                    <DeleteAction
                        size="sm"
                        url={routes.posConfigs.destroy(row.uuid)}
                        name={row.name}
                        label={t('config.archive')}
                        disabled={!row.active}
                    />
                </div>
            ),
        },
    ];

    return (
        <AppLayout title={t('config.title')} description={t('config.revisionHint')}>
            <Head title={t('config.title')} />

            <div className="space-y-6">
                <OpenRegister currencies={currencies} />

                <DataTable
                    columns={columns}
                    rows={configs}
                    getRowId={(row) => row.id}
                    storageKey="pos-configs"
                    caption={t('config.title')}
                    search={{ value: search, onChange: setSearch }}
                    exportFilename="points-de-vente"
                    onRowHref={(row) => routes.posConfigs.edit(row.uuid)}
                    perPage={25}
                />
            </div>
        </AppLayout>
    );
}

/**
 * Opening a register (BAN-472).
 *
 * A venue could not add a second till: the set of registers was whatever the seeder produced, which
 * made onboarding a new shop impossible through the UI.
 *
 * Three fields, then straight to the settings screen. Every other column has a default, and asking
 * for eighty of them before a venue has taken a single sale is how a create form becomes something
 * people avoid. The currency is here only because it is the one field that cannot be changed once
 * the register has taken money.
 */
function OpenRegister({ currencies }: { currencies: PosConfigsIndexProps['currencies'] }): JSX.Element {
    const t = useT();
    const form = useForm<{ name: string; currency_id: number; is_restaurant: boolean }>({
        name: '',
        currency_id: currencies[0]?.id ?? 0,
        is_restaurant: false,
    });

    return (
        <Card>
            <CardHeader title={t('config.open')} description={t('config.openHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('config.nameLabel')}
                        value={form.data.name}
                        error={form.errors.name}
                        maxLength={96}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <SelectField
                        label={t('config.currency')}
                        value={String(form.data.currency_id)}
                        error={form.errors.currency_id}
                        hint={t('config.currencyFixed')}
                        options={currencies.map((row) => ({ value: String(row.id), label: `${row.code} · ${row.name}` }))}
                        onChange={(value) => form.setData('currency_id', Number(value))}
                    />
                    <ToggleField
                        label={t('dashboard.restaurant')}
                        checked={form.data.is_restaurant}
                        onChange={(checked) => form.setData('is_restaurant', checked)}
                        description={t('config.restaurantHint')}
                    />
                </FormSection>

                <Button
                    loading={form.processing}
                    disabled={form.data.name.trim() === '' || form.data.currency_id === 0}
                    onClick={() => form.post(routes.posConfigs.store())}
                >
                    {t('config.open')}
                </Button>
            </CardBody>
        </Card>
    );
}
