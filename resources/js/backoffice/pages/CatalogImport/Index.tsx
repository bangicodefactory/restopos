/**
 * `CatalogImport/Index` — `GET /catalog-import` (BOF-093, BAN-491).
 *
 * Every DataTable and report in the back office exports to CSV and nothing imported, so onboarding a
 * venue with a 300-item menu meant 300 manual creations.
 *
 * The screen is two steps and the first one writes nothing: upload, read what would happen line by
 * line, then commit. The preview is not advisory — it is the same plan the commit applies, computed
 * by the same code, so a row that says "create" creates and a row that says why it failed is the
 * reason the whole file is refused.
 */

import { Head, useForm } from '@inertiajs/react';
import { Button } from '@shared/ui';
import { useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { FormSection, SelectField } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, Card, CardBody, CardHeader, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

type ImportEntity = {
    key: string;
    label: string;
    columns: string[];
    required: string[];
    keys: string[];
};

type PlannedRow = {
    line: number;
    action: 'create' | 'update' | 'error';
    values: Record<string, unknown>;
    messages: string[];
    existing_id: number | null;
};

type ImportResult = {
    entity: string;
    committed: boolean;
    creates: number;
    updates: number;
    errors: number;
    rows: PlannedRow[];
};

type Props = {
    entities: ImportEntity[];
    maxRows: number;
    /** Flashed by the controller after a preview or a commit. */
    import?: ImportResult;
};

export default function CatalogImportIndex({ entities, maxRows, import: result }: Props): JSX.Element {
    const t = useT();
    const [entity, setEntity] = useState(entities[0]?.key ?? 'products');
    const [file, setFile] = useState<File | null>(null);

    const spec = entities.find((candidate) => candidate.key === entity);

    const form = useForm<{ entity: string; file: File | null }>({ entity, file: null });

    const submit = (url: string): void => {
        form.transform(() => ({ entity, file }));
        form.post(url, { preserveScroll: true, forceFormData: true });
    };

    const columns: Column<PlannedRow>[] = [
        {
            id: 'line',
            header: t('import.line'),
            locked: true,
            align: 'end',
            cell: (row) => <span className="tabular-nums">{row.line}</span>,
            sortValue: (row) => row.line,
            exportValue: (row) => row.line,
        },
        {
            id: 'action',
            header: t('import.outcome'),
            cell: (row) => (
                <Badge tone={row.action === 'error' ? 'danger' : row.action === 'create' ? 'ok' : 'brand'}>
                    {row.action === 'error'
                        ? t('import.rowError')
                        : row.action === 'create'
                          ? t('import.rowCreate')
                          : t('import.rowUpdate')}
                </Badge>
            ),
            sortValue: (row) => row.action,
            exportValue: (row) => row.action,
        },
        {
            id: 'name',
            header: t('import.row'),
            cell: (row) => String(row.values.name ?? row.values.default_code ?? ''),
            sortValue: (row) => String(row.values.name ?? ''),
            searchValue: (row) => String(row.values.name ?? ''),
            exportValue: (row) => String(row.values.name ?? ''),
        },
        {
            id: 'messages',
            header: t('import.why'),
            cell: (row) => <span className="text-sm text-danger">{row.messages.join(' · ')}</span>,
            sortValue: (row) => row.messages.length,
            searchValue: (row) => row.messages.join(' '),
            exportValue: (row) => row.messages.join(' | '),
        },
    ];

    return (
        <AppLayout title={t('import.title')} description={t('import.hint')}>
            <Head title={t('import.title')} />

            <div className="space-y-4">
                <Card>
                    <CardHeader title={t('import.file')} description={t('import.fileHint', { max: String(maxRows) })} />
                    <CardBody className="space-y-4">
                        <FormSection>
                            <SelectField
                                label={t('import.what')}
                                value={entity}
                                options={entities.map((candidate) => ({
                                    value: candidate.key,
                                    label: candidate.label,
                                }))}
                                onChange={setEntity}
                            />
                        </FormSection>

                        {spec === undefined ? null : (
                            <div className="space-y-1 text-sm text-slate-600">
                                <p>
                                    {t('import.required')} <strong>{spec.required.join(', ')}</strong>
                                </p>
                                <p>
                                    {/* The key is what makes a re-import update instead of duplicate.
                                        Saying so here is the difference between one catalogue and two. */}
                                    {t('import.matchedOn')} <strong>{spec.keys.join(' → ')}</strong>
                                </p>
                                <p className="text-slate-500">
                                    {t('import.columns')} {spec.columns.join(', ')}
                                </p>
                                <a
                                    className="text-brand-700 hover:underline"
                                    href={routes.catalogImport.template(spec.key)}
                                >
                                    {t('import.template')}
                                </a>
                            </div>
                        )}

                        <input
                            type="file"
                            accept=".csv,text/csv"
                            className="block text-sm"
                            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                        />

                        {form.errors.file === undefined ? null : (
                            <Notice tone="danger">{form.errors.file}</Notice>
                        )}

                        <div className="flex gap-2">
                            <Button
                                variant="secondary"
                                disabled={file === null}
                                loading={form.processing}
                                onClick={() => submit(routes.catalogImport.preview())}
                            >
                                {t('import.preview')}
                            </Button>
                            <Button
                                // Only offered once a preview has been read and found clean. An
                                // import button that can be pressed before anyone has looked is a
                                // preview nobody reads.
                                disabled={file === null || result === undefined || result.errors > 0}
                                loading={form.processing}
                                onClick={() => submit(routes.catalogImport.store())}
                            >
                                {t('import.commit')}
                            </Button>
                        </div>
                    </CardBody>
                </Card>

                {result === undefined ? null : (
                    <Card>
                        <CardHeader
                            title={result.committed ? t('import.done') : t('import.wouldDo')}
                            description={t('import.summary', {
                                creates: String(result.creates),
                                updates: String(result.updates),
                                errors: String(result.errors),
                            })}
                        />
                        <CardBody className="space-y-3">
                            {result.errors > 0 ? <Notice tone="danger">{t('import.nothingWritten')}</Notice> : null}
                            {result.committed ? <Notice tone="ok">{t('import.written')}</Notice> : null}

                            <DataTable
                                columns={columns}
                                rows={result.rows}
                                getRowId={(row) => row.line}
                                storageKey="catalog-import"
                                caption={t('import.title')}
                                // The error report the ticket asks for: the same table, exported.
                                exportFilename={`import-${result.entity}`}
                                perPage={100}
                                rowClassName={(row) => (row.action === 'error' ? 'bg-danger/5' : undefined)}
                            />
                        </CardBody>
                    </Card>
                )}
            </div>
        </AppLayout>
    );
}
