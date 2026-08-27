/**
 * `Attributes/Index` — `GET /product-attributes` (BOF-085, BAN-412).
 *
 * The options a menu offers: "Size: small / medium / large", "Cooking: rare / medium / well done".
 *
 * The consuming half of this has always worked — the register bootstraps these, renders the picker
 * from them and disables incompatible pairs, and the server verifies the per-value supplement. There
 * was simply no way to author them, so every option in every venue came from the seeder.
 *
 * Attributes are venue-wide and *attached* to products, because "Size" means the same thing on every
 * dish. What each value costs is per product and lives on the product's own page.
 */

import { Head, useForm } from '@inertiajs/react';
import { Button, cn } from '@shared/ui';
import { useState, type JSX } from 'react';

import { NumberField, SelectField, TextField, ToggleField } from '../../components/form';
import { FormSection } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { DeleteAction } from '../../components/ui/DeleteAction';
import { Badge, Card, CardBody, CardHeader, EmptyState } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import {
    CREATE_VARIANT_LABEL,
    DISPLAY_TYPE_LABEL,
    type AttributeRow,
    type AttributesIndexProps,
} from './types';

const options = (labels: Record<string, string>): { value: string; label: string }[] =>
    Object.entries(labels).map(([value, label]) => ({ value, label }));

