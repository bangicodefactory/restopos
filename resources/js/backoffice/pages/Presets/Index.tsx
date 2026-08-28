/**
 * `Presets/Index` — `GET /presets` (BOF-113).
 *
 * Service modes: eat-in, takeaway, delivery, and whatever else a venue runs. The menu entry has been
 * here since the back office was built, pointing at nothing — the modes existed only as seeded rows
 * and could not be created (BAN-429).
 */

import { Head, Link, router, useForm } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { FormSection, SelectField, TextField } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, Card, CardBody, CardHeader } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import type { NamedRow, PresetListRow, PresetsIndexProps } from './types';

/** A `t()` key is a closed union, which is what stops a missing translation reaching a screen. */
const SERVICE_AT_LABEL = {
    counter: 'preset.serviceAt.counter',
    table: 'preset.serviceAt.table',
    delivery: 'preset.serviceAt.delivery',
} as const;

const IDENTIFICATION_LABEL = {
    none: 'preset.identification.none',
    name: 'preset.identification.name',
    address: 'preset.identification.address',
} as const;

export default function PresetsIndex({ presets, pricelists, fiscalPositions }: PresetsIndexProps): JSX.Element {
    const t = useT();
    const [search, setSearch] = useState('');

    const columns: Column<PresetListRow>[] = [
        {
            id: 'name',
            header: t('preset.name'),
            locked: true,
            cell: (row) => (
                <span className="flex items-center gap-2">
                    {row.name}
                    {row.is_system ? <Badge tone="neutral">{t('preset.system')}</Badge> : null}
                </span>
            ),
            sortValue: (row) => row.name,
            searchValue: (row) => row.name,
            exportValue: (row) => row.name,
        },
        {
            id: 'service_at',
            header: t('preset.serviceAt'),
            cell: (row) => t(SERVICE_AT_LABEL[row.service_at]),
            sortValue: (row) => row.service_at,
            exportValue: (row) => row.service_at,
        },
        {
            id: 'identification',
            header: t('preset.identification'),
            defaultHidden: true,
            cell: (row) => t(IDENTIFICATION_LABEL[row.identification]),
            sortValue: (row) => row.identification,
            exportValue: (row) => row.identification,
        },
        {
            id: 'timing',
            header: t('preset.timing'),
            cell: (row) =>
                row.use_timing ? (
                    <span className="flex flex-col">
                        <Badge tone="brand">{t('preset.booked')}</Badge>
                        <span className="mt-0.5 text-xs text-slate-500">
                            {t('preset.capacity', {
                                slots: String(row.slots_per_interval),
                                minutes: String(row.interval_minutes),
                            })}
                        </span>
                    </span>
                ) : (
                    <span className="text-slate-500">{t('preset.asTheyCome')}</span>
                ),
            sortValue: (row) => row.use_timing,
            exportValue: (row) => (row.use_timing ? '1' : '0'),
        },
        {
            id: 'window_count',
            header: t('preset.hours'),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{row.window_count}</span>,
            sortValue: (row) => row.window_count,
            exportValue: (row) => row.window_count,
        },
        {
            id: 'available_in_self',
            header: t('preset.inSelfOrder'),
            align: 'center',
            cell: (row) => (row.available_in_self ? <Badge tone="ok">{t('state.yes')}</Badge> : null),
            sortValue: (row) => row.available_in_self,
            exportValue: (row) => (row.available_in_self ? '1' : '0'),
        },
        {
            id: 'active',
            header: t('state.active'),
            align: 'center',
            cell: (row) => (
                <Badge tone={row.active ? 'ok' : 'neutral'}>
                    {row.active ? t('state.active') : t('state.inactive')}
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
                <Link
                    href={routes.presets.edit(row.id)}
                    className={cn('rounded-pos px-2 py-1 text-sm text-brand-700 hover:underline', FOCUS_RING)}
                >
                    {t('action.edit')}
                </Link>
            ),
        },
        {
            id: 'remove',
            header: '',
            align: 'end',
            exportValue: () => '',
            cell: (row) =>
                // A system mode is refused server-side; offering the button would only teach the
                // operator that the screen lies.
                row.is_system ? null : (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => router.delete(routes.presets.destroy(row.id), { preserveScroll: true })}
                    >
                        {t('action.delete')}
                    </Button>
                ),
        },
    ];

    return (
        <AppLayout title={t('preset.title')} description={t('preset.hint')}>
            <Head title={t('preset.title')} />

            <AddPreset pricelists={pricelists} fiscalPositions={fiscalPositions} />

            <DataTable
                columns={columns}
                rows={presets}
                getRowId={(row) => row.id}
                storageKey="presets"
                caption={t('preset.title')}
                search={{ value: search, onChange: setSearch }}
                exportFilename="modes-de-service"
                onRowHref={(row) => routes.presets.edit(row.id)}
                rowClassName={(row) => (row.active ? undefined : 'opacity-60')}
            />
        </AppLayout>
    );
}

