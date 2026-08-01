/**
 * `Floors/Edit` — the floor-plan editor (`GET /floors/{floor}/edit`, RST-030…049).
 *
 * The canvas is `components/floor-plan/FloorCanvas`; every operation it performs — snap, clamp,
 * move, resize-from-handle, rotate, duplicate, overlap — lives in `components/floor-plan/geometry`
 * as pure functions, which is what makes the hard part of this screen testable without a DOM.
 * This file is the editor *around* the canvas: selection, the inspector, the guards, the save.
 *
 * Things that are deliberate:
 *
 *  - **Rotation swaps width and height.** `restaurant_tables` has no angle column, so a free
 *    rotation would be UI state that vanishes on reload. The 90° swap is the rotation the storage
 *    can actually express, and the inspector says so.
 *  - **Deleting a table is guarded twice.** A table with linked children cannot be removed at all
 *    (removing the parent would orphan a merge); any other table asks for confirmation naming the
 *    consequence — its printed QR stops working.
 *  - **Rotating a table's token is a separate, explicit action**, never a side effect of saving
 *    geometry: `identifier` is the QR capability token and every printed code for that table dies
 *    with it. It has its own route (`POST /tables/{table}/rotate-token`) and its own confirmation.
 *  - **The whole plan is persisted on save (BOF-115).** `PATCH /floors/{floor}` reconciles the
 *    submitted `tables[]`: existing tables are updated in place, new ones (client id < 0) are
 *    created with a fresh token, and any table dropped from the plan is deleted. Geometry,
 *    parenting and deletions survive a reload.
 *  - **The background image is a local overlay.** `background_media_id` is an id with no URL in
 *    the payload and no upload endpoint, so a chosen image aligns the plan in this browser
 *    session and is not persisted. Stated, not implied.
 */

import { Head, router, useForm } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { useCallback, useMemo, useState, type JSX } from 'react';

