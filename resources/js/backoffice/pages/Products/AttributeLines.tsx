/**
 * Which options a product offers, and what each adds to its price (BOF-085, BAN-412).
 *
 * The attributes themselves are venue-wide and live on their own page. This is the join: which of an
 * attribute's values *this* dish offers, and the supplement each carries here — "large" is +2.00 on
 * a coffee and +6.00 on a pizza, so the number belongs to the pairing rather than to either side.
 *
 * `LinePriceAuthority` reads these supplements to verify what a till charged. A wrong number here is
 * not a display bug; it is the price the guest pays.
 */

import { useForm } from '@inertiajs/react';
import { Button } from '@shared/ui';
import { useState, type JSX } from 'react';

import { SelectField, ToggleField } from '../../components/form';
import { FormSection, MoneyField } from '../../components/form/fields';
import { DeleteAction } from '../../components/ui/DeleteAction';
import { Badge, Card, CardBody, CardHeader, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

export type AttributeOption = {
    id: number;
    name: string;
    display_type: string;
    values: { id: number; name: string }[];
};

export type AttributeLineRow = {
    id: number;
    product_attribute_id: number;
    attribute_name: string;
    is_required: boolean;
    active: boolean;
    values: { product_attribute_value_id: number; name: string; price_extra: string }[];
};

export function AttributeLines({
    productUuid,
    lines,
    attributes,
}: {
    productUuid: string;
    lines: AttributeLineRow[];
    attributes: AttributeOption[];
}): JSX.Element {
    const t = useT();

    /** Attributes this product does not already offer — a second line for one is refused. */
    const available = attributes.filter(
        (attribute) => !lines.some((line) => line.product_attribute_id === attribute.id),
    );

    return (
        <div className="space-y-4">
            {attributes.length === 0 ? (
                <Notice tone="info">{t('attributeLine.noneDefined')}</Notice>
            ) : null}

            {lines.map((line) => (
                <LineEditor key={line.id} productUuid={productUuid} line={line} attributes={attributes} />
            ))}

            {available.length > 0 ? (
                <AddLine productUuid={productUuid} attributes={available} />
            ) : null}
        </div>
    );
}

function LineEditor({
    productUuid,
    line,
    attributes,
}: {
    productUuid: string;
    line: AttributeLineRow;
    attributes: AttributeOption[];
}): JSX.Element {
    const t = useT();
    const attribute = attributes.find((candidate) => candidate.id === line.product_attribute_id);

    const form = useForm<{
        is_required: boolean;
        active: boolean;
        values: { product_attribute_value_id: number; price_extra: string }[];
    }>({
        is_required: line.is_required,
        active: line.active,
        values: line.values.map((value) => ({
            product_attribute_value_id: value.product_attribute_value_id,
            price_extra: value.price_extra,
        })),
    });

    const toggleValue = (valueId: number): void => {
        const has = form.data.values.some((value) => value.product_attribute_value_id === valueId);

        form.setData(
            'values',
            has
                ? form.data.values.filter((value) => value.product_attribute_value_id !== valueId)
                : [...form.data.values, { product_attribute_value_id: valueId, price_extra: '0.00' }],
        );
    };

    const setExtra = (valueId: number, price: string): void => {
        form.setData(
            'values',
            form.data.values.map((value) =>
                value.product_attribute_value_id === valueId ? { ...value, price_extra: price } : value,
            ),
        );
    };

    return (
        <Card>
            <CardHeader
                title={line.attribute_name}
                actions={
                    /*
                     * Refused once an order has recorded a choice from these options — those orders
                     * must keep saying what was chosen. `DeleteAction` surfaces that reason.
                     */
                    <DeleteAction
                        size="md"
                        url={routes.productAttributeLines.destroy(productUuid, line.id)}
                        name={line.attribute_name}
                    />
                }
            />
            <CardBody className="space-y-4">
                <ToggleField
                    label={t('attributeLine.required')}
                    checked={form.data.is_required}
                    onChange={(checked) => form.setData('is_required', checked)}
                    hint={t('attributeLine.requiredHint')}
                />

                <div className="space-y-2">
                    {(attribute?.values ?? []).map((value) => {
                        const chosen = form.data.values.find(
                            (candidate) => candidate.product_attribute_value_id === value.id,
                        );

                        return (
                            <div key={value.id} className="flex flex-wrap items-center gap-3">
                                <label className="inline-flex min-w-40 items-center gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        className="h-4 w-4 rounded border-slate-300"
                                        checked={chosen !== undefined}
                                        onChange={() => toggleValue(value.id)}
                                    />
                                    {value.name}
                                </label>

                                {chosen ? (
                                    <MoneyField
                                        label={t('attributeLine.supplement')}
                                        value={chosen.price_extra}
                                        onChange={(price) => setExtra(value.id, price)}
                                    />
                                ) : null}
                            </div>
                        );
                    })}
                </div>

                {form.data.values.length === 0 ? (
                    <Notice tone="warn">{t('attributeLine.noValues')}</Notice>
                ) : null}

                <div className="flex gap-2">
                    <Button
                        loading={form.processing}
                        disabled={!form.isDirty}
                        onClick={() =>
                            form.patch(routes.productAttributeLines.update(productUuid, line.id), {
                                preserveScroll: true,
                            })
                        }
                    >
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

function AddLine({
    productUuid,
    attributes,
}: {
    productUuid: string;
    attributes: AttributeOption[];
}): JSX.Element {
    const t = useT();
    const [attributeId, setAttributeId] = useState<number>(attributes[0]?.id ?? 0);
    const form = useForm<{ product_attribute_id: number }>({ product_attribute_id: attributeId });

    return (
        <Card>
            <CardHeader title={t('attributeLine.add')} description={t('attributeLine.addHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <SelectField
                        label={t('attribute.title')}
                        value={String(attributeId)}
                        error={form.errors.product_attribute_id}
                        options={attributes.map((attribute) => ({
                            value: String(attribute.id),
                            label: attribute.name,
                        }))}
                        onChange={(value) => {
                            setAttributeId(Number(value));
                            form.setData('product_attribute_id', Number(value));
                        }}
                    />
                </FormSection>

                <Badge tone="info">
                    {t('attributeLine.valuesAfter', {
                        count: String(attributes.find((a) => a.id === attributeId)?.values.length ?? 0),
                    })}
                </Badge>

                <Button
                    loading={form.processing}
                    disabled={attributeId === 0}
                    onClick={() =>
                        form.post(routes.productAttributeLines.store(productUuid), { preserveScroll: true })
                    }
                >
                    {t('attributeLine.add')}
                </Button>
            </CardBody>
        </Card>
    );
}