/**
 * Creating a service mode.
 *
 * The price list and the fiscal position are offered here rather than left to the edit screen
 * because they are the reason a venue adds a mode at all: takeaway exists to charge a different VAT
 * rate, delivery to charge a different price. A mode created without them is a mode that has to be
 * edited immediately.
 */
function AddPreset({
    pricelists,
    fiscalPositions,
}: {
    pricelists: NamedRow[];
    fiscalPositions: NamedRow[];
}): JSX.Element {
    const t = useT();
    const [open, setOpen] = useState(false);

    const form = useForm<{
        name: string;
        service_at: string;
        pricelist_id: string;
        fiscal_position_id: string;
    }>({
        name: '',
        service_at: 'counter',
        pricelist_id: '',
        fiscal_position_id: '',
    });

    if (!open) {
        return (
            <Button variant="ghost" onClick={() => setOpen(true)}>
                {t('preset.add')}
            </Button>
        );
    }

    const optional = (rows: NamedRow[]): { value: string; label: string }[] => [
        { value: '', label: t('preset.none') },
        ...rows.map((row) => ({ value: String(row.id), label: row.name })),
    ];

    return (
        <Card>
            <CardHeader title={t('preset.add')} description={t('preset.addHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('preset.name')}
                        value={form.data.name}
                        error={form.errors.name}
                        required
                        onChange={(value) => form.setData('name', value)}
                    />
                    <SelectField
                        label={t('preset.serviceAt')}
                        value={form.data.service_at}
                        error={form.errors.service_at}
                        options={[
                            { value: 'counter', label: t('preset.serviceAt.counter') },
                            { value: 'table', label: t('preset.serviceAt.table') },
                            { value: 'delivery', label: t('preset.serviceAt.delivery') },
                        ]}
                        onChange={(value) => form.setData('service_at', value)}
                    />
                    <SelectField
                        label={t('preset.pricelist')}
                        value={form.data.pricelist_id}
                        error={form.errors.pricelist_id}
                        options={optional(pricelists)}
                        onChange={(value) => form.setData('pricelist_id', value)}
                    />
                    <SelectField
                        label={t('preset.fiscalPosition')}
                        value={form.data.fiscal_position_id}
                        error={form.errors.fiscal_position_id}
                        options={optional(fiscalPositions)}
                        onChange={(value) => form.setData('fiscal_position_id', value)}
                    />
                </FormSection>

                <div className="flex gap-2">
                    <Button
                        loading={form.processing}
                        onClick={() => {
                            // An empty select means "none", and the column is nullable. Posting an
                            // empty string would fail the integer rule on a field the operator left
                            // deliberately blank.
                            form.transform((data) => ({
                                ...data,
                                pricelist_id: data.pricelist_id === '' ? null : Number(data.pricelist_id),
                                fiscal_position_id:
                                    data.fiscal_position_id === '' ? null : Number(data.fiscal_position_id),
                            }));
                            form.post(routes.presets.store(), { onSuccess: () => setOpen(false) });
                        }}
                    >
                        {t('action.save')}
                    </Button>
                    <Button variant="ghost" onClick={() => setOpen(false)}>
                        {t('action.cancel')}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