import { FloorCanvas, type CanvasTable } from '../../components/floor-plan/FloorCanvas';
import {
    DEFAULT_GRID,
    duplicateRect,
    findOverlaps,
    planBounds,
    rotateRect,
    snapRect,
    type Rect,
} from '../../components/floor-plan/geometry';
import {
    ColorField,
    ImageField,
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
import { Badge, Card, CardBody, CardHeader, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import {
    SHAPE_OPTIONS,
    TABLE_COLORS,
    tableLabel,
    toPlanTable,
    toTablePayload,
    type FloorEditProps,
    type PlanTable,
} from './types';

/** New tables live only in the browser until a table write exists; negative ids never collide. */
let nextLocalId = -1;

export default function FloorEdit({ floor, tables }: FloorEditProps): JSX.Element {
    const t = useT();

    const initialPlan = useMemo(() => tables.map(toPlanTable), [tables]);
    const [plan, setPlan] = useState<PlanTable[]>(initialPlan);
    const [selectedId, setSelectedId] = useState<number | null>(initialPlan[0]?.id ?? null);
    const [snapEnabled, setSnapEnabled] = useState(true);
    const [grid, setGrid] = useState<number>(DEFAULT_GRID);
    const [backgroundPreview, setBackgroundPreview] = useState<string | null>(null);

    const form = useForm<{
        name: string;
        background_color: string | null;
        sequence: number | null;
        active: boolean;
    }>({
        name: floor.name,
        background_color: floor.background_color,
        sequence: floor.sequence,
        active: floor.active,
    });

    const planDirty = useMemo(() => JSON.stringify(initialPlan) !== JSON.stringify(plan), [initialPlan, plan]);

    useDirtyGuard(form.isDirty || planDirty, t('confirm.leave'));

    const bounds = useMemo(() => planBounds(plan), [plan]);
    const selected = plan.find((table) => table.id === selectedId) ?? null;

    /** Children pointing at a table make it undeletable: removing it would orphan the merge. */
    const childrenOf = useCallback(
        (id: number) => plan.filter((table) => table.parent_id === id),
        [plan],
    );

    const canvasTables = useMemo<CanvasTable[]>(
        () =>
            plan.map((table) => ({
                id: table.id,
                label: tableLabel(table),
                shape: table.shape,
                seats: table.seats,
                color: table.color,
                linked: table.parent_id !== null,
                x: table.x,
                y: table.y,
                width: table.width,
                height: table.height,
            })),
        [plan],
    );

    const patch = useCallback((id: number, changes: Partial<PlanTable>) => {
        setPlan((current) => current.map((table) => (table.id === id ? { ...table, ...changes } : table)));
    }, []);

    const onGeometryChange = useCallback(
        (id: number, rect: Rect) => patch(id, rect),
        [patch],
    );

    const onRotate = useCallback(
        (id: number) => {
            setPlan((current) =>
                current.map((table) =>
                    table.id === id
                        ? {
                              ...table,
                              ...rotateRect(table, { grid: snapEnabled ? grid : 0, bounds }),
                          }
                        : table,
                ),
            );
        },
        [bounds, grid, snapEnabled],
    );

    const onDuplicate = useCallback(
        (id: number) => {
            setPlan((current) => {
                const source = current.find((table) => table.id === id);
                if (!source) return current;

                const rect = duplicateRect(source, current, { grid: snapEnabled ? grid : 0, bounds });
                const highestNumber = current.reduce((max, table) => Math.max(max, table.table_number), 0);
                nextLocalId -= 1;

                const copy: PlanTable = {
                    ...source,
                    ...rect,
                    id: nextLocalId,
                    uuid: `local-${Math.abs(nextLocalId)}`,
                    table_number: highestNumber + 1,
                    name: null,
                    // A duplicate must never reuse the original's QR capability token.
                    identifier: '',
                    parent_id: null,
                };

                setSelectedId(copy.id);
                return [...current, copy];
            });
        },
        [bounds, grid, snapEnabled],
    );

    const onAdd = useCallback(() => {
        setPlan((current) => {
            const highestNumber = current.reduce((max, table) => Math.max(max, table.table_number), 0);
            nextLocalId -= 1;
            const rect = duplicateRect(
                { x: 10, y: 10, width: 60, height: 60 },
                current,
                { grid: snapEnabled ? grid : 0, bounds },
            );

            const table: PlanTable = {
                id: nextLocalId,
                uuid: `local-${Math.abs(nextLocalId)}`,
                table_number: highestNumber + 1,
                name: null,
                identifier: '',
                shape: 'square',
                seats: 2,
                color: null,
                parent_id: null,
                active: true,
                ...rect,
            };

            setSelectedId(table.id);
            return [...current, table];
        });
    }, [bounds, grid, snapEnabled]);

    const onDelete = useCallback(
        (id: number) => {
            setPlan((current) => current.filter((table) => table.id !== id));
            setSelectedId((current) => (current === id ? null : current));
        },
        [],
    );

    const submit = useCallback(() => {
        form.transform((data) => ({ ...data, tables: plan.map(toTablePayload) }));
        form.patch(routes.floors.update(floor.id), { preserveScroll: true });
    }, [floor.id, form, plan]);

    const collisions = useMemo(
        () => plan.filter((table) => findOverlaps(table, plan.filter((other) => other.id !== table.id)).length > 0),
        [plan],
    );

    return (
        <AppLayout
            fullWidth
            title={floor.name}
            description={t('floor.edit')}
            breadcrumbs={[{ label: t('floor.title'), href: routes.floors.index() }]}
            actions={
                <>
                    <Badge tone={floor.active ? 'ok' : 'neutral'}>
                        {floor.active ? t('state.active') : t('state.inactive')}
                    </Badge>
                    <Badge>{t('floor.tables', { count: plan.length })}</Badge>
                    {collisions.length > 0 ? (
                        <Badge tone="danger">{t('floor.collisionCount', { count: collisions.length })}</Badge>
                    ) : null}
                </>
            }
        >
            <Head title={`${t('floor.edit')} — ${floor.name}`} />

            <div className="space-y-4">
                <div className="grid gap-4 xl:grid-cols-[3fr_1fr]">
                    <div className="space-y-3">
                        <PlanToolbar
                            snapEnabled={snapEnabled}
                            onSnapChange={setSnapEnabled}
                            grid={grid}
                            onGridChange={setGrid}
                            onAdd={onAdd}
                            onSnapAll={() =>
                                setPlan((current) =>
                                    current.map((table) => ({ ...table, ...snapRect(table, grid) })),
                                )
                            }
                        />

                        <FloorCanvas
                            tables={canvasTables}
                            selectedId={selectedId}
                            onSelect={setSelectedId}
                            onGeometryChange={onGeometryChange}
                            bounds={bounds}
                            grid={grid}
                            snapEnabled={snapEnabled}
                            backgroundColor={form.data.background_color}
                            backgroundImageUrl={backgroundPreview}
                            onRotate={onRotate}
                            onDuplicate={onDuplicate}
                            onDelete={(id) => {
                                // Keyboard Delete goes through the same guard as the button.
                                if (childrenOf(id).length > 0) return;
                                if (globalThis.confirm(t('floor.deleteGuard', { name: labelFor(plan, id) }))) {
                                    onDelete(id);
                                }
                            }}
                        />

                        <p className="text-xs text-slate-500">{t('floor.keyboardHint')}</p>
                    </div>

                    <div className="space-y-4">
                        <Inspector
                            table={selected}
                            plan={plan}
                            childCount={selected === null ? 0 : childrenOf(selected.id).length}
                            onPatch={patch}
                            onRotate={onRotate}
                            onDuplicate={onDuplicate}
                            onDelete={onDelete}
                        />

                        <FloorSettings
                            form={form}
                            backgroundPreview={backgroundPreview}
                            onBackgroundPreview={setBackgroundPreview}
                        />
                    </div>
                </div>

                <SaveBar
                    dirty={form.isDirty || planDirty}
                    processing={form.processing}
                    errorCount={Object.keys(form.errors).length}
                    saveLabel={t('floor.saveGeometry')}
                    onSave={submit}
                    onCancel={() => {
                        form.reset();
                        setPlan(initialPlan);
                    }}
                    extra={
                        collisions.length > 0 ? <Badge tone="warn">{t('floor.collision')}</Badge> : undefined
                    }
                />
            </div>
        </AppLayout>
    );
}

function labelFor(plan: readonly PlanTable[], id: number): string {
    const table = plan.find((candidate) => candidate.id === id);
    return table ? tableLabel(table) : `#${id}`;
}

// ───────────────────────────────────────────────────────────── toolbar

function PlanToolbar({
    snapEnabled,
    onSnapChange,
    grid,
    onGridChange,
    onAdd,
    onSnapAll,
}: {
    snapEnabled: boolean;
    onSnapChange: (value: boolean) => void;
    grid: number;
    onGridChange: (value: number) => void;
    onAdd: () => void;
    onSnapAll: () => void;
}): JSX.Element {
    const t = useT();

    return (
        <div className="flex flex-wrap items-center gap-3 rounded-pos-lg bg-white px-4 py-3 shadow-pos ring-1 ring-slate-200">
            <Button size="md" onClick={onAdd}>
                {t('floor.addTable')}
            </Button>

            <label className="flex min-h-touch items-center gap-2 text-sm text-slate-700">
                <input
                    type="checkbox"
                    checked={snapEnabled}
                    onChange={(event) => onSnapChange(event.target.checked)}
                    className={cn('h-4 w-4 rounded border-slate-300', FOCUS_RING)}
                />
                {t('floor.grid')}
            </label>

            <label className="flex items-center gap-2 text-sm text-slate-700" htmlFor="floor-grid-step">
                {t('floor.gridStep')}
                <select
                    id="floor-grid-step"
                    value={String(grid)}
                    disabled={!snapEnabled}
                    onChange={(event) => onGridChange(Number(event.target.value))}
                    className={cn(
                        'min-h-touch rounded-pos bg-white px-3 text-sm ring-1 ring-inset ring-slate-300 disabled:opacity-50',
                        FOCUS_RING,
                    )}
                >
                    {[5, 10, 20, 25, 50].map((step) => (
                        <option key={step} value={String(step)}>
                            {step} px
                        </option>
                    ))}
                </select>
            </label>

            <Button variant="secondary" size="md" onClick={onSnapAll} disabled={!snapEnabled}>
                {t('floor.snapAll')}
            </Button>
        </div>
    );
}

// ───────────────────────────────────────────────────────────── inspector

function Inspector({
    table,
    plan,
    childCount,
    onPatch,
    onRotate,
    onDuplicate,
    onDelete,
}: {
    table: PlanTable | null;
    plan: PlanTable[];
    childCount: number;
    onPatch: (id: number, changes: Partial<PlanTable>) => void;
    onRotate: (id: number) => void;
    onDuplicate: (id: number) => void;
    onDelete: (id: number) => void;
}): JSX.Element {
    const t = useT();

    if (table === null) {
        return (
            <Card>
                <CardHeader title={t('floor.inspector')} />
                <CardBody>
                    <p className="text-sm text-slate-500">{t('floor.noSelection')}</p>
                </CardBody>
            </Card>
        );
    }

    const isNew = table.id < 0;
    const parentOptions = plan
        .filter((candidate) => candidate.id !== table.id && candidate.parent_id === null)
        .map((candidate) => ({ value: String(candidate.id), label: tableLabel(candidate) }));

    return (
        <Card>
            <CardHeader
                title={t('floor.inspector')}
                description={tableLabel(table)}
                actions={isNew ? <Badge tone="info">{t('floor.newTable')}</Badge> : null}
            />
            <CardBody className="space-y-4">
                <FormSection columns={1}>
                    <NumberField
                        label={t('floor.tableNumber')}
                        value={table.table_number}
                        onChange={(value) => onPatch(table.id, { table_number: value ?? table.table_number })}
                        min={0}
                    />
                    <TextField
                        label="Nom"
                        value={table.name ?? ''}
                        onChange={(value) => onPatch(table.id, { name: value === '' ? null : value })}
                        maxLength={32}
                        hint={t('floor.nameHint')}
                    />
                    <SelectField
                        label={t('floor.shape')}
                        value={table.shape}
                        onChange={(value) =>
                            onPatch(table.id, { shape: value === 'round' ? 'round' : 'square' })
                        }
                        options={SHAPE_OPTIONS.map((option) => ({ ...option }))}
                    />
                    <NumberField
                        label={t('floor.seats')}
                        value={table.seats}
                        onChange={(value) => onPatch(table.id, { seats: Math.max(0, value ?? 0) })}
                        min={0}
                        max={24}
                    />
                </FormSection>

                <fieldset>
                    <legend className="mb-1 text-sm font-medium text-slate-700">{t('employee.colour')}</legend>
                    <div role="radiogroup" aria-label={t('employee.colour')} className="flex flex-wrap gap-1.5">
                        {TABLE_COLORS.map((colour) => (
                            <button
                                key={colour}
                                type="button"
                                role="radio"
                                aria-checked={table.color === colour}
                                aria-label={colour}
                                onClick={() => onPatch(table.id, { color: colour })}
                                style={{ backgroundColor: colour }}
                                className={cn(
                                    'h-8 w-8 rounded-pos ring-2 ring-offset-2',
                                    table.color === colour ? 'ring-slate-900' : 'ring-slate-200',
                                    FOCUS_RING,
                                )}
                            />
                        ))}
                        <button
                            type="button"
                            onClick={() => onPatch(table.id, { color: null })}
                            className={cn(
                                'min-h-touch rounded-pos px-2 text-sm text-slate-500 hover:text-slate-800',
                                FOCUS_RING,
                            )}
                        >
                            {t('state.none')}
                        </button>
                    </div>
                </fieldset>

                <FormSection columns={2}>
                    <NumberField
                        label="X"
                        value={Math.round(table.x)}
                        onChange={(value) => onPatch(table.id, { x: value ?? table.x })}
                        min={0}
                    />
                    <NumberField
                        label="Y"
                        value={Math.round(table.y)}
                        onChange={(value) => onPatch(table.id, { y: value ?? table.y })}
                        min={0}
                    />
                    <NumberField
                        label="Largeur"
                        value={Math.round(table.width)}
                        onChange={(value) => onPatch(table.id, { width: value ?? table.width })}
                        min={20}
                    />
                    <NumberField
                        label="Hauteur"
                        value={Math.round(table.height)}
                        onChange={(value) => onPatch(table.id, { height: value ?? table.height })}
                        min={20}
                    />
                </FormSection>

                <SelectField
                    label={t('floor.parent')}
                    value={table.parent_id === null ? '' : String(table.parent_id)}
                    onChange={(value) => onPatch(table.id, { parent_id: value === '' ? null : Number(value) })}
                    options={parentOptions}
                    placeholder={t('state.none')}
                    hint={t('floor.parentHint')}
                />

                <ToggleField
                    label={t('state.active')}
                    checked={table.active}
                    onChange={(checked) => onPatch(table.id, { active: checked })}
                />

                <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
                    <Button variant="secondary" size="md" onClick={() => onRotate(table.id)}>
                        {t('floor.rotate')}
                    </Button>
                    <Button variant="secondary" size="md" onClick={() => onDuplicate(table.id)}>
                        {t('floor.duplicate')}
                    </Button>

                    {childCount > 0 ? (
                        <Button variant="danger" size="md" disabled title={t('floor.deleteGuardChildren')}>
                            {t('floor.deleteTable')}
                        </Button>
                    ) : (
                        <ConfirmAction
                            label={t('floor.deleteTable')}
                            title={t('floor.deleteTable')}
                            message={t('floor.deleteGuard', { name: tableLabel(table) })}
                            onConfirm={() => onDelete(table.id)}
                        />
                    )}
                </div>

                {childCount > 0 ? <Notice tone="warn">{t('floor.deleteGuardChildren')}</Notice> : null}

                <p className="text-xs text-slate-500">{t('floor.rotateHint')}</p>

                {isNew ? (
                    <Notice tone="info">{t('floor.newTableHint')}</Notice>
                ) : (
                    <div className="space-y-2 border-t border-slate-200 pt-3">
                        <TokenField label={t('floor.token')} value={table.identifier} />
                        <ConfirmAction
                            label={t('floor.rotateToken')}
                            title={t('floor.rotateToken')}
                            message={t('floor.rotateTokenConfirm', { name: tableLabel(table) })}
                            confirmPhrase={tableLabel(table)}
                            onConfirm={() =>
                                router.post(routes.floors.rotateTableToken(table.id), {}, { preserveScroll: true })
                            }
                        />
                    </div>
                )}
            </CardBody>
        </Card>
    );
}

// ───────────────────────────────────────────────────────────── floor settings

function FloorSettings({
    form,
    backgroundPreview,
    onBackgroundPreview,
}: {
    form: ReturnType<
        typeof useForm<{
            name: string;
            background_color: string | null;
            sequence: number | null;
            active: boolean;
        }>
    >;
    backgroundPreview: string | null;
    onBackgroundPreview: (value: string | null) => void;
}): JSX.Element {
    const t = useT();

    return (
        <Card>
            <CardHeader title={t('floor.title')} description={t('floor.background')} />
            <CardBody>
                <FormSection columns={1}>
                    <TextField
                        label="Nom"
                        required
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                        maxLength={64}
                    />
                    <ColorField
                        label={t('floor.backgroundColor')}
                        value={form.data.background_color}
                        error={form.errors.background_color}
                        onChange={(value) => form.setData('background_color', value)}
                    />
                    <NumberField
                        label={t('category.sequence')}
                        value={form.data.sequence}
                        error={form.errors.sequence}
                        onChange={(value) => form.setData('sequence', value)}
                        min={0}
                    />
                    <ToggleField
                        label={t('state.active')}
                        checked={form.data.active}
                        onChange={(checked) => form.setData('active', checked)}
                    />
                    <ImageField
                        label={t('floor.backgroundImage')}
                        previewUrl={backgroundPreview}
                        onChange={(_file, preview) => onBackgroundPreview(preview)}
                        hint={t('floor.backgroundImageLocal')}
                    />
                </FormSection>
            </CardBody>
        </Card>
    );
}
