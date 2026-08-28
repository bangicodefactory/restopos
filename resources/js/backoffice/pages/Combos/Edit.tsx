/**
 * `Combos/Edit` — `GET /combos/{combo}/edit` (BOF-088, BAN-416).
 *
 * A course has three parts and they answer three different questions:
 *
 *  - **the course itself** — how many choices it gives away, how many it accepts, and the weight it
 *    carries in the split
 *  - **its dishes** — what the customer may choose, and what each one costs extra
 *  - **its menus** — which products offer it, which is what makes the till stop and ask
 *
 * The last is the one that is easy to forget and impossible to see: a course with dishes and no menu
 * is never offered to anyone, so it is stated at the top rather than left to be inferred.
 */

import { Head, router, useForm } from '@inertiajs/react';
import { Button } from '@shared/ui';
import { useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { NumberField, SaveBar, TextField, useDirtyGuard } from '../../components/form';
import { FormSection, MoneyField, SelectField } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, Card, CardBody, CardHeader, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { EUR, money } from '../../lib/money';
import { routes } from '../../lib/routes';

import type { ComboEditProps, ComboItemRow, NamedRow, VariantRow } from './types';

export default function ComboEdit({ combo, items, variants, menus, products }: ComboEditProps): JSX.Element {
    const t = useT();

    const form = useForm<{
        name: string;
        base_price: string;
        qty_free: number | null;
        qty_max: number | null;
        sequence: number | null;
    }>({
        name: combo.name,
        base_price: combo.base_price,
        qty_free: combo.qty_free,
        qty_max: combo.qty_max,
        sequence: combo.sequence,
    });

    useDirtyGuard(form.isDirty, t('confirm.leave'));

    const columns: Column<ComboItemRow>[] = [
        {
            id: 'name',
            header: t('combo.dish'),
            locked: true,
            cell: (row) => row.name,
            sortValue: (row) => row.name,
            searchValue: (row) => row.name,
            exportValue: (row) => row.name,
        },
        {
            id: 'list_price',
            header: t('combo.ownPrice'),
            align: 'end',
            cell: (row) => <span className="tabular-nums text-slate-500">{money(row.list_price, EUR)}</span>,
            sortValue: (row) => Number(row.list_price),
            exportValue: (row) => row.list_price,
        },
        {
            id: 'extra_price',
            header: t('combo.supplement'),
            align: 'end',
            cell: (row) =>
                Number(row.extra_price) === 0 ? null : (
                    <span className="tabular-nums">{money(row.extra_price, EUR)}</span>
                ),
            sortValue: (row) => Number(row.extra_price),
            exportValue: (row) => row.extra_price,
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
                        router.delete(routes.comboItems.destroy(combo.id, row.id), { preserveScroll: true })
                    }
                >
                    {t('action.delete')}
                </Button>
            ),
        },
    ];

    return (
        <AppLayout title={combo.name} description={t('combo.hint')}>
            <Head title={combo.name} />

            <div className="space-y-6">
                {menus.length === 0 ? <Notice tone="warn">{t('combo.orphanHint')}</Notice> : null}

                <Card>
                    <CardHeader title={t('combo.settings')} description={t('combo.settingsHint')} />
                    <CardBody className="space-y-4">
                        <FormSection>
                            <TextField
                                label={t('combo.name')}
                                value={form.data.name}
                                error={form.errors.name}
                                onChange={(value) => form.setData('name', value)}
                            />
                            <MoneyField
                                label={t('combo.weight')}
                                hint={t('combo.weightHint')}
                                value={form.data.base_price}
                                error={form.errors.base_price}
                                onChange={(value) => form.setData('base_price', value)}
                            />
                            <NumberField
                                label={t('combo.included')}
                                hint={t('combo.includedHint')}
                                value={form.data.qty_free}
                                error={form.errors.qty_free}
                                min={0}
                                onChange={(value) => form.setData('qty_free', value)}
                            />
                            <NumberField
                                label={t('combo.maximum')}
                                value={form.data.qty_max}
                                error={form.errors.qty_max}
                                min={1}
                                onChange={(value) => form.setData('qty_max', value)}
                            />
                            <NumberField
                                label={t('category.sequence')}
                                value={form.data.sequence}
                                error={form.errors.sequence}
                                min={0}
                                onChange={(value) => form.setData('sequence', value)}
                            />
                        </FormSection>

                        <SaveBar
                            dirty={form.isDirty}
                            processing={form.processing}
                            errorCount={Object.keys(form.errors).length}
                            onSave={() => form.patch(routes.combos.update(combo.id), { preserveScroll: true })}
                            onCancel={() => form.reset()}
                        />
                    </CardBody>
                </Card>

                <Menus comboId={combo.id} menus={menus} products={products} />

                <div className="space-y-3">
                    <AddDish comboId={combo.id} variants={variants} />

                    <DataTable
                        columns={columns}
                        rows={items}
                        getRowId={(row) => row.id}
                        storageKey="combo-items"
                        caption={t('combo.dishes')}
                        exportFilename={`plats-${combo.name}`}
                        rowClassName={(row) => (row.active ? undefined : 'opacity-60')}
                    />
                </div>
            </div>
        </AppLayout>
    );
}

