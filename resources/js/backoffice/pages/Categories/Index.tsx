/**
 * `Categories/Index` — `GET /categories` (BOF-084, BOF-085).
 *
 * A tree, not a flat list: POS categories nest, and `sequence` decides the order products appear
 * in on the till, so reordering has to be direct.
 *
 * Reordering offers **two** equivalent affordances, on purpose. Pointer drag-and-drop is what
 * everyone reaches for; the up/down buttons are what a keyboard or screen-reader user needs, and
 * they are not a fallback hidden behind a preference — they are always visible. Both write the
 * same `PATCH /categories/{category}` with the new `sequence`.
 *
 * The availability window (`hour_after` / `hour_until`) is stored as decimal hours; the editor
 * shows a `<time>` input and converts.
 */

import { Head, router, useForm } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { useCallback, useMemo, useState, type JSX } from 'react';

import {
    ColorIndexField,
    NumberField,
    RelationPicker,
    TextField,
    TimeField,
    ToggleField,
} from '../../components/form';
import { AppLayout } from '../../components/layout/AppLayout';
import { ConfirmAction } from '../../components/ui/ConfirmAction';
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { decimalHour, toDecimalHour } from '../../lib/format';
import { useGuardedDelete } from '../../lib/guardedRequest';
import { routes } from '../../lib/routes';

import {
    buildTree,
    flattenTree,
    parentOptions,
    type CategoriesIndexProps,
    type CategoryRow,
} from './types';

