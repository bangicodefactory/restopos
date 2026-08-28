/**
 * `Pricelists/Edit` — `GET /pricelists/{pricelist}/edit` (BOF-090).
 *
 * The header (name, sequence, currency, active) is editable, and since BAN-401 so are the rules:
 * `POST/PATCH/DELETE /pricelists/{pricelist}/items` exist, so happy hour or a category markdown can
 * be set up here instead of in a shell. Before that this screen was a read-only explorer, because
 * the contract exposed no write for `pricelist_items` at all.
 *
 * What the explorer got right is kept: the thing operators actually need from this table is
 * understanding *which* rule wins. So the rules are ordered by real resolution order — applied-on specificity first
 * (variant → product → category → global), sequence as the tie-break — and each row shows its
 * compute mode, its base and whether its date window is currently in force. "Why is this price
 * not applying" is answerable from this screen without opening a shell.
 */

import { Head, router, useForm } from '@inertiajs/react';
import { Button } from '@shared/ui';
import { useMemo, useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { NumberField, SaveBar, TextField, ToggleField, useDirtyGuard } from '../../components/form';
import { DateField, FormSection, MoneyField, NumberField as QtyField, SelectField } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, Card, CardBody, CardHeader } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { date } from '../../lib/format';
import { EUR, money, percent, quantity } from '../../lib/money';
import { routes } from '../../lib/routes';

import {
    APPLIED_ON_LABEL,
    APPLIED_ON_RANK,
    BASE_LABEL,
    COMPUTE_LABEL,
    windowState,
    type PricelistEditProps,
    type PricelistItemRecord,
} from './types';

