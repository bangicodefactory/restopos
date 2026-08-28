/**
 * `Presets/Edit` — `GET /presets/{preset}/edit` (BOF-113, BAN-429).
 *
 * Two halves. The top is what the mode *is*: its price list, its fiscal position, what the customer
 * must give, whether the self-order surface offers it. The bottom is *when it takes orders* — hours
 * per day, and how many bookings fit in an interval.
 *
 * The hours are not decoration. Once booking is on they are the hours a booking is accepted at all,
 * and a mode with the wrong hours closes a delivery service without saying so.
 */

import { Head, router, useForm } from '@inertiajs/react';
import { Button } from '@shared/ui';
import { useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { NumberField, SaveBar, TextField, ToggleField, useDirtyGuard } from '../../components/form';
import { FormSection, SelectField } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, Card, CardBody, CardHeader, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import {
    clockToHour,
    hourToClock,
    type NamedRow,
    type PresetEditProps,
    type ServiceWindowRecord,
} from './types';

/**
 * The seven day keys, spelled out.
 *
 * A `t()` key is a closed union, so a template literal cannot address one — and that is the point:
 * it is what stops a missing translation reaching a screen.
 */
const DAY_LABEL = ['day.0', 'day.1', 'day.2', 'day.3', 'day.4', 'day.5', 'day.6'] as const;

const PERIOD_LABEL = {
    morning: 'period.morning',
    afternoon: 'period.afternoon',
    evening: 'period.evening',
} as const;

export default function PresetEdit({ preset, windows, pricelists, fiscalPositions }: PresetEditProps): JSX.Element {
    const t = useT();

    const form = useForm<{
        name: string;
        service_at: string;
        identification: string;
        pricelist_id: string;
        fiscal_position_id: string;
        use_guest: boolean;
        available_in_self: boolean;
        use_timing: boolean;
        slots_per_interval: number | null;
        interval_minutes: number | null;
        sequence: number | null;
        active: boolean;
    }>({
        name: preset.name,
        service_at: preset.service_at,
        identification: preset.identification,
        pricelist_id: preset.pricelist_id === null ? '' : String(preset.pricelist_id),
        fiscal_position_id: preset.fiscal_position_id === null ? '' : String(preset.fiscal_position_id),
        use_guest: preset.use_guest,
        available_in_self: preset.available_in_self,
        use_timing: preset.use_timing,
        slots_per_interval: preset.slots_per_interval,
        interval_minutes: preset.interval_minutes,
        sequence: preset.sequence,
        active: preset.active,
    });

    useDirtyGuard(form.isDirty, t('confirm.leave'));

    const optional = (rows: NamedRow[]): { value: string; label: string }[] => [
        { value: '', label: t('preset.none') },
        ...rows.map((row) => ({ value: String(row.id), label: row.name })),
    ];

    const columns: Column<ServiceWindowRecord>[] = [
        {
            id: 'day',
            header: t('preset.day'),
            locked: true,
            cell: (row) => t(DAY_LABEL[row.day_of_week] ?? 'day.0'),
            sortValue: (row) => row.day_of_week,
            exportValue: (row) => t(DAY_LABEL[row.day_of_week] ?? 'day.0'),
        },
        {
            id: 'hours',
            header: t('preset.openHours'),
            cell: (row) => (
                <span className="tabular-nums">
                    {hourToClock(row.hour_from)} — {hourToClock(row.hour_to)}
                </span>
            ),
            sortValue: (row) => Number(row.hour_from),
            exportValue: (row) => `${hourToClock(row.hour_from)}–${hourToClock(row.hour_to)}`,
        },
        {
            id: 'day_period',
            header: t('preset.period'),
            defaultHidden: true,
            cell: (row) => (row.day_period === null ? null : <Badge tone="neutral">{t(PERIOD_LABEL[row.day_period])}</Badge>),
            sortValue: (row) => row.day_period ?? '',
            exportValue: (row) => row.day_period ?? '',
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
                    onClick={() =>
                        router.delete(routes.serviceWindows.destroy(preset.id, row.id), { preserveScroll: true })
                    }
                >
                    {t('action.delete')}
                </Button>
            ),
        },
    ];

    return (
        <AppLayout title={preset.name} description={t('preset.hint')}>
            <Head title={preset.name} />

            <div className="space-y-6">
                <Card>
                    <CardHeader title={t('preset.settings')} />
                    <CardBody className="space-y-4">
                        {preset.is_system ? <Notice tone="info">{t('preset.systemHint')}</Notice> : null}

                        <FormSection>
                            <TextField
                                label={t('preset.name')}
                                value={form.data.name}
                                error={form.errors.name}
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
                                label={t('preset.identification')}
                                hint={t('preset.identificationHint')}
                                value={form.data.identification}
                                error={form.errors.identification}
                                options={[
                                    { value: 'none', label: t('preset.identification.none') },
                                    { value: 'name', label: t('preset.identification.name') },
                                    { value: 'address', label: t('preset.identification.address') },
                                ]}
                                onChange={(value) => form.setData('identification', value)}
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
                                hint={t('preset.fiscalPositionHint')}
                                value={form.data.fiscal_position_id}
                                error={form.errors.fiscal_position_id}
                                options={optional(fiscalPositions)}
                                onChange={(value) => form.setData('fiscal_position_id', value)}
                            />
                            <NumberField
                                label={t('category.sequence')}
                                value={form.data.sequence}
                                error={form.errors.sequence}
                                min={0}
                                onChange={(value) => form.setData('sequence', value)}
                            />
                            <ToggleField
                                label={t('preset.useGuest')}
                                checked={form.data.use_guest}
                                onChange={(checked) => form.setData('use_guest', checked)}
                            />
                            <ToggleField
                                label={t('preset.inSelfOrder')}
                                checked={form.data.available_in_self}
                                onChange={(checked) => form.setData('available_in_self', checked)}
                            />
                            <ToggleField
                                label={t('state.active')}
                                checked={form.data.active}
                                error={form.errors.active}
                                onChange={(checked) => form.setData('active', checked)}
                            />
                        </FormSection>

                        <FormSection title={t('preset.timing')} description={t('preset.timingHint')}>
                            <ToggleField
                                label={t('preset.useTiming')}
                                checked={form.data.use_timing}
                                onChange={(checked) => form.setData('use_timing', checked)}
                            />
                            {form.data.use_timing ? (
                                <>
                                    <NumberField
                                        label={t('preset.slots')}
                                        value={form.data.slots_per_interval}
                                        error={form.errors.slots_per_interval}
                                        min={1}
                                        onChange={(value) => form.setData('slots_per_interval', value)}
                                    />
                                    <NumberField
                                        label={t('preset.interval')}
                                        value={form.data.interval_minutes}
                                        error={form.errors.interval_minutes}
                                        min={1}
                                        onChange={(value) => form.setData('interval_minutes', value)}
                                    />
                                </>
                            ) : null}
                        </FormSection>

                        <SaveBar
                            dirty={form.isDirty}
                            processing={form.processing}
                            errorCount={Object.keys(form.errors).length}
                            onSave={() => {
                                form.transform((data) => ({
                                    ...data,
                                    pricelist_id: data.pricelist_id === '' ? null : Number(data.pricelist_id),
                                    fiscal_position_id:
                                        data.fiscal_position_id === '' ? null : Number(data.fiscal_position_id),
                                }));
                                form.patch(routes.presets.update(preset.id), { preserveScroll: true });
                            }}
                            onCancel={() => form.reset()}
                        />
                    </CardBody>
                </Card>

                <div className="space-y-3">
                    {form.data.use_timing && windows.length === 0 ? (
                        <Notice tone="warn">{t('preset.noHoursYet')}</Notice>
                    ) : null}

                    <AddWindow presetId={preset.id} />

                    <DataTable
                        columns={columns}
                        rows={windows}
                        getRowId={(row) => row.id}
                        storageKey="preset-windows"
                        caption={t('preset.openHours')}
                        exportFilename={`horaires-${preset.name}`}
                    />
                </div>
            </div>
        </AppLayout>
    );
}

