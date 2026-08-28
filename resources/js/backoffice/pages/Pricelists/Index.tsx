/**
 * `Pricelists/Index` — `GET /pricelists` (BOF-090).
 */

import { Head, Link, router, useForm } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { FormSection, SelectField, TextField } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, Card, CardBody, CardHeader } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { integer } from '../../lib/format';
import { routes } from '../../lib/routes';

import type { PricelistListRow, PricelistsIndexProps } from './types';

export default function PricelistsIndex({ pricelists, currencies }: PricelistsIndexProps): JSX.Element {
    const t = useT();
    const [search, setSearch] = useState('');

    const columns: Column<PricelistListRow>[] = [
        {
            id: 'name',
            header: t('nav.pricelists'),
            locked: true,
            cell: (row) => row.name,
            sortValue: (row) => row.name,
            searchValue: (row) => row.name,
            exportValue: (row) => row.name,
        },
        {
            id: 'sequence',
            header: t('category.sequence'),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{row.sequence}</span>,
            sortValue: (row) => row.sequence,
            exportValue: (row) => row.sequence,
        },
        {
            id: 'item_count',
            header: t('pricelist.items', { count: '' }).trim(),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{integer(row.item_count)}</span>,
            sortValue: (row) => row.item_count,
            exportValue: (row) => row.item_count,
        },
        {
            id: 'currency_id',
            header: 'Devise',
            align: 'end',
            defaultHidden: true,
            cell: (row) => <span className="tabular-nums">{row.currency_id}</span>,
            sortValue: (row) => row.currency_id,
            exportValue: (row) => row.currency_id,
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
                <Link
                    href={routes.pricelists.edit(row.id)}
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
            cell: (row) => (
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => router.delete(routes.pricelists.destroy(row.id), { preserveScroll: true })}
                >
                    {t('action.delete')}
                </Button>
            ),
        },
    ];

    return (
        <AppLayout title={t('pricelist.title')} description={t('pricelist.precedenceHint')}>
            <Head title={t('pricelist.title')} />

            {/* A price list could be edited but never created — BAN-401. */}
            <AddPricelist currencies={currencies} />

            <DataTable
                columns={columns}
                rows={pricelists}
                getRowId={(row) => row.id}
                storageKey="pricelists"
                caption={t('pricelist.title')}
                search={{ value: search, onChange: setSearch }}
                exportFilename="listes-de-prix"
                onRowHref={(row) => routes.pricelists.edit(row.id)}
            />
        </AppLayout>
    );
}

/** Creating a price list: a name and the currency it prices in. Its rules are added on its own page. */
function AddPricelist({ currencies }: { currencies: PricelistsIndexProps['currencies'] }): JSX.Element {
    const t = useT();
    const [open, setOpen] = useState(false);

    const form = useForm<{ name: string; currency_id: string }>({
        name: '',
        currency_id: currencies[0] === undefined ? '' : String(currencies[0].id),
    });

    if (!open) {
        return (
            <Button variant="ghost" onClick={() => setOpen(true)}>
                {t('pricelist.add')}
            </Button>
        );
    }

    return (
        <Card>
            <CardHeader title={t('pricelist.add')} description={t('pricelist.addHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('pricelist.name')}
                        value={form.data.name}
                        error={form.errors.name}
                        required
                        onChange={(value) => form.setData('name', value)}
                    />
                    <SelectField
                        label={t('pricelist.currency')}
                        value={form.data.currency_id}
                        error={form.errors.currency_id}
                        options={currencies.map((c) => ({ value: String(c.id), label: `${c.name} (${c.code})` }))}
                        onChange={(value) => form.setData('currency_id', value)}
                    />
                </FormSection>

                <div className="flex gap-2">
                    <Button
                        loading={form.processing}
                        onClick={() => form.post(routes.pricelists.store(), { onSuccess: () => setOpen(false) })}
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