export default function PricelistEdit({
    pricelist,
    items,
    products,
    categories,
}: PricelistEditProps): JSX.Element {
    const t = useT();
    const [search, setSearch] = useState('');

    const form = useForm<{ name: string; currency_id: number; sequence: number | null; active: boolean }>({
        name: pricelist.name,
        currency_id: pricelist.currency_id,
        sequence: pricelist.sequence,
        active: pricelist.active,
    });

    useDirtyGuard(form.isDirty, t('confirm.leave'));

    /** Resolution order: specificity, then sequence, then id — the order the engine walks. */
    const ordered = useMemo(
        () =>
            [...items].sort(
                (a, b) =>
                    APPLIED_ON_RANK[a.applied_on] - APPLIED_ON_RANK[b.applied_on] ||
                    a.sequence - b.sequence ||
                    a.id - b.id,
            ),
        [items],
    );

    const columns: Column<PricelistItemRecord>[] = [
        {
            id: 'rank',
            header: t('pricelist.precedence'),
            align: 'end',
            locked: true,
            cell: (row) => (
                <span className="tabular-nums text-slate-500">
                    {APPLIED_ON_RANK[row.applied_on]}.{String(row.sequence).padStart(3, '0')}
                </span>
            ),
            sortValue: (row) => APPLIED_ON_RANK[row.applied_on] * 10_000 + row.sequence,
            exportValue: (row) => `${APPLIED_ON_RANK[row.applied_on]}.${row.sequence}`,
        },
        {
            id: 'applied_on',
            header: t('pricelist.appliedOn'),
            cell: (row) => (
                <span className="flex flex-col">
                    <Badge tone="brand">{APPLIED_ON_LABEL[row.applied_on]}</Badge>
                    <span className="mt-0.5 text-xs text-slate-500">{targetOf(row)}</span>
                </span>
            ),
            sortValue: (row) => APPLIED_ON_RANK[row.applied_on],
            searchValue: (row) => `${APPLIED_ON_LABEL[row.applied_on]} ${targetOf(row)}`,
            exportValue: (row) => `${APPLIED_ON_LABEL[row.applied_on]} ${targetOf(row)}`,
        },
        {
            id: 'compute',
            header: t('pricelist.computeMode'),
            cell: (row) => (
                <span className="flex flex-col">
                    <span className="font-medium">{COMPUTE_LABEL[row.compute_price]}</span>
                    <span className="text-xs text-slate-500">{computeSummary(row)}</span>
                </span>
            ),
            sortValue: (row) => row.compute_price,
            searchValue: (row) => COMPUTE_LABEL[row.compute_price],
            exportValue: (row) => `${COMPUTE_LABEL[row.compute_price]} — ${computeSummary(row)}`,
        },
        {
            id: 'base',
            header: 'Base',
            defaultHidden: true,
            cell: (row) => BASE_LABEL[row.base],
            sortValue: (row) => row.base,
            exportValue: (row) => BASE_LABEL[row.base],
        },
        {
            id: 'min_quantity',
            header: t('pricelist.minQty'),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{quantity(row.min_quantity)}</span>,
            sortValue: (row) => Number(row.min_quantity),
            exportValue: (row) => row.min_quantity,
        },
        {
            id: 'remove',
            header: '',
            exportValue: () => '',
            cell: (row) => (
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                        router.delete(routes.pricelistItems.destroy(pricelist.id, row.id), {
                            preserveScroll: true,
                        })
                    }
                >
                    {t('action.delete')}
                </Button>
            ),
        },
        {
            id: 'window',
            header: t('pricelist.window'),
            cell: (row) => {
                const state = windowState(row);
                return (
                    <span className="flex flex-col">
                        <Badge tone={state === 'active' ? 'ok' : state === 'scheduled' ? 'info' : 'neutral'}>
                            {state === 'active' ? t('state.active') : state === 'scheduled' ? 'À venir' : 'Expirée'}
                        </Badge>
                        {row.date_start || row.date_end ? (
                            <span className="mt-0.5 text-xs text-slate-500">
                                {date(row.date_start)} → {date(row.date_end)}
                            </span>
                        ) : null}
                    </span>
                );
            },
            sortValue: (row) => windowState(row),
            exportValue: (row) => `${row.date_start ?? ''} → ${row.date_end ?? ''}`,
        },
        {
            id: 'active',
            header: t('state.active'),
            align: 'center',
            cell: (row) => (
                <Badge tone={row.active ? 'ok' : 'neutral'}>{row.active ? t('state.yes') : t('state.no')}</Badge>
            ),
            sortValue: (row) => row.active,
            exportValue: (row) => (row.active ? '1' : '0'),
        },
    ];

    return (
        <AppLayout
            title={pricelist.name}
            breadcrumbs={[{ label: t('pricelist.title'), href: routes.pricelists.index() }]}
            description={t('pricelist.precedenceHint')}
        >
            <Head title={`${t('pricelist.edit')} — ${pricelist.name}`} />

            <div className="space-y-6">
                <Card>
                    <CardHeader title={t('config.group.general')} />
                    <CardBody>
                        <FormSection>
                            <TextField
                                label="Nom"
                                required
                                value={form.data.name}
                                error={form.errors.name}
                                onChange={(value) => form.setData('name', value)}
                            />
                            <NumberField
                                label={t('category.sequence')}
                                value={form.data.sequence}
                                error={form.errors.sequence}
                                onChange={(value) => form.setData('sequence', value)}
                            />
                            <NumberField
                                label="Devise (id)"
                                value={form.data.currency_id}
                                error={form.errors.currency_id}
                                onChange={(value) => form.setData('currency_id', value ?? 1)}
                                hint="La devise doit rester cohérente avec celle des points de vente qui l’utilisent (BOF-037)."
                            />
                            <ToggleField
                                label={t('state.active')}
                                checked={form.data.active}
                                onChange={(checked) => form.setData('active', checked)}
                            />
                        </FormSection>

                        <SaveBar
                            dirty={form.isDirty}
                            processing={form.processing}
                            errorCount={Object.keys(form.errors).length}
                            onSave={() => form.patch(routes.pricelists.update(pricelist.id), { preserveScroll: true })}
                            onCancel={() => form.reset()}
                        />
                    </CardBody>
                </Card>

                <div className="space-y-3">
                    {/*
                      * The rules were a read-only explorer and there was no endpoint behind them —
                      * "change a price rule" is the most common back-office task in a restaurant and
                      * it could not be done here at all (BAN-401).
                      */}
                    <AddRule pricelist={pricelist} products={products} categories={categories} />

                    <DataTable
                        columns={columns}
                        rows={ordered}
                        getRowId={(row) => row.id}
                        storageKey="pricelist-items"
                        caption={t('pricelist.edit')}
                        search={{ value: search, onChange: setSearch }}
                        exportFilename={`regles-${pricelist.name}`}
                        perPage={50}
                        rowClassName={(row) => (windowState(row) !== 'active' || !row.active ? 'opacity-60' : undefined)}
                    />
                </div>
            </div>
        </AppLayout>
    );
}

function targetOf(item: PricelistItemRecord): string {
    if (item.applied_on === 'variant') return `variante #${item.product_variant_id ?? '—'}`;
    if (item.applied_on === 'product') return `produit #${item.product_id ?? '—'}`;
    if (item.applied_on === 'pos_category') return `catégorie #${item.pos_category_id ?? '—'}`;
    return 'tous les produits';
}

/** One line describing what the rule computes, in the engine's own terms. */
function computeSummary(item: PricelistItemRecord): string {
    if (item.compute_price === 'fixed') return money(item.fixed_price, EUR);
    if (item.compute_price === 'percentage') return `− ${percent(item.percent_price, 2)}`;

    const parts = [`${BASE_LABEL[item.base]} − ${percent(item.price_discount, 2)}`];
    if (Number(item.price_surcharge) !== 0) parts.push(`+ ${money(item.price_surcharge, EUR)}`);
    if (Number(item.price_round) !== 0) parts.push(`arrondi ${item.price_round}`);
    if (Number(item.price_min_margin) !== 0) parts.push(`marge min ${money(item.price_min_margin, EUR)}`);
    if (Number(item.price_max_margin) !== 0) parts.push(`marge max ${money(item.price_max_margin, EUR)}`);
    return parts.join(' ');
}

