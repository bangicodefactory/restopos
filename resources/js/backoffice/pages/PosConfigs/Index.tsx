/**
 * `PosConfigs/Index` — `GET /pos-configs` (BOF-006, BOF-008).
 *
 * The list is the hub for everything that is configured *per register*: settings, self-order,
 * the register shell itself. `config_revision` is surfaced as a column because it is the number
 * support asks for first — "did the till get your change?" is answered by comparing it.
 */

import { Head, Link } from '@inertiajs/react';
import { FOCUS_RING, cn } from '@shared/ui';
import { useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, BoolCell } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import type { PosConfigListRow, PosConfigsIndexProps } from './types';

export default function PosConfigsIndex({ configs }: PosConfigsIndexProps): JSX.Element {
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
                        href={routes.posConfigs.edit(row.id)}
                        className={cn('rounded-pos px-2 py-1 text-sm text-brand-700 hover:underline', FOCUS_RING)}
                    >
                        {t('nav.settings')}
                    </Link>
                    <Link
                        href={routes.selfOrder.settings(row.id)}
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
                </div>
            ),
        },
    ];

    return (
        <AppLayout title={t('config.title')} description={t('config.revisionHint')}>
            <Head title={t('config.title')} />

            <DataTable
                columns={columns}
                rows={configs}
                getRowId={(row) => row.id}
                storageKey="pos-configs"
                caption={t('config.title')}
                search={{ value: search, onChange: setSearch }}
                exportFilename="points-de-vente"
                onRowHref={(row) => routes.posConfigs.edit(row.id)}
                perPage={25}
            />
        </AppLayout>
    );
}
