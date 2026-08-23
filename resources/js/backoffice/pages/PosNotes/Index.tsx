/**
 * `PosNotes/Index` — `GET /pos-notes` (BOF-112).
 *
 * The one-tap notes staff pick instead of typing. Typing at a busy pass is how "no nuts" becomes
 * "no nutz" and stops matching anything the kitchen scans for, so the point of these is that the
 * wording is authored once, here, by someone not standing at a till.
 *
 * The controller and its routes shipped in #79; this page did not, so `GET /pos-notes` rendered a
 * component that did not exist and the nav entry was disabled. `ReachabilityTest` exists to stop
 * that happening again.
 */

import { Head, useForm } from '@inertiajs/react';
import { Button } from '@shared/ui';
import { useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { ColorIndexField, NumberField, SelectField, TextField } from '../../components/form';
import { FormSection } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { DeleteAction } from '../../components/ui/DeleteAction';
import { Badge, BoolCell, Card, CardBody, CardHeader } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import { NOTE_SCOPE_LABEL, type PosNoteRow, type PosNotesIndexProps } from './types';

export default function PosNotesIndex({ notes }: PosNotesIndexProps): JSX.Element {
    const t = useT();
    const [search, setSearch] = useState('');

    const columns: Column<PosNoteRow>[] = [
        {
            id: 'name',
            header: t('note.title'),
            locked: true,
            cell: (row) => <span className="font-medium">{row.name}</span>,
            sortValue: (row) => row.name,
            searchValue: (row) => row.name,
            exportValue: (row) => row.name,
        },
        {
            id: 'note_scope',
            header: t('note.scope'),
            cell: (row) => <Badge tone="brand">{NOTE_SCOPE_LABEL[row.note_scope] ?? row.note_scope}</Badge>,
            sortValue: (row) => row.note_scope,
            searchValue: (row) => NOTE_SCOPE_LABEL[row.note_scope] ?? row.note_scope,
            exportValue: (row) => row.note_scope,
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
            cell: (row) => <BoolCell value={row.active} labels={[t('state.yes'), t('state.no')]} />,
            sortValue: (row) => row.active,
            exportValue: (row) => (row.active ? '1' : '0'),
        },
        {
            id: 'actions',
            header: '',
            align: 'end',
            cell: (row) => (
                // Refused once the note is attached to an order that is still open — the kitchen has
                // been told, and removing the wording it was told in leaves the ticket unexplained.
                <DeleteAction url={routes.posNotes.destroy(row.id)} name={row.name} />
            ),
        },
    ];

    return (
        <AppLayout title={t('note.title')}>
            <Head title={t('note.title')} />

            <div className="space-y-6">
                <DataTable
                    columns={columns}
                    rows={notes}
                    getRowId={(row) => row.id}
                    storageKey="pos-notes"
                    caption={t('note.title')}
                    search={{ value: search, onChange: setSearch }}
                    exportFilename="notes-predefinies"
                    perPage={50}
                    emptyTitle={t('state.empty')}
                    emptyHint={t('note.hint')}
                />

                <AddNote />
            </div>
        </AppLayout>
    );
}

function AddNote(): JSX.Element {
    const t = useT();

    const form = useForm<{
        name: string;
        note_scope: string;
        color: number;
        sequence: number | null;
    }>({ name: '', note_scope: 'both', color: 0, sequence: null });

    return (
        <Card>
            <CardHeader title={t('note.add')} description={t('note.hint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('note.title')}
                        required
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <SelectField
                        label={t('note.scope')}
                        value={form.data.note_scope}
                        error={form.errors.note_scope}
                        options={Object.entries(NOTE_SCOPE_LABEL).map(([value, label]) => ({ value, label }))}
                        onChange={(value) => form.setData('note_scope', value)}
                    />
                    <ColorIndexField
                        label={t('employee.colour')}
                        value={form.data.color}
                        onChange={(value) => form.setData('color', value)}
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
                        form.post(routes.posNotes.store(), {
                            preserveScroll: true,
                            onSuccess: () => form.reset(),
                        })
                    }
                >
                    {t('note.add')}
                </Button>
            </CardBody>
        </Card>
    );
}