/**
 * Adding one price rule (BOF-037, BAN-401).
 *
 * The two selects at the top are the ones that matter, and they are separate questions: **what the
 * rule covers** and **how the price is worked out**. The fields below each follow from its choice
 * rather than all being shown at once — a rule form with twenty inputs visible is a form nobody
 * fills in correctly.
 *
 * The empty "computed from" case is the one the server refuses loudest, because a formula rule with
 * no base saves cleanly and prices from the wrong thing.
 */
function AddRule({
    pricelist,
    products,
    categories,
}: {
    pricelist: PricelistEditProps['pricelist'];
    products: PricelistEditProps['products'];
    categories: PricelistEditProps['categories'];
}): JSX.Element {
    const t = useT();
    const [open, setOpen] = useState(false);

    const form = useForm<{
        applied_on: string;
        product_id: number | null;
        pos_category_id: number | null;
        compute_price: string;
        fixed_price: string;
        percent_price: string;
        min_quantity: number | null;
        date_start: string;
        date_end: string;
    }>({
        applied_on: 'global',
        product_id: null,
        pos_category_id: null,
        compute_price: 'percentage',
        fixed_price: '0',
        percent_price: '10',
        min_quantity: 1,
        date_start: '',
        date_end: '',
    });

    if (!open) {
        return (
            <Button variant="ghost" onClick={() => setOpen(true)}>
                {t('pricelist.addRule')}
            </Button>
        );
    }

    return (
        <Card>
            <CardHeader title={t('pricelist.addRule')} description={t('pricelist.addRuleHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <SelectField
                        label={t('pricelist.appliesTo')}
                        value={form.data.applied_on}
                        error={form.errors.applied_on}
                        options={[
                            { value: 'global', label: t('pricelist.scopeGlobal') },
                            { value: 'pos_category', label: t('pricelist.scopeCategory') },
                            { value: 'product', label: t('pricelist.scopeProduct') },
                        ]}
                        onChange={(value) => form.setData('applied_on', value)}
                    />

                    {form.data.applied_on === 'product' ? (
                        <SelectField
                            label={t('pricelist.product')}
                            value={form.data.product_id === null ? '' : String(form.data.product_id)}
                            error={form.errors.product_id}
                            options={products.map((p) => ({ value: String(p.id), label: p.name }))}
                            onChange={(value) => form.setData('product_id', value === '' ? null : Number(value))}
                        />
                    ) : null}

                    {form.data.applied_on === 'pos_category' ? (
                        <SelectField
                            label={t('pricelist.category')}
                            value={form.data.pos_category_id === null ? '' : String(form.data.pos_category_id)}
                            error={form.errors.pos_category_id}
                            options={categories.map((c) => ({ value: String(c.id), label: c.name }))}
                            onChange={(value) =>
                                form.setData('pos_category_id', value === '' ? null : Number(value))
                            }
                        />
                    ) : null}

                    <SelectField
                        label={t('pricelist.howPriced')}
                        value={form.data.compute_price}
                        error={form.errors.compute_price}
                        options={[
                            { value: 'percentage', label: t('pricelist.computePercentage') },
                            { value: 'fixed', label: t('pricelist.computeFixed') },
                        ]}
                        onChange={(value) => form.setData('compute_price', value)}
                    />

                    {form.data.compute_price === 'percentage' ? (
                        <TextField
                            label={t('pricelist.percent')}
                            value={form.data.percent_price}
                            error={form.errors.percent_price}
                            onChange={(value) => form.setData('percent_price', value)}
                        />
                    ) : (
                        <MoneyField
                            label={t('pricelist.fixedPrice')}
                            value={form.data.fixed_price}
                            error={form.errors.fixed_price}
                            onChange={(value) => form.setData('fixed_price', value)}
                        />
                    )}
                </FormSection>

                <FormSection title={t('pricelist.whenItApplies')} description={t('pricelist.whenItAppliesHint')}>
                    <QtyField
                        label={t('pricelist.minQty')}
                        value={form.data.min_quantity}
                        error={form.errors.min_quantity}
                        min={0}
                        onChange={(value) => form.setData('min_quantity', value)}
                    />
                    <DateField
                        label={t('pricelist.from')}
                        value={form.data.date_start}
                        error={form.errors.date_start}
                        onChange={(value) => form.setData('date_start', value)}
                    />
                    <DateField
                        label={t('pricelist.until')}
                        value={form.data.date_end}
                        error={form.errors.date_end}
                        onChange={(value) => form.setData('date_end', value)}
                    />
                </FormSection>

                <div className="flex gap-2">
                    <Button
                        loading={form.processing}
                        onClick={() =>
                            form.post(routes.pricelistItems.store(pricelist.id), {
                                preserveScroll: true,
                                onSuccess: () => {
                                    form.reset();
                                    setOpen(false);
                                },
                            })
                        }
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
