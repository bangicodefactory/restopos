/**
 * `PrepDisplays/Edit` — `GET /prep-displays/{prepDisplay}/edit` (KDS-003, KDS-008).
 *
 * Three things: the display's options, its category routing, and its **stages**.
 *
 * Stages matter more than they look. The KDS state machine is *derived* from this ordered list,
 * not hard-coded, so their order is the order a ticket walks and their `stage_type` is what the
 * board's automatic transitions key off. That is why the editor here is explicitly ordered, with
 * move-up/move-down buttons next to the drag affordance — a keyboard user must be able to
 * reorder a state machine, not just look at it.
 *
 * **The stage list is persisted on save (BOF-116).** `PATCH /prep-displays/{prepDisplay}`
 * reconciles the submitted `stages[]`: existing stages keep their id (so in-flight tickets are not
 * orphaned) and are updated, new ones are created, dropped ones are deleted, and the payload order
 * becomes the stored `sequence` — which is what the board's next-stage behaviour follows.
 *
 * `alert_after_minutes` per stage is the per-lane escalation and is independent of the display's
 * global `late_threshold_minutes`; both are editable and the relationship between them is spelt
 * out rather than left to be inferred.
 */

import { Head, router, useForm } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { useCallback, useMemo, useState, type JSX } from 'react';

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
import { TokenField } from '../../components/ui/CopyButton';
import { Tabs, type TabItem } from '../../components/ui/Tabs';
import { Badge, Card, CardBody, CardHeader, EmptyState } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import {
    LAYOUT_LABEL,
    STAGE_TYPE_COLOR,
    STAGE_TYPE_LABEL,
    categoryOptions,
    toForm,
    type PrepDisplayEditProps,
    type PrepStageRow,
} from './types';

/** A stage as the editor holds it: server row fields plus a stable client key for new ones. */
type EditableStage = {
    key: string;
    id: number | null;
    name: string;
    stage_type: string;
    color: string | null;
    alert_after_minutes: number | null;
    is_default: boolean;
};

function toEditable(rows: readonly PrepStageRow[]): EditableStage[] {
    return [...rows]
        .sort((a, b) => a.sequence - b.sequence)
        .map((row) => ({
            key: `s${row.id}`,
            id: row.id,
            name: row.name,
            stage_type: row.stage_type,
            color: row.color,
            alert_after_minutes: row.alert_after_minutes,
            is_default: row.is_default === true || row.is_default === 1,
        }));
}