/** One opening window. Clock times in the form; a fraction of an hour on the wire. */
function AddWindow({ presetId }: { presetId: number }): JSX.Element {
    const t = useT();
    const [open, setOpen] = useState(false);

    // Keyed by the names that are posted, so the server's errors land on the fields that caused them.
    const form = useForm<{ day_of_week: string; hour_from: string; hour_to: string }>({
        day_of_week: '0',
        hour_from: '11:00',
        hour_to: '14:00',
    });

    if (!open) {
        return (
            <Button variant="ghost" onClick={() => setOpen(true)}>
                {t('preset.addHours')}
            </Button>
        );
    }

    return (
        <Card>
            <CardHeader title={t('preset.addHours')} description={t('preset.addHoursHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <SelectField
                        label={t('preset.day')}
                        value={form.data.day_of_week}
                        error={form.errors.day_of_week}
                        options={DAY_LABEL.map((key, day) => ({ value: String(day), label: t(key) }))}
                        onChange={(value) => form.setData('day_of_week', value)}
                    />
                    <TextField
                        label={t('preset.from')}
                        value={form.data.hour_from}
                        error={form.errors.hour_from}
                        placeholder="11:00"
                        onChange={(value) => form.setData('hour_from', value)}
                    />
                    <TextField
                        label={t('preset.until')}
                        value={form.data.hour_to}
                        error={form.errors.hour_to}
                        placeholder="14:00"
                        onChange={(value) => form.setData('hour_to', value)}
                    />
                </FormSection>

                <div className="flex gap-2">
                    <Button
                        loading={form.processing}
                        onClick={() => {
                            form.transform((data) => ({
                                day_of_week: Number(data.day_of_week),
                                // `null` for an unparseable time rather than a silent 0: 0 is
                                // midnight, which the server accepts, so a typo would save a window
                                // opening at midnight instead of showing an error.
                                hour_from: clockToHour(data.hour_from),
                                hour_to: clockToHour(data.hour_to),
                            }));
                            form.post(routes.serviceWindows.store(presetId), {
                                preserveScroll: true,
                                onSuccess: () => setOpen(false),
                            });
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