export default function CategoriesIndex({ categories }: CategoriesIndexProps): JSX.Element {
    const t = useT();
    const [selectedId, setSelectedId] = useState<number | null>(categories[0]?.id ?? null);
    const [dragId, setDragId] = useState<number | null>(null);

    const rows = useMemo(() => flattenTree(buildTree(categories)), [categories]);
    const selected = categories.find((category) => category.id === selectedId) ?? null;

    /** Siblings share a parent; reordering only ever swaps `sequence` inside one sibling list. */
    const siblingsOf = useCallback(
        (row: CategoryRow) => categories.filter((candidate) => candidate.parent_id === row.parent_id).sort((a, b) => a.sequence - b.sequence),
        [categories],
    );

    const move = useCallback(
        (row: CategoryRow, direction: -1 | 1) => {
            const siblings = siblingsOf(row);
            const index = siblings.findIndex((candidate) => candidate.id === row.id);
            const swapWith = siblings[index + direction];
            if (!swapWith) return;

            router.patch(routes.categories.update(row.id), { sequence: swapWith.sequence }, { preserveScroll: true });
            router.patch(routes.categories.update(swapWith.id), { sequence: row.sequence }, { preserveScroll: true });
        },
        [siblingsOf],
    );

    const dropOn = useCallback(
        (target: CategoryRow) => {
            if (dragId === null || dragId === target.id) return;
            const source = categories.find((candidate) => candidate.id === dragId);
            setDragId(null);
            if (!source || source.parent_id !== target.parent_id) return;
            router.patch(routes.categories.update(source.id), { sequence: target.sequence }, { preserveScroll: true });
            router.patch(routes.categories.update(target.id), { sequence: source.sequence }, { preserveScroll: true });
        },
        [categories, dragId],
    );

    return (
        <AppLayout title={t('category.title')}>
            <Head title={t('category.title')} />

            <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
                <Card>
                    <CardHeader title={t('category.tree')} description={t('category.windowHint')} />
                    <CardBody className="p-0">
                        {rows.length === 0 ? (
                            <EmptyState title={t('state.empty')} hint={t('state.emptyHint')} />
                        ) : (
                            <ul role="tree" aria-label={t('category.tree')} className="divide-y divide-slate-100">
                                {rows.map(({ node, depth }) => {
                                    const isSelected = node.id === selectedId;
                                    return (
                                        <li
                                            key={node.id}
                                            role="treeitem"
                                            aria-level={depth + 1}
                                            aria-selected={isSelected}
                                            draggable
                                            onDragStart={() => setDragId(node.id)}
                                            onDragOver={(event) => event.preventDefault()}
                                            onDrop={() => dropOn(node)}
                                            onDragEnd={() => setDragId(null)}
                                            className={cn(
                                                'flex flex-wrap items-center gap-2 px-4 py-2',
                                                isSelected && 'bg-brand-50',
                                                dragId === node.id && 'opacity-50',
                                            )}
                                            style={{ paddingInlineStart: `${1 + depth * 1.5}rem` }}
                                        >
                                            <span aria-hidden className="cursor-grab text-slate-400">
                                                ⠿
                                            </span>

                                            <button
                                                type="button"
                                                onClick={() => setSelectedId(node.id)}
                                                className={cn(
                                                    'min-h-touch rounded-pos px-1 text-start text-sm font-medium hover:text-brand-700',
                                                    FOCUS_RING,
                                                )}
                                            >
                                                {node.name}
                                            </button>

                                            {!node.active ? <Badge>{t('state.inactive')}</Badge> : null}
                                            {!node.self_order_visible ? <Badge tone="warn">self ✕</Badge> : null}
                                            {node.hour_after || node.hour_until ? (
                                                <Badge tone="info">
                                                    {decimalHour(node.hour_after)} → {decimalHour(node.hour_until)}
                                                </Badge>
                                            ) : null}

                                            <span className="ms-auto flex items-center gap-1">
                                                <button
                                                    type="button"
                                                    aria-label={`${t('category.moveUp')} — ${node.name}`}
                                                    onClick={() => move(node, -1)}
                                                    className={cn(
                                                        'min-h-touch min-w-touch rounded-pos text-slate-500 hover:bg-slate-100',
                                                        FOCUS_RING,
                                                    )}
                                                >
                                                    ↑
                                                </button>
                                                <button
                                                    type="button"
                                                    aria-label={`${t('category.moveDown')} — ${node.name}`}
                                                    onClick={() => move(node, 1)}
                                                    className={cn(
                                                        'min-h-touch min-w-touch rounded-pos text-slate-500 hover:bg-slate-100',
                                                        FOCUS_RING,
                                                    )}
                                                >
                                                    ↓
                                                </button>
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </CardBody>
                </Card>

                <div className="space-y-6">
                    <CreateCategory categories={categories} />
                    {selected ? (
                        <EditCategory key={selected.id} category={selected} categories={categories} />
                    ) : (
                        <Card>
                            <CardBody>
                                <p className="text-sm text-slate-500">{t('state.emptyHint')}</p>
                            </CardBody>
                        </Card>
                    )}
                </div>
            </div>
        </AppLayout>
    );
}

/** Everything a category has, on both doors (BAN-422). */
type CategoryFormData = {
    name: string;
    parent_id: number | null;
    sequence: number | null;
    color: number;
    hour_after: string;
    hour_until: string;
    self_order_visible: boolean;
};

const BLANK_CATEGORY: CategoryFormData = {
    name: '',
    parent_id: null,
    sequence: 10,
    color: 0,
    hour_after: '',
    hour_until: '',
    self_order_visible: true,
};

/** The decimal hours the endpoint wants, from the `<input type="time">` the operator sees. */
function withDecimalHours(data: Record<string, unknown>): Record<string, unknown> {
    return {
        ...data,
        hour_after: data.hour_after === '' ? null : toDecimalHour(String(data.hour_after)),
        hour_until: data.hour_until === '' ? null : toDecimalHour(String(data.hour_until)),
    };
}

/**
 * The one field set both forms render.
 *
 * They used to render different ones, and it was not a simplification: creation had no availability
 * window and editing had no parent, so each door was missing a capability the other had. Sharing the
 * component is what stops them drifting apart again.
 */
function CategoryFields({
    data,
    errors,
    onChange,
    categories,
    subject,
}: {
    data: CategoryFormData;
    errors: Partial<Record<keyof CategoryFormData, string>>;
    onChange: <K extends keyof CategoryFormData>(key: K, value: CategoryFormData[K]) => void;
    categories: CategoryRow[];
    subject: CategoryRow | null;
}): JSX.Element {
    const t = useT();

    return (
        <>
            <TextField
                label="Nom"
                required
                value={data.name}
                error={errors.name}
                onChange={(value) => onChange('name', value)}
            />
            <RelationPicker
                label={t('category.parent')}
                value={data.parent_id}
                options={parentOptions(categories, subject).map((category) => ({
                    value: String(category.id),
                    label: category.name,
                }))}
                onChange={(value) => onChange('parent_id', value)}
            />
            <NumberField
                label={t('category.sequence')}
                value={data.sequence}
                error={errors.sequence}
                onChange={(value) => onChange('sequence', value)}
            />
            <ColorIndexField
                label={t('employee.colour')}
                value={data.color}
                onChange={(value) => onChange('color', value)}
            />

            <div className="grid gap-4 sm:grid-cols-2">
                <TimeField
                    label="Disponible à partir de"
                    value={data.hour_after}
                    onChange={(value) => onChange('hour_after', value)}
                />
                <TimeField
                    label="Disponible jusqu’à"
                    value={data.hour_until}
                    onChange={(value) => onChange('hour_until', value)}
                />
            </div>

            <ToggleField
                label="Visible en commande client"
                checked={data.self_order_visible}
                onChange={(checked) => onChange('self_order_visible', checked)}
                hint={t('category.windowHint')}
            />
        </>
    );
}

function CreateCategory({ categories }: { categories: CategoryRow[] }): JSX.Element {
    const t = useT();
    const form = useForm<CategoryFormData>({ ...BLANK_CATEGORY });

    return (
        <Card>
            <CardHeader title={t('category.new')} />
            <CardBody className="space-y-4">
                <CategoryFields
                    data={form.data}
                    errors={form.errors}
                    onChange={form.setData}
                    categories={categories}
                    subject={null}
                />
                <Button
                    loading={form.processing}
                    disabled={form.data.name.trim() === ''}
                    onClick={() => {
                        form.transform(withDecimalHours);
                        form.post(routes.categories.store(), {
                            preserveScroll: true,
                            onSuccess: () => form.reset(),
                        });
                    }}
                >
                    {t('action.create')}
                </Button>
            </CardBody>
        </Card>
    );
}

function EditCategory({
    category,
    categories,
}: {
    category: CategoryRow;
    categories: CategoryRow[];
}): JSX.Element {
    const t = useT();
    const remove = useGuardedDelete();
    const form = useForm<CategoryFormData & { active: boolean }>({
        name: category.name,
        parent_id: category.parent_id,
        sequence: category.sequence,
        color: category.color,
        hour_after: category.hour_after === null ? '' : toClock(category.hour_after),
        hour_until: category.hour_until === null ? '' : toClock(category.hour_until),
        self_order_visible: category.self_order_visible,
        active: category.active,
    });

    const save = (): void => {
        // `transform` mutates the form and returns void in Inertia v2 — it is not chainable.
        form.transform(withDecimalHours);
        form.patch(routes.categories.update(category.id), { preserveScroll: true });
    };

    const hasChildren = categories.some((candidate) => candidate.parent_id === category.id);

    return (
        <Card>
            <CardHeader
                title={category.name}
                actions={
                    /*
                     * The server refuses far more than sub-categories — products still filed here,
                     * kitchen routing, registers showing it, pricelist rules — and every one of those
                     * referents cascades, so an unguarded delete would take them silently.
                     * `useGuardedDelete` is what puts the server's reason in front of the operator
                     * instead of reloading in silence.
                     */
                    <ConfirmAction
                        label={t('action.delete')}
                        title={t('confirm.title')}
                        message={t('category.deleteConfirm', { name: category.name })}
                        disabled={hasChildren}
                        onConfirm={() => remove(routes.categories.destroy(category.id))}
                    />
                }
            />
            <CardBody className="space-y-4">
                {hasChildren ? (
                    <Notice tone="warn">
                        Cette catégorie a des sous-catégories : supprimez-les d’abord.
                    </Notice>
                ) : null}

                <CategoryFields
                    data={form.data}
                    errors={form.errors}
                    onChange={form.setData}
                    categories={categories}
                    subject={category}
                />

                <ToggleField
                    label={t('state.active')}
                    checked={form.data.active}
                    onChange={(checked) => form.setData('active', checked)}
                />

                <div className="flex gap-2">
                    <Button loading={form.processing} disabled={!form.isDirty} onClick={save}>
                        {t('action.save')}
                    </Button>
                    <Button variant="ghost" disabled={!form.isDirty} onClick={() => form.reset()}>
                        {t('action.cancel')}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

/** "14.50" → "14:30" for the `<input type="time">`. */
function toClock(decimal: string): string {
    const value = Number.parseFloat(decimal);
    if (!Number.isFinite(value)) return '';
    const hours = Math.floor(value);
    const minutes = Math.round((value - hours) * 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
