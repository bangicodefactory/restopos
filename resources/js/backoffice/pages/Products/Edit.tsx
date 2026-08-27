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
    MoneyField,
    MultiSelectField,
    SaveBar,
    SelectField,
    TextField,
    TextareaField,
    ToggleField,
    useDirtyGuard,
} from '../../components/form';
import { FormRow, FormSection } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { DeleteAction } from '../../components/ui/DeleteAction';
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
import { EUR, money, percent, subtractMoney, toDecimal } from '../../lib/money';
import { routes } from '../../lib/routes';

import { PRODUCT_TYPE_OPTIONS } from './types';
import { AttributeLines } from './AttributeLines';
import { VariantGrid } from './VariantGrid';

import type { ProductEditProps } from './types';

type ProductForm = {
    name: string;
    default_code: string;
    barcode: string;
    list_price: string;
    standard_price: string;
    product_type: string;
    product_category_id: number | null;
    uom_id: number;
    available_in_pos: boolean;
    self_order_available: boolean;
    sale_ok: boolean;
    active: boolean;
    to_weight: boolean;
    track_stock: boolean;
    allow_negative_stock: boolean;
    description_sale: string;
    public_description: string;
    internal_note: string;
    color: number;
    pos_sequence: number;
    is_favorite: boolean;
    pos_category_ids: number[];
    tax_ids: number[];
};

export default function ProductEdit({ product, options }: ProductEditProps): JSX.Element {
    const t = useT();
    const [tab, setTab] = useState('general');

    const initial: ProductForm = useMemo(
        () => ({
            name: product.name,
            default_code: product.default_code ?? '',
            barcode: product.barcode ?? '',
            list_price: product.list_price,
            standard_price: product.standard_price,
            product_type: product.product_type,
            product_category_id: product.product_category_id,
            uom_id: product.uom_id,
            to_weight: product.to_weight,
            track_stock: product.track_stock,
            allow_negative_stock: product.allow_negative_stock,
            sale_ok: product.sale_ok,
            description_sale: product.description_sale ?? '',
            public_description: product.public_description ?? '',
            internal_note: product.internal_note ?? '',
            color: product.color,
            pos_sequence: product.pos_sequence,
            is_favorite: product.is_favorite,
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
        form.patch(routes.products.update(product.uuid), { preserveScroll: true });
    }, [form, product.uuid]);

    const marginAmount = subtractMoney(form.data.list_price, form.data.standard_price);
    const marginPercent = toDecimal(form.data.list_price).isZero()
        ? '0'
        : toDecimal(marginAmount).div(toDecimal(form.data.list_price), 6).mul('100').toString();

    const tabs: TabItem[] = [
        { id: 'general', label: t('config.group.general') },
        { id: 'pricing', label: t('product.pricing') },
        { id: 'variants', label: t('product.variants'), badge: <Badge>{product.variants.length}</Badge> },
        { id: 'options', label: t('attribute.title') },
        { id: 'combos', label: t('product.combos') },
        { id: 'meta', label: t('order.audit') },
    ];

    return (
        <AppLayout
            title={product.name}
            breadcrumbs={[{ label: t('product.title'), href: routes.products.index() }]}
            actions={
                <span className="flex items-center gap-2">
                    <Badge tone={product.available_in_pos ? 'ok' : 'neutral'}>{t('product.availableInPos')}</Badge>
                    {product.is_special ? <Badge tone="warn">{product.special_kind}</Badge> : null}
                    {/*
                      * Archive, never erase: every sold line holds `product_id` under
                      * `restrictOnDelete`. The server also refuses while a session is open, and
                      * `DeleteAction` is what puts that reason on screen rather than reloading.
                      */}
                    <DeleteAction
                        size="md"
                        label={t('product.archive')}
                        message={t('product.archiveConfirm', { name: product.name })}
                        url={routes.products.destroy(product.uuid)}
                        name={product.name}
                    />
                </span>
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
                                <DeferredRegion value={options} label={t('product.uom')}>
                                    {(value) => (
                                        <SelectField
                                            label={t('product.uom')}
                                            value={String(form.data.uom_id)}
                                            error={form.errors.uom_id}
                                            options={value.uoms.map((uom) => ({
                                                value: String(uom.id),
                                                label: uom.name,
                                            }))}
                                            onChange={(next) => form.setData('uom_id', Number(next))}
                                        />
                                    )}
                                </DeferredRegion>
                                <SelectField
                                    label={t('product.type')}
                                    value={form.data.product_type}
                                    error={form.errors.product_type}
                                    options={PRODUCT_TYPE_OPTIONS}
                                    onChange={(value) => form.setData('product_type', value)}
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
                                    label={t('product.toWeight')}
                                    checked={form.data.to_weight}
                                    onChange={(checked) => form.setData('to_weight', checked)}
                                    hint={t('product.toWeightHint')}
                                />
                                <ToggleField
                                    label={t('product.trackStock')}
                                    checked={form.data.track_stock}
                                    onChange={(checked) => form.setData('track_stock', checked)}
                                />
                                <ToggleField
                                    label={t('product.allowNegativeStock')}
                                    checked={form.data.allow_negative_stock}
                                    onChange={(checked) => form.setData('allow_negative_stock', checked)}
                                    disabled={!form.data.track_stock}
                                />
                                <ToggleField
                                    label={t('product.saleOk')}
                                    checked={form.data.sale_ok}
                                    onChange={(checked) => form.setData('sale_ok', checked)}
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

                                {/*
                                  * No image control at all, rather than a locked one. The app has no
                                  * media *upload* route - only `GET /api/media/{id}` to serve one -
                                  * so a picker would offer a choice of nothing, and a greyed field
                                  * suggests a permission you might be granted rather than a feature
                                  * that does not exist. BAN-393 owns that pipeline.
                                  */}
                                <FormRow>
                                    <Notice tone="info">{t('product.imageMissing')}</Notice>
                                </FormRow>

                                <FormRow>
                                    <TextareaField
                                        label={t('product.descriptionSale')}
                                        value={form.data.description_sale}
                                        error={form.errors.description_sale}
                                        onChange={(value) => form.setData('description_sale', value)}
                                        rows={3}
                                    />
                                </FormRow>

                                <FormRow>
                                    <TextareaField
                                        label={t('product.publicDescription')}
                                        value={form.data.public_description}
                                        error={form.errors.public_description}
                                        onChange={(value) => form.setData('public_description', value)}
                                        rows={3}
                                        hint={t('product.publicDescriptionHint')}
                                    />
                                </FormRow>

                                <FormRow>
                                    <TextareaField
                                        label={t('product.internalNote')}
                                        value={form.data.internal_note}
                                        error={form.errors.internal_note}
                                        onChange={(value) => form.setData('internal_note', value)}
                                        rows={2}
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
                            <VariantGrid productUuid={product.uuid} variants={product.variants} />
                        ) : null}

                        {tab === 'options' ? (
                            <DeferredRegion value={options} label={t('attribute.title')} rows={3}>
                                {(value) => (
                                    <AttributeLines
                                        productUuid={product.uuid}
                                        lines={product.attribute_lines}
                                        attributes={value.attributes}
                                    />
                                )}
                            </DeferredRegion>
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
