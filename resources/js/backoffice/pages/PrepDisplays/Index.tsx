/**
 * `PrepDisplays/Index` — `GET /prep-displays` (KDS-003).
 *
 * A short list, so it is a plain client-side table: the whole collection arrives in one prop and
 * paginating four kitchen screens would be theatre.
 *
 * The two timing columns are shown side by side on purpose. `average_prep_minutes` is the promise
 * the display makes to the floor and `late_threshold_minutes` is when it starts shouting; a
 * threshold below the average means every ticket is late from the moment it is fired, which is a
 * configuration mistake that looks like a broken screen. It is flagged here rather than
 * discovered at service.
 */

import { Head, Link } from '@inertiajs/react';
import { FOCUS_RING, cn } from '@shared/ui';
import { useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, BoolCell, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { duration } from '../../lib/format';
import { routes } from '../../lib/routes';

import { LAYOUT_LABEL, type PrepDisplayListRow, type PrepDisplaysIndexProps } from './types';

export default function PrepDisplaysIndex({ displays }: PrepDisplaysIndexProps): JSX.Element {
    const t = useT();
    const [search, setSearch] = useState('');

    const columns: Column<PrepDisplayListRow>[] = [
        {
            id: 'name',
            header: t('display.title'),
            locked: true,
            cell: (row) => (
                <Link
                    href={routes.prepDisplays.edit(row.uuid)}
                    className={cn('rounded-pos font-medium text-brand-700 hover:underline', FOCUS_RING)}
                >
                    {row.name}
                </Link>
            ),
            sortValue: (row) => row.name,
            searchValue: (row) => row.name,
            exportValue: (row) => row.name,
        },
        {
            id: 'layout',
            header: t('display.layout'),
            cell: (row) => <Badge tone="brand">{LAYOUT_LABEL[row.layout] ?? row.layout}</Badge>,
            sortValue: (row) => row.layout,
            exportValue: (row) => row.layout,
        },
        {
            id: 'average_prep_minutes',
            header: t('display.avgPrep'),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{duration(row.average_prep_minutes)}</span>,
            sortValue: (row) => row.average_prep_minutes,
            exportValue: (row) => row.average_prep_minutes,
        },
        {
            id: 'late_threshold_minutes',
            header: t('display.late'),
            align: 'end',
            cell: (row) => (
                <span className="flex flex-col items-end">
                    <span className="tabular-nums">{duration(row.late_threshold_minutes)}</span>
                    {row.late_threshold_minutes < row.average_prep_minutes ? (
                        <Badge tone="danger">{t('display.thresholdBelowAverage')}</Badge>
                    ) : null}
                </span>
            ),
            sortValue: (row) => row.late_threshold_minutes,
            exportValue: (row) => row.late_threshold_minutes,
        },
        {
            id: 'done_retention_minutes',
            header: t('display.retention'),
            align: 'end',
            defaultHidden: true,
            cell: (row) => <span className="tabular-nums">{duration(row.done_retention_minutes)}</span>,
            sortValue: (row) => row.done_retention_minutes,
            exportValue: (row) => row.done_retention_minutes,
        },
        {
            id: 'show_all_categories',
            header: t('display.allCategories'),
            align: 'center',
            cell: (row) => <BoolCell value={row.show_all_categories} labels={[t('state.yes'), t('state.no')]} />,
            sortValue: (row) => row.show_all_categories,
            exportValue: (row) => (row.show_all_categories ? '1' : '0'),
        },
        {
            id: 'sound_on_new_order',
            header: t('display.sound'),
            align: 'center',
            defaultHidden: true,
            cell: (row) => <BoolCell value={row.sound_on_new_order} labels={[t('state.yes'), t('state.no')]} />,
            sortValue: (row) => row.sound_on_new_order,
            exportValue: (row) => (row.sound_on_new_order ? '1' : '0'),
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
                    href={routes.prepDisplays.edit(row.uuid)}
                    className={cn('rounded-pos px-2 py-1 text-sm text-brand-700 hover:underline', FOCUS_RING)}
                >
                    {t('action.edit')}
                </Link>
            ),
        },
    ];

    return (
        <AppLayout title={t('display.title')}>
            <Head title={t('display.title')} />

            <div className="space-y-6">
                <DataTable
                    columns={columns}
                    rows={displays}
                    getRowId={(row) => row.id}
                    storageKey="prep-displays"
                    caption={t('display.title')}
                    search={{ value: search, onChange: setSearch }}
                    exportFilename="ecrans-cuisine"
                    perPage={50}
                    emptyTitle={t('state.empty')}
                    emptyHint={t('display.createMissing')}
                    onRowHref={(row) => routes.prepDisplays.edit(row.uuid)}
                />

                <Notice tone="info" title={t('display.createMissingTitle')}>
                    {t('display.createMissing')}
                </Notice>
            </div>
        </AppLayout>
    );
}