/**
 * Which menus offer this course.
 *
 * Attaching is what sets `products.combo_count`, and that is what makes the till ask the customer to
 * choose — so this is the control that turns a product into a set menu, not a piece of housekeeping.
 */
function Menus({
    comboId,
    menus,
    products,
}: {
    comboId: number;
    menus: NamedRow[];
    products: NamedRow[];
}): JSX.Element {
    const t = useT();
    const [chosen, setChosen] = useState('');

    const attached = new Set(menus.map((menu) => menu.id));
    const available = products.filter((product) => !attached.has(product.id));

    return (
        <Card>
            <CardHeader title={t('combo.menus')} description={t('combo.menusHint')} />
            <CardBody className="space-y-4">
                <div className="flex flex-wrap gap-2">
                    {menus.length === 0 ? (
                        <span className="text-sm text-slate-500">{t('combo.noMenus')}</span>
                    ) : (
                        menus.map((menu) => (
                            <span key={menu.id} className="flex items-center gap-1">
                                <Badge tone="brand">{menu.name}</Badge>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                        router.delete(routes.comboMenus.detach(comboId), {
                                            data: { product_id: menu.id },
                                            preserveScroll: true,
                                        })
                                    }
                                >
                                    {t('action.delete')}
                                </Button>
                            </span>
                        ))
                    )}
                </div>

                <FormSection>
                    <SelectField
                        label={t('combo.addToMenu')}
                        value={chosen}
                        options={[
                            { value: '', label: t('combo.pickMenu') },
                            ...available.map((product) => ({ value: String(product.id), label: product.name })),
                        ]}
                        onChange={setChosen}
                    />
                </FormSection>

                {chosen === '' ? null : (
                    <Button
                        onClick={() =>
                            router.post(
                                routes.comboMenus.attach(comboId),
                                { product_id: Number(chosen) },
                                { preserveScroll: true, onSuccess: () => setChosen('') },
                            )
                        }
                    >
                        {t('action.save')}
                    </Button>
                )}
            </CardBody>
        </Card>
    );
}

function AddDish({ comboId, variants }: { comboId: number; variants: VariantRow[] }): JSX.Element {
    const t = useT();
    const [open, setOpen] = useState(false);

    const form = useForm<{ product_variant_id: string; extra_price: string }>({
        product_variant_id: variants[0] === undefined ? '' : String(variants[0].id),
        extra_price: '0',
    });

    if (!open) {
        return (
            <Button variant="ghost" onClick={() => setOpen(true)}>
                {t('combo.addDish')}
            </Button>
        );
    }

    return (
        <Card>
            <CardHeader title={t('combo.addDish')} description={t('combo.addDishHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <SelectField
                        label={t('combo.dish')}
                        value={form.data.product_variant_id}
                        error={form.errors.product_variant_id}
                        options={variants.map((variant) => ({
                            value: String(variant.id),
                            label: `${variant.name} — ${money(variant.list_price, EUR)}`,
                        }))}
                        onChange={(value) => form.setData('product_variant_id', value)}
                    />
                    <MoneyField
                        label={t('combo.supplement')}
                        hint={t('combo.supplementHint')}
                        value={form.data.extra_price}
                        error={form.errors.extra_price}
                        onChange={(value) => form.setData('extra_price', value)}
                    />
                </FormSection>

                <div className="flex gap-2">
                    <Button
                        loading={form.processing}
                        onClick={() => {
                            form.transform((data) => ({
                                ...data,
                                product_variant_id: Number(data.product_variant_id),
                            }));
                            form.post(routes.comboItems.store(comboId), {
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