export default function PrepDisplayEdit({
    display,
    stages,
    categoryIds,
    categories,
}: PrepDisplayEditProps): JSX.Element {
    const t = useT();
    const [tab, setTab] = useState('options');
    const [editableStages, setEditableStages] = useState<EditableStage[]>(() => toEditable(stages));

    const form = useForm(toForm(display, categoryIds));
    const options = useMemo(() => categoryOptions(categories), [categories]);

    const stagesDirty = useMemo(
        () => JSON.stringify(toEditable(stages)) !== JSON.stringify(editableStages),
        [editableStages, stages],
    );

    useDirtyGuard(form.isDirty || stagesDirty, t('confirm.leave'));

    const submit = useCallback(() => {
        form.transform((data) => ({
            ...data,
            // The list order is the state machine: index → sequence, persisted server-side.
            stages: editableStages.map((stage, index) => ({
                id: stage.id,
                name: stage.name,
                stage_type: stage.stage_type,
                color: stage.color,
                alert_after_minutes: stage.alert_after_minutes,
                sequence: (index + 1) * 10,
                is_default: stage.is_default,
            })),
        }));
        form.patch(routes.prepDisplays.update(display.uuid), { preserveScroll: true });
    }, [display.uuid, editableStages, form]);

    const tabs: TabItem[] = [
        { id: 'options', label: t('config.group.general') },
        { id: 'stages', label: t('display.stages'), badge: <Badge>{editableStages.length}</Badge> },
        { id: 'routing', label: t('printer.routing') },
    ];

    return (
        <AppLayout
            title={display.name}
            description={t('display.editHint')}
            breadcrumbs={[{ label: t('display.title'), href: routes.prepDisplays.index() }]}
            actions={
                <>
                    <Badge tone={display.active ? 'ok' : 'neutral'}>
                        {display.active ? t('state.active') : t('state.inactive')}
                    </Badge>
                    <a
                        href={routes.shells.kitchen(display.access_token)}
                        className="inline-flex min-h-touch items-center rounded-pos bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
                    >
                        {t('display.openScreen')}
                    </a>
                </>
            }
        >
            <Head title={`${t('display.title')} — ${display.name}`} />

            <Card>
                <CardBody>
                    <Tabs items={tabs} active={tab} onChange={setTab} label={display.name}>
                        {tab === 'options' ? (
                            <>
                                <FormSection title={t('config.group.general')}>
                                    <TextField
                                        label="Nom"
                                        required
                                        value={form.data.name}
                                        error={form.errors.name}
                                        onChange={(value) => form.setData('name', value)}
                                        maxLength={64}
                                    />
                                    <SelectField
                                        label={t('display.layout')}
                                        value={form.data.layout}
                                        error={form.errors.layout}
                                        onChange={(value) => form.setData('layout', value)}
                                        options={Object.entries(LAYOUT_LABEL).map(([value, label]) => ({
                                            value,
                                            label,
                                        }))}
                                    />
                                    <ToggleField
                                        label={t('state.active')}
                                        checked={form.data.active}
                                        onChange={(checked) => form.setData('active', checked)}
                                    />
                                    <ToggleField
                                        label={t('display.sound')}
                                        checked={form.data.sound_on_new_order}
                                        onChange={(checked) => form.setData('sound_on_new_order', checked)}
                                    />
                                    <ToggleField
                                        label={t('display.autoAdvance')}
                                        checked={form.data.auto_advance_on_all_ready}
                                        onChange={(checked) => form.setData('auto_advance_on_all_ready', checked)}
                                        description={t('display.autoAdvanceHint')}
                                    />
                                    <div className="md:col-span-2 space-y-2">
                                        <TokenField label={t('config.accessToken')} value={display.access_token} />
                                        {/*
                                          * Its own action, never a side effect of saving: this token
                                          * is the whole of the screen's authentication, and rotating
                                          * it blanks every device showing the board.
                                          */}
                                        <ConfirmAction
                                            label={t('display.rotateToken')}
                                            title={t('display.rotateToken')}
                                            message={t('display.rotateTokenConfirm', { name: display.name })}
                                            confirmPhrase={display.name}
                                            onConfirm={() =>
                                                router.post(
                                                    routes.prepDisplays.rotateToken(display.uuid),
                                                    {},
                                                    { preserveScroll: true },
                                                )
                                            }
                                        />
                                    </div>
                                </FormSection>

                                <FormSection title={t('display.timings')} description={t('display.timingsHint')}>
                                    <NumberField
                                        label={t('display.avgPrep')}
                                        value={form.data.average_prep_minutes}
                                        error={form.errors.average_prep_minutes}
                                        onChange={(value) => form.setData('average_prep_minutes', value)}
                                        min={1}
                                        max={600}
                                        suffix="min"
                                    />
                                    <NumberField
                                        label={t('display.late')}
                                        value={form.data.late_threshold_minutes}
                                        error={form.errors.late_threshold_minutes}
                                        onChange={(value) => form.setData('late_threshold_minutes', value)}
                                        min={1}
                                        max={600}
                                        suffix="min"
                                        hint={
                                            (form.data.late_threshold_minutes ?? 0) <
                                            (form.data.average_prep_minutes ?? 0)
                                                ? t('display.thresholdBelowAverage')
                                                : undefined
                                        }
                                    />
                                    <NumberField
                                        label={t('display.retention')}
                                        value={form.data.done_retention_minutes}
                                        error={form.errors.done_retention_minutes}
                                        onChange={(value) => form.setData('done_retention_minutes', value)}
                                        min={1}
                                        max={1440}
                                        suffix="min"
                                        hint={t('display.retentionHint')}
                                    />
                                </FormSection>
                            </>
                        ) : null}

                        {tab === 'stages' ? (
                            <StageEditor stages={editableStages} onChange={setEditableStages} />
                        ) : null}

                        {tab === 'routing' ? (
                            <FormSection columns={1} description={t('display.routingHint')}>
                                <ToggleField
                                    label={t('display.allCategories')}
                                    checked={form.data.show_all_categories}
                                    onChange={(checked) => form.setData('show_all_categories', checked)}
                                    description={t('display.allCategoriesHint')}
                                />
                                <MultiSelectField
                                    label={t('product.categories')}
                                    values={form.data.category_ids}
                                    onChange={(values) => form.setData('category_ids', values)}
                                    options={options}
                                    disabled={form.data.show_all_categories}
                                    lockedReason={
                                        form.data.show_all_categories ? t('display.allCategoriesLock') : undefined
                                    }
                                />
                            </FormSection>
                        ) : null}
                    </Tabs>

                    <SaveBar
                        dirty={form.isDirty || stagesDirty}
                        processing={form.processing}
                        errorCount={Object.keys(form.errors).length}
                        onSave={submit}
                        onCancel={() => {
                            form.reset();
                            setEditableStages(toEditable(stages));
                        }}
                    />
                </CardBody>
            </Card>
        </AppLayout>
    );
}

// ───────────────────────────────────────────────────────────── stages

let nextStageKey = 0;

