/**
 * `Products/Edit` — `GET /products/{product}/edit` (BOF-081, BOF-082, BOF-087).
 *
 * Pricing, taxes, POS categories, availability flags and identifiers are editable; the rest of
 * the `products` row is shown read-only because `PATCH /products/{product}` validates only ten
 * keys (`WRITABLE_PRODUCT_KEYS`).
 *
 * Variants are listed from `product.variants` — the computed `product_variants` rows, with their
 * `price_extra`. **Attribute lines and combos are not in this page's props** (spec 05 §12 gives
 * `Products/Edit` only `product` + deferred `options`), so those panels say so instead of
 * inventing a second data path.
 */

import { Head, useForm } from '@inertiajs/react';
import { useCallback, useMemo, useState, type JSX } from 'react';

import {
    ImageField,
    MoneyField,
    MultiSelectField,
    SaveBar,
    TextField,
    TextareaField,
    ToggleField,
    useDirtyGuard,
} from '../../components/form';
import { FormRow, FormSection } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { Tabs, type TabItem } from '../../components/ui/Tabs';
import {
    Badge,
    Card,
    CardBody,
    DeferredRegion,
    DefinitionList,
    Notice,
} from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { dateTime, integer } from '../../lib/format';
import { EUR, money, percent, quantity, subtractMoney, toDecimal } from '../../lib/money';
import { routes } from '../../lib/routes';

import type { ProductEditProps } from './types';

type ProductForm = {
    name: string;
    default_code: string;
    barcode: string;
    list_price: string;
    standard_price: string;
    available_in_pos: boolean;
    self_order_available: boolean;
    active: boolean;
    pos_category_ids: number[];
    tax_ids: number[];
};