export default function AttributesIndex({ attributes }: AttributesIndexProps): JSX.Element {
    const t = useT();
    const [selectedId, setSelectedId] = useState<number | null>(attributes[0]?.id ?? null);

    const selected = attributes.find((attribute) => attribute.id === selectedId) ?? null;

    return (
        <AppLayout title={t('attribute.title')}>
            <Head title={t('attribute.title')} />

            <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
                <Card>
                    <CardHeader title={t('attribute.title')} description={t('attribute.hint')} />
                    <CardBody className="p-0">
                        {attributes.length === 0 ? (
                            <EmptyState title={t('state.empty')} hint={t('attribute.hint')} />
                        ) : (
                            <ul className="divide-y divide-slate-100">
                                {attributes.map((attribute) => (
                                    <li
                                        key={attribute.id}
                                        className={cn(
                                            'flex flex-wrap items-center gap-2 px-4 py-2',
                                            attribute.id === selectedId && 'bg-brand-50',
                                        )}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => setSelectedId(attribute.id)}
                                            className="text-start font-medium text-brand-700 hover:underline"
                                        >
                                            {attribute.name}
                                        </button>
                                        <Badge>{DISPLAY_TYPE_LABEL[attribute.display_type] ?? attribute.display_type}</Badge>
                                        {attribute.active ? null : <Badge>{t('state.inactive')}</Badge>}
                                        <span className="ms-auto text-xs text-slate-500">
                                            {t('attribute.usedBy', {
                                                count: String(attribute.product_count),
                                                values: String(attribute.values.length),
                                            })}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardBody>
                </Card>

                <div className="space-y-6">
                    <AddAttribute />
                    {selected ? <EditAttribute key={selected.id} attribute={selected} /> : null}
                </div>
            </div>
        </AppLayout>
    );
}

type AttributeForm = {
    name: string;
    display_type: string;
    create_variant: string;
    sequence: number | null;
};

function AddAttribute(): JSX.Element {
    const t = useT();
    const form = useForm<AttributeForm>({
        name: '',
        display_type: 'radio',
        create_variant: 'no_variant',
        sequence: null,
    });

    return (
        <Card>
            <CardHeader title={t('attribute.add')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('attribute.name')}
                        required
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <SelectField
                        label={t('attribute.displayType')}
                        value={form.data.display_type}
                        error={form.errors.display_type}
                        options={options(DISPLAY_TYPE_LABEL)}
                        onChange={(value) => form.setData('display_type', value)}
                        hint={t('attribute.displayTypeHint')}
                    />
                    <SelectField
                        label={t('attribute.createVariant')}
                        value={form.data.create_variant}
                        error={form.errors.create_variant}
                        options={options(CREATE_VARIANT_LABEL)}
                        onChange={(value) => form.setData('create_variant', value)}
                        hint={t('attribute.createVariantHint')}
                    />
                </FormSection>

                <Button
                    loading={form.processing}
                    disabled={form.data.name.trim() === ''}
                    onClick={() =>
                        form.post(routes.productAttributes.store(), {
                            preserveScroll: true,
                            onSuccess: () => form.reset(),
                        })
                    }
                >
                    {t('attribute.add')}
                </Button>
            </CardBody>
        </Card>
    );
}

function EditAttribute({ attribute }: { attribute: AttributeRow }): JSX.Element {
    const t = useT();

    const form = useForm<AttributeForm & { active: boolean }>({
        name: attribute.name,
        display_type: attribute.display_type,
        create_variant: attribute.create_variant,
        sequence: attribute.sequence,
        active: attribute.active,
    });

    return (
        <Card>
            <CardHeader
                title={attribute.name}
                actions={
                    /*
                     * The server refuses while any product offers it, naming how many. Deactivating
                     * is almost always what is meant: past orders record which option was chosen and
                     * must keep saying so.
                     */
                    <DeleteAction
                        size="md"
                        url={routes.productAttributes.destroy(attribute.id)}
                        name={attribute.name}
                    />
                }
            />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('attribute.name')}
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <SelectField
                        label={t('attribute.displayType')}
                        value={form.data.display_type}
                        error={form.errors.display_type}
                        options={options(DISPLAY_TYPE_LABEL)}
                        onChange={(value) => form.setData('display_type', value)}
                    />
                    <SelectField
                        label={t('attribute.createVariant')}
                        value={form.data.create_variant}
                        error={form.errors.create_variant}
                        options={options(CREATE_VARIANT_LABEL)}
                        onChange={(value) => form.setData('create_variant', value)}
                    />
                    <NumberField
                        label={t('category.sequence')}
                        value={form.data.sequence}
                        error={form.errors.sequence}
                        onChange={(value) => form.setData('sequence', value)}
                    />
                </FormSection>

                <ToggleField
                    label={t('state.active')}
                    checked={form.data.active}
                    onChange={(checked) => form.setData('active', checked)}
                />

                <div className="flex gap-2">
                    <Button
                        loading={form.processing}
                        disabled={!form.isDirty}
                        onClick={() =>
                            form.patch(routes.productAttributes.update(attribute.id), { preserveScroll: true })
                        }
                    >
                        {t('action.save')}
                    </Button>
                    <Button variant="ghost" disabled={!form.isDirty} onClick={() => form.reset()}>
                        {t('action.cancel')}
                    </Button>
                </div>

                <AttributeValues attribute={attribute} />
            </CardBody>
        </Card>
    );
}

function AttributeValues({ attribute }: { attribute: AttributeRow }): JSX.Element {
    const t = useT();
    const form = useForm<{ name: string; html_color: string; is_custom: boolean }>({
        name: '',
        html_color: '',
        is_custom: false,
    });

    return (
        <div className="space-y-3 border-t border-slate-200 pt-4">
            <h3 className="text-sm font-semibold">{t('attribute.values')}</h3>

            {attribute.values.length === 0 ? (
                <p className="text-sm text-slate-500">{t('attribute.valuesEmpty')}</p>
            ) : (
                <ul className="divide-y divide-slate-100">
                    {attribute.values.map((value) => (
                        <li key={value.id} className="flex items-center gap-2 py-2">
                            <span>{value.name}</span>
                            {value.is_custom ? <Badge tone="info">{t('attribute.custom')}</Badge> : null}
                            {value.active ? null : <Badge>{t('state.inactive')}</Badge>}
                            <span className="ms-auto">
                                <DeleteAction
                                    url={routes.attributeValues.destroy(attribute.id, value.id)}
                                    name={value.name}
                                />
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            <FormSection>
                <TextField
                    label={t('attribute.valueName')}
                    value={form.data.name}
                    error={form.errors.name}
                    onChange={(value) => form.setData('name', value)}
                />
                {attribute.display_type === 'color' ? (
                    <TextField
                        label={t('attribute.colour')}
                        value={form.data.html_color}
                        error={form.errors.html_color}
                        onChange={(value) => form.setData('html_color', value)}
                    />
                ) : null}
            </FormSection>

            <ToggleField
                label={t('attribute.custom')}
                checked={form.data.is_custom}
                onChange={(checked) => form.setData('is_custom', checked)}
                hint={t('attribute.customHint')}
            />

            <Button
                loading={form.processing}
                disabled={form.data.name.trim() === ''}
                onClick={() =>
                    form.post(routes.attributeValues.store(attribute.id), {
                        preserveScroll: true,
                        onSuccess: () => form.reset(),
                    })
                }
            >
                {t('attribute.addValue')}
            </Button>
        </div>
    );
}
