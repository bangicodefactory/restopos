/**
 * The variant editor on a product page (BOF-087, BAN-409).
 *
 * A variant is the sellable unit — `pos_order_lines` points at one, not at a product — so this grid
 * is where a venue adds a size, gives it a barcode and sets what it costs on top. It was a read-only
 * table, and every variant in the system came from a seeder.
 *
 * Each row saves on its own rather than the whole grid submitting together. Two reasons: a variant
 * has its own endpoint, so a batch would be several requests pretending to be one and would half-fail
 * in ways nothing could report; and the refusals here are per-row — a duplicate barcode names *which*
 * variant already owns it, which is unreadable if four rows were sent at once.
 */

import { useForm } from '@inertiajs/react';
import { Button } from '@shared/ui';
import { useState, type JSX } from 'react';

import { NumberField, TextField, ToggleField } from '../../components/form';
import { FormSection, MoneyField } from '../../components/form/fields';
import { DeleteAction } from '../../components/ui/DeleteAction';
import { Badge, Card, CardBody, CardHeader, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { EUR, money, quantity } from '../../lib/money';
import { routes } from '../../lib/routes';

import type { ProductVariantRow } from './types';


export function VariantGrid({
    productUuid,
    variants,
}: {
    productUuid: string;
    variants: ProductVariantRow[];
}): JSX.Element {
    const t = useT();
    const [editing, setEditing] = useState<number | null>(null);

    return (
        <div className="space-y-4">
            {/*
              * Said out loud because the field accepts a number and nothing acts on it. The stock
              * ledger (REG-327/328) is not built: on-hand is recorded and never decremented by a
              * sale, so a count entered here stays exactly as typed.
              */}
            <Notice tone="info">{t('variant.stockInert')}</Notice>

            <div className="overflow-auto">
                <table className="w-full border-collapse text-sm">
                    <caption className="sr-only">{t('product.variants')}</caption>
                    <thead className="bg-slate-50">
                        <tr>
                            <th scope="col" className="px-3 py-2 text-start text-xs uppercase text-slate-600">
                                {t('variant.name')}
                            </th>
                            <th scope="col" className="px-3 py-2 text-start text-xs uppercase text-slate-600">
                                {t('variant.barcode')}
                            </th>
                            <th scope="col" className="px-3 py-2 text-end text-xs uppercase text-slate-600">
                                {t('variant.priceExtra')}
                            </th>
                            <th scope="col" className="px-3 py-2 text-end text-xs uppercase text-slate-600">
                                {t('variant.onHand')}
                            </th>
                            <th scope="col" className="px-3 py-2 text-center text-xs uppercase text-slate-600">
                                {t('state.active')}
                            </th>
                            <th scope="col" className="px-3 py-2 text-end text-xs uppercase text-slate-600">
                                <span className="sr-only">{t('action.edit')}</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {variants.map((variant) => (
                            <tr key={variant.id}>
                                <td className="px-3 py-2">{variant.display_name}</td>
                                <td className="px-3 py-2 font-mono text-xs">{variant.barcode ?? '—'}</td>
                                <td className="px-3 py-2 text-end tabular-nums">
                                    {money(variant.price_extra, EUR)}
                                </td>
                                <td className="px-3 py-2 text-end tabular-nums">
                                    {quantity(variant.on_hand_qty)}
                                </td>
                                <td className="px-3 py-2 text-center">
                                    <Badge tone={variant.active ? 'ok' : 'neutral'}>
                                        {variant.active ? t('state.yes') : t('state.no')}
                                    </Badge>
                                </td>
                                <td className="px-3 py-2 text-end">
                                    <span className="flex items-center justify-end gap-2">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setEditing(editing === variant.id ? null : variant.id)}
                                        >
                                            {t('action.edit')}
                                        </Button>
                                        {/*
                                          * The server refuses the last one and refuses during an open
                                          * session, naming which; `DeleteAction` is what puts that on
                                          * screen rather than reloading in silence.
                                          */}
                                        <DeleteAction
                                            url={routes.productVariants.destroy(productUuid, variant.uuid)}
                                            name={variant.display_name}
                                            label={t('variant.archive')}
                                        />
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {variants
                .filter((variant) => variant.id === editing)
                .map((variant) => (
                    <EditVariant key={variant.id} productUuid={productUuid} variant={variant} />
                ))}

            <AddVariant productUuid={productUuid} />
        </div>
    );
}

type VariantForm = {
    name_suffix: string;
    default_code: string;
    barcode: string;
    price_extra: string;
    on_hand_qty: string;
    self_order_available: boolean;
};

function VariantFields({
    data,
    errors,
    onChange,
}: {
    data: VariantForm;
    errors: Partial<Record<keyof VariantForm, string>>;
    onChange: <K extends keyof VariantForm>(key: K, value: VariantForm[K]) => void;
}): JSX.Element {
    const t = useT();

    return (
        <FormSection>
            <TextField
                label={t('variant.suffix')}
                value={data.name_suffix}
                error={errors.name_suffix}
                onChange={(value) => onChange('name_suffix', value)}
                hint={t('variant.suffixHint')}
            />
            <TextField
                label={t('variant.reference')}
                value={data.default_code}
                error={errors.default_code}
                onChange={(value) => onChange('default_code', value)}
            />
            <TextField
                label={t('variant.barcode')}
                value={data.barcode}
                error={errors.barcode}
                onChange={(value) => onChange('barcode', value)}
                hint={t('variant.barcodeHint')}
            />
            <MoneyField
                label={t('variant.priceExtra')}
                value={data.price_extra}
                error={errors.price_extra}
                onChange={(value) => onChange('price_extra', value)}
                hint={t('variant.priceExtraHint')}
            />
            <NumberField
                label={t('variant.onHand')}
                value={Number(data.on_hand_qty)}
                error={errors.on_hand_qty}
                onChange={(value) => onChange('on_hand_qty', String(value ?? 0))}
            />
            <ToggleField
                label={t('product.selfOrderAvailable')}
                checked={data.self_order_available}
                onChange={(checked) => onChange('self_order_available', checked)}
            />
        </FormSection>
    );
}

function EditVariant({ productUuid, variant }: { productUuid: string; variant: ProductVariantRow }): JSX.Element {
    const t = useT();

    const form = useForm<VariantForm>({
        name_suffix: variant.name_suffix ?? '',
        default_code: variant.default_code ?? '',
        barcode: variant.barcode ?? '',
        price_extra: variant.price_extra,
        on_hand_qty: variant.on_hand_qty,
        self_order_available: variant.self_order_available,
    });

    return (
        <Card>
            <CardHeader title={variant.display_name} />
            <CardBody className="space-y-4">
                <VariantFields data={form.data} errors={form.errors} onChange={form.setData} />

                <div className="flex gap-2">
                    <Button
                        loading={form.processing}
                        disabled={!form.isDirty}
                        onClick={() =>
                            form.patch(routes.productVariants.update(productUuid, variant.uuid), {
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

function AddVariant({ productUuid }: { productUuid: string }): JSX.Element {
    const t = useT();

    const form = useForm<VariantForm>({
        name_suffix: '',
        default_code: '',
        barcode: '',
        price_extra: '0.00',
        on_hand_qty: '0',
        self_order_available: true,
    });

    return (
        <Card>
            <CardHeader title={t('variant.add')} />
            <CardBody className="space-y-4">
                <VariantFields data={form.data} errors={form.errors} onChange={form.setData} />

                <Button
                    loading={form.processing}
                    disabled={form.data.name_suffix.trim() === ''}
                    onClick={() =>
                        form.post(routes.productVariants.store(productUuid), {
                            preserveScroll: true,
                            onSuccess: () => form.reset(),
                        })
                    }
                >
                    {t('variant.add')}
                </Button>
            </CardBody>
        </Card>
    );
}
