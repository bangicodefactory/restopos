/**
 * `ProductCategories/Index` — `GET /product-categories` (BAN-501).
 *
 * The accounting tree, not the browsing one. A cashier never sees this; an accountant sees nothing
 * else. Its whole reason for existing is `ledger_code` — the revenue account that lands in the
 * `label` column of every sales row in the accounting export (BAN-448).
 *
 * Before this page, that column was settable by the seeder and by direct SQL and by nothing else,
 * so a real venue shipped an export with a blank label on every sales row.
 *
 * A flat, indented list rather than a drag-and-drop tree: this is edited a handful of times a year
 * by somebody reconciling a chart of accounts, and the thing they need is to see every code at once.
 */

import { Head, useForm } from '@inertiajs/react';
import { Button, cn } from '@shared/ui';
import { useMemo, useState, type JSX } from 'react';

import { NumberField, RelationPicker, TextField } from '../../components/form';
import { FormSection } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { DeleteAction } from '../../components/ui/DeleteAction';
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import { parentChoices, type ProductCategoriesIndexProps, type ProductCategoryRow } from './types';

export default function ProductCategoriesIndex({ categories }: ProductCategoriesIndexProps): JSX.Element {
    const t = useT();
    const [selectedId, setSelectedId] = useState<number | null>(categories[0]?.id ?? null);

    const selected = categories.find((category) => category.id === selectedId) ?? null;

    /** Categories carrying no revenue account: their sales export with a blank label. */
    const unlabelled = useMemo(
        () => categories.filter((category) => (category.ledger_code ?? '').trim() === '').length,
        [categories],
    );

    return (
        <AppLayout title={t('productCategory.title')}>
            <Head title={t('productCategory.title')} />

            <div className="space-y-6">
                {unlabelled > 0 ? (
                    <Notice tone="warn" title={t('productCategory.unlabelledTitle')}>
                        {t('productCategory.unlabelled', { count: String(unlabelled) })}
                    </Notice>
                ) : null}

                <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
                    <Card>
                        <CardHeader
                            title={t('productCategory.tree')}
                            description={t('productCategory.treeHint')}
                        />
                        <CardBody className="p-0">
                            {categories.length === 0 ? (
                                <EmptyState title={t('state.empty')} hint={t('productCategory.treeHint')} />
                            ) : (
                                <table className="w-full border-collapse text-sm">
                                    <caption className="sr-only">{t('productCategory.tree')}</caption>
                                    <thead className="bg-slate-50">
                                        <tr>
                                            <th scope="col" className="px-4 py-2 text-start text-xs uppercase text-slate-600">
                                                {t('productCategory.name')}
                                            </th>
                                            <th scope="col" className="px-4 py-2 text-start text-xs uppercase text-slate-600">
                                                {t('productCategory.ledger')}
                                            </th>
                                            <th scope="col" className="px-4 py-2 text-end text-xs uppercase text-slate-600">
                                                {t('productCategory.products')}
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100">
                                        {categories.map((category) => (
                                            <tr
                                                key={category.id}
                                                className={cn(category.id === selectedId && 'bg-brand-50')}
                                            >
                                                <td
                                                    className="px-4 py-2"
                                                    style={{ paddingInlineStart: `${1 + category.depth * 1.5}rem` }}
                                                >
                                                    <button
                                                        type="button"
                                                        onClick={() => setSelectedId(category.id)}
                                                        className="text-start font-medium text-brand-700 hover:underline"
                                                    >
                                                        {category.name}
                                                    </button>
                                                </td>
                                                <td className="px-4 py-2">
                                                    {(category.ledger_code ?? '').trim() === '' ? (
                                                        <Badge tone="warn">{t('productCategory.noLedger')}</Badge>
                                                    ) : (
                                                        <span className="font-mono text-xs">{category.ledger_code}</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-2 text-end tabular-nums">
                                                    {category.product_count}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </CardBody>
                    </Card>

                    <div className="space-y-6">
                        <AddProductCategory categories={categories} />
                        {selected ? (
                            <EditProductCategory
                                key={selected.id}
                                category={selected}
                                categories={categories}
                            />
                        ) : null}
                    </div>
                </div>
            </div>
        </AppLayout>
    );
}

type CategoryFormData = {
    name: string;
    parent_id: number | null;
    sequence: number | null;
    ledger_code: string;
};

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
    categories: ProductCategoryRow[];
    subject: ProductCategoryRow | null;
}): JSX.Element {
    const t = useT();

    return (
        <>
            <TextField
                label={t('productCategory.name')}
                required
                value={data.name}
                error={errors.name}
                onChange={(value) => onChange('name', value)}
            />
            <RelationPicker
                label={t('category.parent')}
                value={data.parent_id}
                options={parentChoices(categories, subject).map((category) => ({
                    value: String(category.id),
                    label: category.name,
                }))}
                onChange={(value) => onChange('parent_id', value)}
            />
            <TextField
                label={t('productCategory.ledger')}
                value={data.ledger_code}
                error={errors.ledger_code}
                onChange={(value) => onChange('ledger_code', value)}
                maxLength={32}
                hint={t('productCategory.ledgerHint')}
            />
            <NumberField
                label={t('category.sequence')}
                value={data.sequence}
                error={errors.sequence}
                onChange={(value) => onChange('sequence', value)}
            />
        </>
    );
}

function AddProductCategory({ categories }: { categories: ProductCategoryRow[] }): JSX.Element {
    const t = useT();
    const form = useForm<CategoryFormData>({ name: '', parent_id: null, sequence: null, ledger_code: '' });

    return (
        <Card>
            <CardHeader title={t('productCategory.add')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <CategoryFields
                        data={form.data}
                        errors={form.errors}
                        onChange={form.setData}
                        categories={categories}
                        subject={null}
                    />
                </FormSection>

                <Button
                    loading={form.processing}
                    disabled={form.data.name.trim() === ''}
                    onClick={() =>
                        form.post(routes.productCategories.store(), {
                            preserveScroll: true,
                            onSuccess: () => form.reset(),
                        })
                    }
                >
                    {t('action.create')}
                </Button>
            </CardBody>
        </Card>
    );
}

function EditProductCategory({
    category,
    categories,
}: {
    category: ProductCategoryRow;
    categories: ProductCategoryRow[];
}): JSX.Element {
    const t = useT();
    const form = useForm<CategoryFormData>({
        name: category.name,
        parent_id: category.parent_id,
        sequence: category.sequence,
        ledger_code: category.ledger_code ?? '',
    });

    return (
        <Card>
            <CardHeader
                title={category.name}
                description={t('productCategory.productsHeld', { count: String(category.product_count) })}
                actions={
                    /*
                     * The server refuses while products are filed here — `product_category_id` is
                     * `nullOnDelete`, so the delete would succeed and silently blank their revenue
                     * account instead. `DeleteAction` is what puts that reason on screen.
                     */
                    <DeleteAction
                        size="md"
                        url={routes.productCategories.destroy(category.id)}
                        name={category.name}
                    />
                }
            />
            <CardBody className="space-y-4">
                <FormSection>
                    <CategoryFields
                        data={form.data}
                        errors={form.errors}
                        onChange={form.setData}
                        categories={categories}
                        subject={category}
                    />
                </FormSection>

                <div className="flex gap-2">
                    <Button
                        loading={form.processing}
                        disabled={!form.isDirty}
                        onClick={() =>
                            form.patch(routes.productCategories.update(category.id), { preserveScroll: true })
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
