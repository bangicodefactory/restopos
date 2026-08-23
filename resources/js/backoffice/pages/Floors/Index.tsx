/**
 * `Floors/Index` — `GET /floors` (RST-030).
 *
 * A short list with the one number that matters — how many tables the room holds — and a colour
 * chip, because operators name floors "Salle 1" / "Salle 2" and then tell them apart by the
 * colour they gave them on the plan.
 *
 * `table_count` here is the `withCount('tables')` aggregate, not the denormalised
 * `restaurant_floors.table_count` column, so it is the truth as of this request.
 */

import { Head, Link, useForm } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { NumberField, TextField } from '../../components/form';
import { FormSection } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { DeleteAction } from '../../components/ui/DeleteAction';
import { Badge, Card, CardBody, CardHeader } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { integer } from '../../lib/format';
import { routes } from '../../lib/routes';

import type { FloorListRow, FloorsIndexProps } from './types';

export default function FloorsIndex({ floors }: FloorsIndexProps): JSX.Element {
    const t = useT();
    const [search, setSearch] = useState('');

    const columns: Column<FloorListRow>[] = [
        {
            id: 'name',
            header: t('floor.title'),
            locked: true,
            cell: (row) => (
                <span className="flex items-center gap-2">
                    <span
                        aria-hidden
                        className="h-4 w-4 shrink-0 rounded ring-1 ring-inset ring-slate-300"
                        style={{ backgroundColor: row.background_color ?? '#f8fafc' }}
                    />
                    <Link
                        href={routes.floors.edit(row.uuid)}
                        className={cn('rounded-pos font-medium text-brand-700 hover:underline', FOCUS_RING)}
                    >
                        {row.name}
                    </Link>
                </span>
            ),
            sortValue: (row) => row.name,
            searchValue: (row) => row.name,
            exportValue: (row) => row.name,
        },
        {
            id: 'table_count',
            header: t('floor.tableCount'),
            align: 'end',
            cell: (row) => (
                <span className="tabular-nums">
                    {row.table_count === 0 ? (
                        <Badge tone="warn">{t('floor.noTables')}</Badge>
                    ) : (
                        integer(row.table_count)
                    )}
                </span>
            ),
            sortValue: (row) => row.table_count,
            exportValue: (row) => row.table_count,
        },
        {
            id: 'background_color',
            header: t('floor.backgroundColor'),
            defaultHidden: true,
            cell: (row) => <span className="font-mono text-xs">{row.background_color ?? '—'}</span>,
            sortValue: (row) => row.background_color,
            exportValue: (row) => row.background_color,
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
                <span className="flex items-center justify-end gap-2">
                    <Link
                        href={routes.floors.edit(row.uuid)}
                        className={cn('rounded-pos px-2 py-1 text-sm text-brand-700 hover:underline', FOCUS_RING)}
                    >
                        {t('floor.edit')}
                    </Link>
                    {/*
                      * Refused while a table on this room is still open, and asks for confirmation
                      * when the room holds tables at all — a room is soft-deleted, so the database
                      * cascade never fires and the tables would be left pointing at nothing.
                      */}
                    <DeleteAction url={routes.floors.destroy(row.uuid)} name={row.name} />
                </span>
            ),
        },
    ];

    return (
        <AppLayout title={t('floor.title')}>
            <Head title={t('floor.title')} />

            <div className="space-y-6">
                <DataTable
                    columns={columns}
                    rows={floors}
                    getRowId={(row) => row.id}
                    storageKey="floors"
                    caption={t('floor.title')}
                    search={{ value: search, onChange: setSearch }}
                    exportFilename="salles"
                    perPage={50}
                    emptyTitle={t('state.empty')}
                    emptyHint={t('floor.createMissing')}
                    onRowHref={(row) => routes.floors.edit(row.uuid)}
                />

                <AddFloor />
            </div>
        </AppLayout>
    );
}

/**
 * Adding a dining room (RST-030).
 *
 * A name and where it sits in the room switcher; the plan itself is drawn on the room's own editor,
 * because a floor plan is a canvas and not a form field.
 */
function AddFloor(): JSX.Element {
    const t = useT();
    const form = useForm<{ name: string; sequence: number | null }>({ name: '', sequence: null });

    return (
        <Card>
            <CardHeader title={t('floor.add')} description={t('floor.createMissing')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('floor.title')}
                        required
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <NumberField
                        label={t('category.sequence')}
                        value={form.data.sequence}
                        error={form.errors.sequence}
                        onChange={(value) => form.setData('sequence', value)}
                    />
                </FormSection>

                <Button
                    loading={form.processing}
                    disabled={form.data.name.trim() === ''}
                    onClick={() =>
                        form.post(routes.floors.store(), {
                            preserveScroll: true,
                            onSuccess: () => form.reset(),
                        })
                    }
                >
                    {t('floor.add')}
                </Button>
            </CardBody>
        </Card>
    );
}