export default function ProductEdit({ product, options }: ProductEditProps): JSX.Element {
    const t = useT();
    const [tab, setTab] = useState('general');
    const locked = 'Non modifiable : ce champ n’est pas accepté par PATCH /products/{id}.';

    const initial: ProductForm = useMemo(
        () => ({
            name: product.name,
            default_code: product.default_code ?? '',
            barcode: product.barcode ?? '',
            list_price: product.list_price,
            standard_price: product.standard_price,
            available_in_pos: product.available_in_pos,
            self_order_available: product.self_order_available,
            active: product.active,
            pos_category_ids: product.pos_category_ids,
            tax_ids: product.tax_ids,
        }),
        [product],
    );

    const form = useForm<ProductForm>(initial);
    useDirtyGuard(form.isDirty, t('confirm.leave'));

    const submit = useCallback(() => {
        form.patch(routes.products.update(product.id), { preserveScroll: true });
    }, [form, product.id]);

    const marginAmount = subtractMoney(form.data.list_price, form.data.standard_price);
    const marginPercent = toDecimal(form.data.list_price).isZero()
        ? '0'
        : toDecimal(marginAmount).div(toDecimal(form.data.list_price), 6).mul('100').toString();

    const tabs: TabItem[] = [
        { id: 'general', label: t('config.group.general') },
        { id: 'pricing', label: t('product.pricing') },
        { id: 'variants', label: t('product.variants'), badge: <Badge>{product.variants.length}</Badge> },
        { id: 'combos', label: t('product.combos') },
        { id: 'meta', label: t('order.audit') },
    ];

    return (
        <AppLayout
            title={product.name}
            breadcrumbs={[{ label: t('product.title'), href: routes.products.index() }]}
            actions={
                <>
                    <Badge tone={product.available_in_pos ? 'ok' : 'neutral'}>{t('product.availableInPos')}</Badge>
                    {product.is_special ? <Badge tone="warn">{product.special_kind}</Badge> : null}
                </>
            }
        >
            <Head title={`${t('product.edit')} — ${product.name}`} />

            <Card>
                <CardBody>
                    <Tabs items={tabs} active={tab} onChange={setTab} label={t('product.edit')}>
                        {tab === 'general' ? (
                            <FormSection>
                                <TextField
                                    label="Nom"
                                    required
                                    value={form.data.name}
                                    error={form.errors.name}
                                    onChange={(value) => form.setData('name', value)}
                                />
                                <TextField
                                    label="Référence interne"
                                    value={form.data.default_code}
                                    error={form.errors.default_code}
                                    onChange={(value) => form.setData('default_code', value)}
                                />
                                <TextField
                                    label="Code-barres"
                                    value={form.data.barcode}
                                    error={form.errors.barcode}
                                    onChange={(value) => form.setData('barcode', value)}
                                    hint="Unique par société ; le contrôle est côté serveur."
                                />
                                <TextField
                                    label="Unité de mesure (id)"
                                    value={String(product.uom_id)}
                                    onChange={() => {}}
                                    disabled
                                    lockedReason={locked}
                                />

                                <ToggleField
                                    label={t('product.availableInPos')}
                                    checked={form.data.available_in_pos}
                                    onChange={(checked) => form.setData('available_in_pos', checked)}
                                />
                                <ToggleField
                                    label={t('product.selfOrderAvailable')}
                                    checked={form.data.self_order_available}
                                    onChange={(checked) => form.setData('self_order_available', checked)}
                                    hint="Le 86-ing d’un plat (BOF-094) passe par ce commutateur."
                                />
                                <ToggleField
                                    label={t('state.active')}
                                    checked={form.data.active}
                                    onChange={(checked) => form.setData('active', checked)}
                                    hint="Archiver un produit est refusé pendant une session ouverte (BOF-083)."
                                />
                                <ToggleField
                                    label="Vendu au poids"
                                    checked={product.to_weight}
                                    onChange={() => {}}
                                    disabled
                                    lockedReason={locked}
                                />

                                <FormRow>
                                    <DeferredRegion value={options} label={t('product.categories')} rows={2}>
                                        {(value) => (
                                            <div className="grid gap-4 md:grid-cols-2">
                                                <MultiSelectField
                                                    label={t('product.categories')}
                                                    values={form.data.pos_category_ids}
                                                    options={value.categories.map((category) => ({
                                                        value: String(category.id),
                                                        label: category.name,
                                                    }))}
                                                    onChange={(values) => form.setData('pos_category_ids', values)}
                                                    hint="La première catégorie est figée sur la ligne de commande : elle route le ticket cuisine."
                                                />
                                                <MultiSelectField
                                                    label={t('product.taxes')}
                                                    values={form.data.tax_ids}
                                                    options={value.taxes.map((tax) => ({
                                                        value: String(tax.id),
                                                        label: `${tax.name} · ${tax.amount_type === 'percent' ? percent(tax.amount) : money(tax.amount, EUR)}`,
                                                    }))}
                                                    onChange={(values) => form.setData('tax_ids', values)}
                                                    hint="Les taxes de ligne sont dérivées du catalogue côté serveur : un client ne peut pas annuler la TVA en omettant les ids."
                                                />
                                            </div>
                                        )}
                                    </DeferredRegion>
                                </FormRow>

                                <FormRow>
                                    <ImageField
                                        label={t('product.image')}
                                        previewUrl={null}
                                        onChange={() => {}}
                                        disabled
                                        lockedReason={locked}
                                        hint="Le contrat n’expose pas d’upload d’image produit ; `image_media_id` est en lecture seule."
                                    />
                                </FormRow>

                                <FormRow>
                                    <TextareaField
                                        label="Description de vente"
                                        value={product.description_sale ?? ''}
                                        onChange={() => {}}
                                        disabled
                                        lockedReason={locked}
                                        rows={3}
                                    />
                                </FormRow>
                            </FormSection>
                        ) : null}

                        {tab === 'pricing' ? (
                            <FormSection>
                                <MoneyField
                                    label={t('product.listPrice')}
                                    value={form.data.list_price}
                                    error={form.errors.list_price}
                                    onChange={(value) => form.setData('list_price', value)}
                                />
                                <MoneyField
                                    label={t('product.standardPrice')}
                                    value={form.data.standard_price}
                                    error={form.errors.standard_price}
                                    onChange={(value) => form.setData('standard_price', value)}
                                />

                                <FormRow>
                                    <div className="rounded-pos bg-slate-50 p-4">
                                        <DefinitionList
                                            columns={3}
                                            items={[
                                                { label: t('product.margin'), value: money(marginAmount, EUR) },
                                                { label: `${t('product.margin')} %`, value: percent(marginPercent, 1) },
                                                {
                                                    label: 'Ventes cumulées',
                                                    value: `${integer(product.sale_count)} · ${dateTime(product.last_sold_at)}`,
                                                },
                                            ]}
                                        />
                                    </div>
                                </FormRow>

                                <FormRow>
                                    <Notice tone="info">
                                        Les règles de liste de prix s’appliquent par-dessus ce prix de base et se
                                        résolvent par spécificité — voir {t('nav.pricelists')}.
                                    </Notice>
                                </FormRow>
                            </FormSection>
                        ) : null}

                        {tab === 'variants' ? (
                            <div className="space-y-4">
                                <Notice tone="info">{t('product.combosMissing')}</Notice>

                                {product.variants.length === 0 ? (
                                    <p className="text-sm text-slate-500">{t('product.variantsEmpty')}</p>
                                ) : (
                                    <div className="overflow-auto">
                                        <table className="w-full border-collapse text-sm">
                                            <caption className="sr-only">{t('product.variants')}</caption>
                                            <thead className="bg-slate-50">
                                                <tr>
                                                    <th scope="col" className="px-3 py-2 text-start text-xs uppercase text-slate-600">
                                                        Nom
                                                    </th>
                                                    <th scope="col" className="px-3 py-2 text-start text-xs uppercase text-slate-600">
                                                        Référence
                                                    </th>
                                                    <th scope="col" className="px-3 py-2 text-start text-xs uppercase text-slate-600">
                                                        Code-barres
                                                    </th>
                                                    <th scope="col" className="px-3 py-2 text-end text-xs uppercase text-slate-600">
                                                        Supplément
                                                    </th>
                                                    <th scope="col" className="px-3 py-2 text-end text-xs uppercase text-slate-600">
                                                        Stock
                                                    </th>
                                                    <th scope="col" className="px-3 py-2 text-center text-xs uppercase text-slate-600">
                                                        {t('state.active')}
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-slate-100">
                                                {product.variants.map((variant) => (
                                                    <tr key={variant.id}>
                                                        <td className="px-3 py-2">{variant.display_name}</td>
                                                        <td className="px-3 py-2 font-mono text-xs">
                                                            {variant.default_code ?? '—'}
                                                        </td>
                                                        <td className="px-3 py-2 font-mono text-xs">
                                                            {variant.barcode ?? '—'}
                                                        </td>
                                                        <td className="px-3 py-2 text-end tabular-nums">
                                                            {money(variant.price_extra, EUR)}
                                                        </td>
                                                        <td className="px-3 py-2 text-end tabular-nums">
                                                            {quantity(variant.on_hand_qty)}
                                                        </td>
                                                        <td className="px-3 py-2 text-center">
                                                            <Badge tone={variant.is_active_combination ? 'ok' : 'neutral'}>
                                                                {variant.is_active_combination ? t('state.yes') : t('state.no')}
                                                            </Badge>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        ) : null}

                        {tab === 'combos' ? (
                            <div className="space-y-4">
                                <Notice tone="warn">{t('product.combosMissing')}</Notice>
                                <DefinitionList
                                    items={[
                                        { label: 'Lignes d’attributs', value: integer(product.attribute_count) },
                                        { label: t('product.combos'), value: integer(product.combo_count) },
                                    ]}
                                />
                            </div>
                        ) : null}

                        {tab === 'meta' ? (
                            <DefinitionList
                                columns={3}
                                items={[
                                    { label: 'UUID', value: <span className="font-mono text-xs">{product.uuid}</span> },
                                    { label: 'Type', value: product.product_type },
                                    { label: 'Séquence PDV', value: integer(product.pos_sequence) },
                                    { label: 'Créé le', value: dateTime(product.created_at) },
                                    { label: 'Modifié le', value: dateTime(product.updated_at) },
                                    { label: 'Suivi de stock', value: product.track_stock ? t('state.yes') : t('state.no') },
                                ]}
                            />
                        ) : null}
                    </Tabs>

                    <SaveBar
                        dirty={form.isDirty}
                        processing={form.processing}
                        errorCount={Object.keys(form.errors).length}
                        onSave={submit}
                        onCancel={() => form.reset()}
                    />
                </CardBody>
            </Card>
        </AppLayout>
    );
}
