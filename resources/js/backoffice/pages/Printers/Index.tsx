/**
 * `Printers/Index` — `GET /printers` (KDS-050, KDS-063).
 *
 * Preparation printers, their category routing, and the live print queue.
 *
 * **Routing is the part that goes wrong.** A ticket reaches a printer when the line's *frozen*
 * POS category is in that printer's routing set — or when `print_all_categories` is on, which
 * overrides the set entirely. The multi-select is therefore disabled, not hidden, while
 * "toutes les catégories" is on: hiding it is how someone spends an afternoon wondering where
 * their category list went.
 *
 * **The test action queues a real job.** `POST /printers/{printer}/test` inserts into
 * `preparation_print_jobs` and the printer agent picks it up on its next poll; the only
 * meaningful test of a kitchen printer is a piece of paper coming out of it. It needs a
 * `pos_config_id`, and the contract sends no config list to this page, so the field is a numeric
 * id with the reason stated.
 *
 * The connection kind is editable (BAN-432): changing it re-marks which address fields are
 * required, because an IoT box and a network printer are reached in different ways.
 */

import { Head, router, useForm } from '@inertiajs/react';
import { Button, FOCUS_RING, cn, useToast } from '@shared/ui';
import { useCallback, useMemo, useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import {
    MultiSelectField,
    NumberField,
    SaveBar,
    SelectField,
    TextField,
    ToggleField,
    useDirtyGuard,
} from '../../components/form';
import { FormSection } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { ConfirmAction } from '../../components/ui/ConfirmAction';
import { DeleteAction } from '../../components/ui/DeleteAction';
import {
    Badge,
    BoolCell,
    Card,
    CardBody,
    CardHeader,
    DeferredRegion,
    EmptyState,
} from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { dateTime } from '../../lib/format';
import { routes } from '../../lib/routes';

import {
    CONNECTION_FIELDS,
    JOB_STATE_TONE,
    PRINTER_TYPE_LABEL,
    categoryOptions,
    toForm,
    type PrintJobRow,
    type PrinterCategory,
    type PrinterRow,
    type PrintersIndexProps,
} from './types';

export default function PrintersIndex({ printers, categories, queue }: PrintersIndexProps): JSX.Element {
    const t = useT();
    const [search, setSearch] = useState('');
    const [selectedId, setSelectedId] = useState<number | null>(printers[0]?.id ?? null);

    const selected = printers.find((printer) => printer.id === selectedId) ?? null;
    const categoryName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

    const columns: Column<PrinterRow>[] = [
        {
            id: 'name',
            header: t('printer.title'),
            locked: true,
            cell: (row) => (
                <button
                    type="button"
                    onClick={() => setSelectedId(row.id)}
                    aria-pressed={row.id === selectedId}
                    className="text-start font-medium text-brand-700 hover:underline"
                >
                    {row.name}
                </button>
            ),
            sortValue: (row) => row.name,
            searchValue: (row) => row.name,
            exportValue: (row) => row.name,
        },
        {
            id: 'printer_type',
            header: t('printer.connection'),
            cell: (row) => (
                <span className="flex flex-col">
                    <Badge tone="brand">{PRINTER_TYPE_LABEL[row.printer_type] ?? row.printer_type}</Badge>
                    <span className="pt-0.5 font-mono text-xs text-slate-500">{address(row)}</span>
                </span>
            ),
            sortValue: (row) => row.printer_type,
            searchValue: (row) => `${row.printer_type} ${address(row)}`,
            exportValue: (row) => `${row.printer_type} ${address(row)}`,
        },
        {
            id: 'routing',
            header: t('printer.routing'),
            cell: (row) =>
                row.print_all_categories ? (
                    <Badge tone="info">{t('printer.allCategories')}</Badge>
                ) : row.category_ids.length === 0 ? (
                    <Badge tone="warn">{t('printer.noRouting')}</Badge>
                ) : (
                    <span className="flex flex-wrap gap-1">
                        {row.category_ids.slice(0, 4).map((id) => (
                            <Badge key={id}>{categoryName.get(id) ?? `#${id}`}</Badge>
                        ))}
                        {row.category_ids.length > 4 ? <Badge>+{row.category_ids.length - 4}</Badge> : null}
                    </span>
                ),
            searchValue: (row) => row.category_ids.map((id) => categoryName.get(id) ?? '').join(' '),
            exportValue: (row) =>
                row.print_all_categories
                    ? '*'
                    : row.category_ids.map((id) => categoryName.get(id) ?? `#${id}`).join(' / '),
        },
        {
            id: 'is_receipt_printer',
            header: t('printer.receipt'),
            align: 'center',
            cell: (row) => <BoolCell value={row.is_receipt_printer} labels={[t('state.yes'), t('state.no')]} />,
            sortValue: (row) => row.is_receipt_printer,
            exportValue: (row) => (row.is_receipt_printer ? '1' : '0'),
        },
        {
            id: 'characters_per_line',
            header: t('printer.charsPerLine'),
            align: 'end',
            defaultHidden: true,
            cell: (row) => <span className="tabular-nums">{row.characters_per_line}</span>,
            sortValue: (row) => row.characters_per_line,
            exportValue: (row) => row.characters_per_line,
        },
        {
            id: 'copies',
            header: t('printer.copies'),
            align: 'end',
            defaultHidden: true,
            cell: (row) => <span className="tabular-nums">{row.copies}</span>,
            sortValue: (row) => row.copies,
            exportValue: (row) => row.copies,
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
    ];

    return (
        <AppLayout title={t('printer.title')} description={t('printer.testHint')}>
            <Head title={t('printer.title')} />

            <div className="space-y-6">
                <DataTable
                    columns={columns}
                    rows={printers}
                    getRowId={(row) => row.id}
                    storageKey="printers"
                    caption={t('printer.title')}
                    search={{ value: search, onChange: setSearch }}
                    exportFilename="imprimantes"
                    perPage={50}
                    emptyTitle={t('state.empty')}
                    emptyHint={t('printer.createMissing')}
                    rowClassName={(row) => (row.id === selectedId ? 'bg-brand-50' : undefined)}
                />

                {selected === null ? null : (
                    <PrinterEditor key={selected.id} printer={selected} categories={categories} />
                )}

                <PrintQueue queue={queue} printers={printers} />

                <AddPrinter />
            </div>
        </AppLayout>
    );
}

function address(printer: PrinterRow): string {
    if (printer.printer_ip) return `${printer.printer_ip}${printer.printer_port ? `:${printer.printer_port}` : ''}`;
    if (printer.proxy_ip) return printer.proxy_ip;
    return '—';
}

// ───────────────────────────────────────────────────────────── editor

function PrinterEditor({
    printer,
    categories,
}: {
    printer: PrinterRow;
    categories: PrinterCategory[];
}): JSX.Element {
    const t = useT();
    const form = useForm(toForm(printer));
    const fields = CONNECTION_FIELDS[printer.printer_type] ?? { proxy: true, ip: true, port: true };
    const options = useMemo(() => categoryOptions(categories), [categories]);

    useDirtyGuard(form.isDirty, t('confirm.leave'));

    return (
        <Card>
            <CardHeader
                title={printer.name}
                description={PRINTER_TYPE_LABEL[printer.printer_type] ?? printer.printer_type}
                actions={
                    <span className="flex items-center gap-2">
                        <TestTicket printerId={printer.id} printerName={printer.name} />
                        {/*
                          * The server refuses while print jobs are still queued for this printer and
                          * says how many — those tickets would otherwise be deleted with it, and the
                          * order each came from still says the kitchen was told.
                          */}
                        <DeleteAction
                            size="md"
                            label={t('printer.remove')}
                            url={routes.printers.destroy(printer.id)}
                            name={printer.name}
                        />
                    </span>
                }
            />
            <CardBody>
                <FormSection title={t('printer.connection')} description={t('printer.connectionHint')}>
                    <TextField
                        label="Nom"
                        required
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                        maxLength={64}
                    />
                    <SelectField
                        label={t('printer.connection')}
                        value={form.data.printer_type}
                        error={form.errors.printer_type}
                        onChange={(value) => form.setData('printer_type', value)}
                        options={Object.entries(PRINTER_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
                    />
                    <TextField
                        label={t('printer.proxyIp')}
                        value={form.data.proxy_ip}
                        error={form.errors.proxy_ip}
                        onChange={(value) => form.setData('proxy_ip', value)}
                        required={fields.proxy}
                        disabled={!fields.proxy}
                        lockedReason={fields.proxy ? undefined : t('printer.notForType')}
                        placeholder="192.168.1.40"
                    />
                    <TextField
                        label={t('printer.printerIp')}
                        value={form.data.printer_ip}
                        error={form.errors.printer_ip}
                        onChange={(value) => form.setData('printer_ip', value)}
                        required={fields.ip}
                        disabled={!fields.ip}
                        lockedReason={fields.ip ? undefined : t('printer.notForType')}
                        placeholder="192.168.1.87"
                    />
                    <NumberField
                        label={t('printer.printerPort')}
                        value={form.data.printer_port}
                        error={form.errors.printer_port}
                        onChange={(value) => form.setData('printer_port', value)}
                        min={1}
                        max={65_535}
                        disabled={!fields.port}
                        lockedReason={fields.port ? undefined : t('printer.notForType')}
                    />
                </FormSection>

                <FormSection title={t('config.group.receipts')}>
                    <NumberField
                        label={t('printer.charsPerLine')}
                        value={form.data.characters_per_line}
                        error={form.errors.characters_per_line}
                        onChange={(value) => form.setData('characters_per_line', value)}
                        min={24}
                        max={96}
                        suffix="car."
                        hint={t('printer.charsHint')}
                    />
                    <NumberField
                        label={t('printer.copies')}
                        value={form.data.copies}
                        error={form.errors.copies}
                        onChange={(value) => form.setData('copies', value)}
                        min={1}
                        max={5}
                    />
                    <ToggleField
                        label={t('printer.receipt')}
                        checked={form.data.is_receipt_printer}
                        onChange={(checked) => form.setData('is_receipt_printer', checked)}
                        description={t('printer.receiptHint')}
                    />
                    <ToggleField
                        label={t('state.active')}
                        checked={form.data.active}
                        onChange={(checked) => form.setData('active', checked)}
                    />
                </FormSection>

                <FormSection title={t('printer.routing')} columns={1}>
                    <ToggleField
                        label={t('printer.allCategories')}
                        checked={form.data.print_all_categories}
                        onChange={(checked) => form.setData('print_all_categories', checked)}
                        description={t('printer.allCategoriesHint')}
                    />
                    <MultiSelectField
                        label={t('product.categories')}
                        values={form.data.category_ids}
                        onChange={(values) => form.setData('category_ids', values)}
                        options={options}
                        disabled={form.data.print_all_categories}
                        lockedReason={
                            form.data.print_all_categories ? t('printer.allCategoriesLock') : undefined
                        }
                        hint={t('printer.routingHint')}
                    />
                </FormSection>

                <SaveBar
                    dirty={form.isDirty}
                    processing={form.processing}
                    errorCount={Object.keys(form.errors).length}
                    onSave={() => form.patch(routes.printers.update(printer.id), { preserveScroll: true })}
                    onCancel={() => form.reset()}
                />
            </CardBody>
        </Card>
    );
}

// ───────────────────────────────────────────────────────────── test ticket

function TestTicket({ printerId, printerName }: { printerId: number; printerName: string }): JSX.Element {
    const t = useT();
    const toast = useToast();
    const [configId, setConfigId] = useState('');
    const [busy, setBusy] = useState(false);

    const send = useCallback(() => {
        const parsed = Number(configId);
        if (!Number.isInteger(parsed) || parsed <= 0) {
            toast.show({ tone: 'danger', title: t('printer.testNeedsConfig') });
            return;
        }
        router.post(
            routes.printers.test(printerId),
            { pos_config_id: parsed },
            {
                preserveScroll: true,
                onStart: () => setBusy(true),
                onFinish: () => setBusy(false),
            },
        );
    }, [configId, printerId, t, toast]);

    return (
        <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600" htmlFor="printer-test-config">
                {t('report.config')}
                <input
                    id="printer-test-config"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    placeholder="id"
                    value={configId}
                    onChange={(event) => setConfigId(event.target.value)}
                    className={cn(
                        'min-h-touch w-24 rounded-pos bg-white px-3 text-sm tabular-nums ring-1 ring-inset ring-slate-300',
                        FOCUS_RING,
                    )}
                />
            </label>

            <ConfirmAction
                label={t('printer.test')}
                title={t('printer.test')}
                message={t('printer.testConfirm', { name: printerName })}
                destructive={false}
                variant="secondary"
                busy={busy}
                onConfirm={send}
            />
        </div>
    );
}

// ───────────────────────────────────────────────────────────── queue

function PrintQueue({
    queue,
    printers,
}: {
    queue: PrintersIndexProps['queue'];
    printers: PrinterRow[];
}): JSX.Element {
    const t = useT();
    const names = useMemo(() => new Map(printers.map((printer) => [printer.id, printer.name])), [printers]);

    return (
        <Card>
            <CardHeader
                title={t('printer.queue')}
                description={t('printer.queueHint')}
                actions={
                    <Button
                        variant="secondary"
                        size="md"
                        onClick={() => router.reload({ only: ['queue'] })}
                    >
                        {t('action.refresh')}
                    </Button>
                }
            />
            <CardBody className="p-0">
                <DeferredRegion value={queue} label={t('printer.queue')} rows={3}>
                    {(rows: PrintJobRow[]) =>
                        rows.length === 0 ? (
                            <EmptyState title={t('printer.queueEmpty')} />
                        ) : (
                            <table className="w-full border-collapse text-sm">
                                <caption className="sr-only">{t('printer.queue')}</caption>
                                <thead className="bg-slate-50">
                                    <tr>
                                        <th scope="col" className="px-4 py-2 text-start text-xs uppercase text-slate-600">
                                            {t('printer.title')}
                                        </th>
                                        <th scope="col" className="px-4 py-2 text-start text-xs uppercase text-slate-600">
                                            {t('device.type')}
                                        </th>
                                        <th scope="col" className="px-4 py-2 text-start text-xs uppercase text-slate-600">
                                            {t('order.filterState')}
                                        </th>
                                        <th scope="col" className="px-4 py-2 text-end text-xs uppercase text-slate-600">
                                            {t('printer.attempts')}
                                        </th>
                                        <th scope="col" className="px-4 py-2 text-start text-xs uppercase text-slate-600">
                                            {t('report.period')}
                                        </th>
                                        <th scope="col" className="px-4 py-2 text-start text-xs uppercase text-slate-600">
                                            {t('printer.lastError')}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {rows.map((job) => (
                                        <tr key={job.id}>
                                            <td className="px-4 py-2">
                                                {names.get(job.pos_printer_id) ?? `#${job.pos_printer_id}`}
                                            </td>
                                            <td className="px-4 py-2 font-mono text-xs">{job.job_type}</td>
                                            <td className="px-4 py-2">
                                                <Badge tone={JOB_STATE_TONE[job.state] ?? 'neutral'}>{job.state}</Badge>
                                            </td>
                                            <td className="px-4 py-2 text-end tabular-nums">{job.attempts}</td>
                                            <td className="px-4 py-2 tabular-nums">{dateTime(job.queued_at)}</td>
                                            <td className="px-4 py-2 text-xs text-danger">{job.last_error ?? '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )
                    }
                </DeferredRegion>
            </CardBody>
        </Card>
    );
}

/**
 * Adding a preparation printer (BOF-113).
 *
 * The kind is asked for up front because it decides which connection fields even apply — a network
 * printer wants an IP, a proxy-attached one wants the proxy's address, and a USB one wants neither.
 * The rest, including which categories it prints, is on the editor once the printer exists.
 */
function AddPrinter(): JSX.Element {
    const t = useT();
    const form = useForm<{ name: string; printer_type: string }>({ name: '', printer_type: 'network' });

    return (
        <Card>
            <CardHeader title={t('printer.add')} description={t('printer.createMissing')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label="Nom"
                        required
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <SelectField
                        label={t('printer.connection')}
                        value={form.data.printer_type}
                        error={form.errors.printer_type}
                        options={Object.entries(PRINTER_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
                        onChange={(value) => form.setData('printer_type', value)}
                    />
                </FormSection>

                <Button
                    loading={form.processing}
                    disabled={form.data.name.trim() === ''}
                    onClick={() =>
                        form.post(routes.printers.store(), {
                            preserveScroll: true,
                            onSuccess: () => form.reset(),
                        })
                    }
                >
                    {t('printer.add')}
                </Button>
            </CardBody>
        </Card>
    );
}