function StageEditor({
    stages,
    onChange,
}: {
    stages: EditableStage[];
    onChange: (stages: EditableStage[]) => void;
}): JSX.Element {
    const t = useT();

    const patch = useCallback(
        (key: string, changes: Partial<EditableStage>) => {
            onChange(stages.map((stage) => (stage.key === key ? { ...stage, ...changes } : stage)));
        },
        [onChange, stages],
    );

    const move = useCallback(
        (index: number, direction: -1 | 1) => {
            const target = index + direction;
            if (target < 0 || target >= stages.length) return;
            const next = [...stages];
            const moved = next[index];
            const swapped = next[target];
            if (!moved || !swapped) return;
            next[index] = swapped;
            next[target] = moved;
            onChange(next);
        },
        [onChange, stages],
    );

    const add = useCallback(() => {
        nextStageKey += 1;
        onChange([
            ...stages,
            {
                key: `new-${nextStageKey}`,
                id: null,
                name: t('display.newStage'),
                stage_type: 'todo',
                color: STAGE_TYPE_COLOR.todo ?? '#94a3b8',
                alert_after_minutes: null,
                is_default: stages.length === 0,
            },
        ]);
    }, [onChange, stages, t]);

    const remove = useCallback(
        (key: string) => onChange(stages.filter((stage) => stage.key !== key)),
        [onChange, stages],
    );

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader
                    title={t('display.stages')}
                    description={t('display.stagesHint')}
                    actions={
                        <Button variant="secondary" size="md" onClick={add}>
                            {t('display.addStage')}
                        </Button>
                    }
                />
                <CardBody className="p-0">
                    {stages.length === 0 ? (
                        <EmptyState title={t('display.stagesEmpty')} hint={t('display.stagesHint')} />
                    ) : (
                        <ol className="divide-y divide-slate-100">
                            {stages.map((stage, index) => (
                                <li key={stage.key} className="grid gap-3 p-4 lg:grid-cols-[auto_1fr_1fr_auto_auto_auto]">
                                    <div className="flex items-center gap-1">
                                        <span
                                            aria-hidden
                                            className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-sm font-bold text-slate-600"
                                        >
                                            {index + 1}
                                        </span>
                                        <div className="flex flex-col">
                                            <button
                                                type="button"
                                                onClick={() => move(index, -1)}
                                                disabled={index === 0}
                                                aria-label={t('category.moveUp')}
                                                className={cn(
                                                    'rounded px-1 text-xs text-slate-500 hover:text-slate-900 disabled:opacity-30',
                                                    FOCUS_RING,
                                                )}
                                            >
                                                ▲
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => move(index, 1)}
                                                disabled={index === stages.length - 1}
                                                aria-label={t('category.moveDown')}
                                                className={cn(
                                                    'rounded px-1 text-xs text-slate-500 hover:text-slate-900 disabled:opacity-30',
                                                    FOCUS_RING,
                                                )}
                                            >
                                                ▼
                                            </button>
                                        </div>
                                    </div>

                                    <TextField
                                        label={t('display.stageName')}
                                        value={stage.name}
                                        onChange={(value) => patch(stage.key, { name: value })}
                                        maxLength={48}
                                    />

                                    <SelectField
                                        label={t('display.stageType')}
                                        value={stage.stage_type}
                                        onChange={(value) =>
                                            patch(stage.key, {
                                                stage_type: value,
                                                color: stage.color ?? STAGE_TYPE_COLOR[value] ?? null,
                                            })
                                        }
                                        options={Object.entries(STAGE_TYPE_LABEL).map(([value, label]) => ({
                                            value,
                                            label,
                                        }))}
                                    />

                                    <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
                                        {t('display.stageColour')}
                                        <input
                                            type="color"
                                            value={
                                                stage.color && /^#[0-9a-f]{6}$/i.test(stage.color)
                                                    ? stage.color
                                                    : (STAGE_TYPE_COLOR[stage.stage_type] ?? '#94a3b8')
                                            }
                                            onChange={(event) => patch(stage.key, { color: event.target.value })}
                                            className={cn(
                                                'h-11 w-16 cursor-pointer rounded-pos ring-1 ring-inset ring-slate-300',
                                                FOCUS_RING,
                                            )}
                                        />
                                    </label>

                                    <NumberField
                                        label={t('display.stageAlert')}
                                        value={stage.alert_after_minutes}
                                        onChange={(value) => patch(stage.key, { alert_after_minutes: value })}
                                        min={1}
                                        max={600}
                                        suffix="min"
                                        hint={t('display.stageAlertHint')}
                                    />

                                    <div className="flex items-end gap-2">
                                        {stage.is_default ? <Badge tone="brand">{t('display.stageDefault')}</Badge> : null}
                                        <ConfirmAction
                                            label={t('action.delete')}
                                            size="sm"
                                            title={t('display.removeStage')}
                                            message={t('display.removeStageConfirm', { name: stage.name })}
                                            onConfirm={() => remove(stage.key)}
                                        />
                                    </div>
                                </li>
                            ))}
                        </ol>
                    )}
                </CardBody>
            </Card>
        </div>
    );
}
