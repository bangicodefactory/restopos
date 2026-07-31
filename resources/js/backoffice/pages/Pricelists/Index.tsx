/**
 * `Pricelists/Index` — `GET /pricelists` (BOF-090).
 */

import { Head, Link } from '@inertiajs/react';
import { FOCUS_RING, cn } from '@shared/ui';
import { useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { integer } from '../../lib/format';
import { routes } from '../../lib/routes';

import type { PricelistListRow, PricelistsIndexProps } from './types';

export default function PricelistsIndex({ pricelists }: PricelistsIndexProps): JSX.Element {
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
    ];

    return (
        <AppLayout title={t('pricelist.title')} description={t('pricelist.precedenceHint')}>
            <Head title={t('pricelist.title')} />

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
