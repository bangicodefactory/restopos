/**
 * `Taxes/Index` — `GET /taxes` (BOF-091).
 *
 * Three things on one screen: the tax list, the editor for the fields
 * `PATCH /taxes/{tax}` accepts, and a **live tax tester**.
 *
 * The tester runs `@domain/tax`'s `computeOrderTaxes` — the TypeScript half of the parity pair
 * described in spec 04, driven by the same fixture corpus as `app/Support/Tax/TaxEngine.php`.
 * There is no server tax-test endpoint in spec 05, and inventing one would mean a second
 * implementation to keep in sync; running the shared engine in the browser gives the same answer
 * the till and the ledger will give, which is the only answer worth showing.
 *
 * `include_base_amount` (compounds forward) and `is_base_affected` (compounds backward) are two
 * independent switches, not one "compound" checkbox — because they genuinely are, and collapsing
 * them is how a compound VAT chain silently changes value.
 */

import { computeOrderTaxes } from '@domain/tax/engine';
import type { Currency, TaxDefinition } from '@domain/tax/types';
import { Head, useForm } from '@inertiajs/react';
import { Button, cn } from '@shared/ui';
import { useMemo, useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { NumberField, SelectField, TextField, ToggleField } from '../../components/form';
import { FormSection, MoneyField, type Option } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { ConfirmAction } from '../../components/ui/ConfirmAction';
import { Badge, Card, CardBody, CardHeader, DefinitionList, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { EUR, money, percent } from '../../lib/money';
import { useGuardedDelete } from '../../lib/guardedRequest';
import { routes } from '../../lib/routes';

import type { TaxGroupRow, TaxRow, TaxesIndexProps } from './types';

const TEST_CURRENCY: Currency = { code: 'EUR', decimalPlaces: 2, rounding: '0.01' };

export default function TaxesIndex({ taxes, groups }: TaxesIndexProps): JSX.Element {
    const t = useT();
    const [search, setSearch] = useState('');
    const [selectedId, setSelectedId] = useState<number | null>(taxes[0]?.id ?? null);
    const [testIds, setTestIds] = useState<number[]>(taxes[0] ? [taxes[0].id] : []);

    const selected = taxes.find((tax) => tax.id === selectedId) ?? null;
    const groupName = (id: number): string => groups.find((group) => group.id === id)?.name ?? `#${id}`;

    const columns: Column<TaxRow>[] = [
        {
            id: 'name',
            header: t('tax.title'),
            locked: true,
            cell: (row) => (
                <button
                    type="button"
                    onClick={() => setSelectedId(row.id)}
                    className="text-start font-medium text-brand-700 hover:underline"
                >
                    {row.name}
                </button>
            ),
            sortValue: (row) => row.name,
            searchValue: (row) => `${row.name} ${row.description ?? ''}`,
            exportValue: (row) => row.name,
        },
        {
            id: 'amount',
            header: 'Taux',
            align: 'end',
            cell: (row) => (
                <span className="font-semibold tabular-nums">
                    {row.amount_type === 'percent' ? percent(row.amount) : money(row.amount, EUR)}
                </span>
            ),
            sortValue: (row) => Number(row.amount),
            exportValue: (row) => row.amount,
        },
        {
            id: 'amount_type',
            header: t('tax.amountType'),
            cell: (row) => <Badge>{row.amount_type}</Badge>,
            sortValue: (row) => row.amount_type,
            exportValue: (row) => row.amount_type,
        },
        {
            id: 'group',
            header: t('tax.groups'),
            cell: (row) => groupName(row.tax_group_id),
            sortValue: (row) => groupName(row.tax_group_id),
            searchValue: (row) => groupName(row.tax_group_id),
            exportValue: (row) => groupName(row.tax_group_id),
        },
        {
            id: 'price_include',
            header: t('tax.priceInclude'),
            align: 'center',
            cell: (row) => <Badge tone={row.price_include ? 'info' : 'neutral'}>{row.price_include ? 'TTC' : 'HT'}</Badge>,
            sortValue: (row) => row.price_include,
            exportValue: (row) => (row.price_include ? 'TTC' : 'HT'),
        },
        {
            id: 'compound',
            header: 'Composition',
            defaultHidden: true,
            cell: (row) => (
                <span className="flex flex-wrap gap-1">
                    {row.include_base_amount ? <Badge tone="warn">→ base suivante</Badge> : null}
                    {row.is_base_affected ? <Badge tone="warn">← base précédente</Badge> : null}
                    {row.has_negative_factor ? <Badge tone="danger">négative</Badge> : null}
                </span>
            ),
            exportValue: (row) =>
                [row.include_base_amount ? 'include_base' : '', row.is_base_affected ? 'base_affected' : '']
                    .filter(Boolean)
                    .join(' '),
        },
        {
            id: 'sequence',
            header: t('category.sequence'),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{row.sequence}</span>,
            sortValue: (row) => row.sequence,
            exportValue: (row) => row.sequence,
        },
        {
            id: 'active',
            header: t('state.active'),
            align: 'center',
            cell: (row) => (
                <Badge tone={row.active ? 'ok' : 'neutral'}>{row.active ? t('state.active') : t('state.inactive')}</Badge>
            ),
            sortValue: (row) => row.active,
            exportValue: (row) => (row.active ? '1' : '0'),
        },
        {
            id: 'test',
            header: '',
            align: 'end',
            cell: (row) => (
                <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                    <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300"
                        checked={testIds.includes(row.id)}
                        onChange={(event) =>
                            setTestIds((current) =>
                                event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id),
                            )
                        }
                    />
                    {t('tax.tester')}
                </label>
            ),
        },
    ];

    return (
        <AppLayout title={t('tax.title')}>
            <Head title={t('tax.title')} />

            <div className="space-y-6">
                <DataTable
                    columns={columns}
                    rows={taxes}
                    getRowId={(row) => row.id}
                    storageKey="taxes"
                    caption={t('tax.title')}
                    search={{ value: search, onChange: setSearch }}
                    exportFilename="taxes"
                    perPage={50}
                />

                <div className="grid gap-6 lg:grid-cols-2">
                    {selected ? <TaxEditor key={selected.id} tax={selected} groups={groups} /> : null}
                    <TaxTester taxes={taxes} selectedIds={testIds} />
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                    <AddTax groups={groups} />
                    <TaxGroups groups={groups} />
                </div>

                <Notice tone="info">{t('tax.fiscalPositionsMissing')}</Notice>
            </div>
        </AppLayout>
    );
}

/**
 * Adding a tax (BOF-091).
 *
 * `tax_group_id` is required and `taxes.tax_group_id` is a `restrictOnDelete` foreign key, so this
 * form is only usable once a group exists — which is why the group panel sits beside it rather than
 * on a screen of its own.
 */
function AddTax({ groups }: { groups: TaxGroupRow[] }): JSX.Element {
    const t = useT();

    const form = useForm<{
        name: string;
        tax_group_id: number | null;
        amount_type: string;
        amount: string;
        price_include: boolean;
    }>({
        name: '',
        tax_group_id: groups[0]?.id ?? null,
        amount_type: 'percent',
        amount: '0',
        price_include: false,
    });

    return (
        <Card>
            <CardHeader title={t('tax.add')} />
            <CardBody className="space-y-4">
                {groups.length === 0 ? <Notice tone="warn">{t('tax.addGroup')}</Notice> : null}

                <FormSection>
                    <TextField
                        label={t('tax.name')}
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <SelectField
                        label={t('tax.group')}
                        value={form.data.tax_group_id === null ? '' : String(form.data.tax_group_id)}
                        error={form.errors.tax_group_id}
                        options={groupOptions(groups)}
                        onChange={(value) => form.setData('tax_group_id', Number(value))}
                    />
                    <SelectField
                        label={t('tax.amountType')}
                        value={form.data.amount_type}
                        error={form.errors.amount_type}
                        options={amountTypeOptions(t)}
                        onChange={(value) => form.setData('amount_type', value)}
                    />
                    {form.data.amount_type === 'percent' ? (
                        <NumberField
                            label={t('tax.rate')}
                            suffix="%"
                            step={0.1}
                            value={Number(form.data.amount)}
                            error={form.errors.amount}
                            onChange={(value) => form.setData('amount', String(value ?? 0))}
                        />
                    ) : (
                        <MoneyField
                            label={t('tax.amount')}
                            value={form.data.amount}
                            error={form.errors.amount}
                            onChange={(value) => form.setData('amount', value)}
                        />
                    )}
                </FormSection>

                <ToggleField
                    label={t('tax.priceInclude')}
                    checked={form.data.price_include}
                    onChange={(checked) => form.setData('price_include', checked)}
                />

                <Button
                    loading={form.processing}
                    disabled={form.data.name.trim() === '' || form.data.tax_group_id === null}
                    onClick={() =>
                        form.post(routes.taxes.store(), {
                            preserveScroll: true,
                            onSuccess: () => form.reset(),
                        })
                    }
                >
                    {t('tax.add')}
                </Button>
            </CardBody>
        </Card>
    );
}

/**
 * Tax groups — the heading a tax totals under on a receipt and on the session report.
 *
 * Editable in place rather than on their own screen: a group is three fields and only ever exists to
 * be pointed at from the tax editor. Deleting one is refused while it still holds taxes or appears
 * on a closed session's summary, and there is no deactivate fallback — a group has no `active`
 * column, so an unwanted one is left empty.
 */
function TaxGroups({ groups }: { groups: TaxGroupRow[] }): JSX.Element {
    const t = useT();
    const remove = useGuardedDelete();
    const form = useForm<{ name: string; receipt_label: string }>({ name: '', receipt_label: '' });

    return (
        <Card>
            <CardHeader title={t('tax.groups')} />
            <CardBody className="space-y-4">
                <table className="w-full border-collapse text-sm">
                    <caption className="sr-only">{t('tax.groups')}</caption>
                    <thead className="bg-slate-50">
                        <tr>
                            <th scope="col" className="px-3 py-2 text-start text-xs uppercase text-slate-600">
                                {t('tax.name')}
                            </th>
                            <th scope="col" className="px-3 py-2 text-start text-xs uppercase text-slate-600">
                                {t('tax.receiptLabel')}
                            </th>
                            <th scope="col" className="px-3 py-2 text-end text-xs uppercase text-slate-600">
                                <span className="sr-only">{t('action.delete')}</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {groups.map((group) => (
                            <tr key={group.id}>
                                <td className="px-3 py-2">{group.name}</td>
                                <td className="px-3 py-2 text-slate-600">{group.receipt_label ?? '—'}</td>
                                <td className="px-3 py-2 text-end">
                                    <ConfirmAction
                                        size="sm"
                                        label={t('tax.removeGroup')}
                                        title={t('tax.removeGroup')}
                                        message={t('tax.removeGroupConfirm', { name: group.name })}
                                        onConfirm={() => remove(routes.taxGroups.destroy(group.id))}
                                    />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                <FormSection>
                    <TextField
                        label={t('tax.name')}
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <TextField
                        label={t('tax.receiptLabel')}
                        value={form.data.receipt_label}
                        error={form.errors.receipt_label}
                        onChange={(value) => form.setData('receipt_label', value)}
                    />
                </FormSection>

                <Button
                    loading={form.processing}
                    disabled={form.data.name.trim() === ''}
                    onClick={() =>
                        form.post(routes.taxGroups.store(), {
                            preserveScroll: true,
                            onSuccess: () => form.reset(),
                        })
                    }
                >
                    {t('tax.addGroup')}
                </Button>
            </CardBody>
        </Card>
    );
}

/** The four kinds of tax the engine implements, and the three rounding strategies. */
function amountTypeOptions(t: ReturnType<typeof useT>): Option[] {
    return [
        { value: 'percent', label: t('tax.amountTypePercent') },
        { value: 'fixed', label: t('tax.amountTypeFixed') },
        { value: 'division', label: t('tax.amountTypeDivision') },
        { value: 'group', label: t('tax.amountTypeGroup') },
    ];
}

function roundingOptions(t: ReturnType<typeof useT>): Option[] {
    return [
        { value: 'inherit', label: t('tax.roundingInherit') },
        { value: 'round_per_line', label: t('tax.roundingPerLine') },
        { value: 'round_globally', label: t('tax.roundingGlobal') },
    ];
}

function groupOptions(groups: TaxGroupRow[]): Option[] {
    return groups.map((group) => ({ value: String(group.id), label: group.name }));
}

function TaxEditor({ tax, groups }: { tax: TaxRow; groups: TaxGroupRow[] }): JSX.Element {
    const t = useT();
    const remove = useGuardedDelete();

    const form = useForm<{
        name: string;
        description: string;
        tax_group_id: number;
        amount_type: string;
        amount: string;
        price_include: boolean;
        include_base_amount: boolean;
        is_base_affected: boolean;
        has_negative_factor: boolean;
        sequence: number | null;
        rounding_strategy: string;
        active: boolean;
    }>({
        name: tax.name,
        description: tax.description ?? '',
        tax_group_id: tax.tax_group_id,
        amount_type: tax.amount_type,
        amount: tax.amount,
        price_include: tax.price_include,
        include_base_amount: tax.include_base_amount,
        is_base_affected: tax.is_base_affected,
        has_negative_factor: tax.has_negative_factor,
        sequence: tax.sequence,
        rounding_strategy: tax.rounding_strategy,
        active: tax.active,
    });

    return (
        <Card>
            <CardHeader title={tax.name} description={groups.find((group) => group.id === tax.tax_group_id)?.name} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('tax.name')}
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <TextField
                        label={t('tax.shortLabel')}
                        value={form.data.description}
                        error={form.errors.description}
                        onChange={(value) => form.setData('description', value)}
                    />
                    <SelectField
                        label={t('tax.group')}
                        value={String(form.data.tax_group_id)}
                        error={form.errors.tax_group_id}
                        options={groupOptions(groups)}
                        onChange={(value) => form.setData('tax_group_id', Number(value))}
                    />
                    <SelectField
                        label={t('tax.amountType')}
                        value={form.data.amount_type}
                        error={form.errors.amount_type}
                        options={amountTypeOptions(t)}
                        onChange={(value) => form.setData('amount_type', value)}
                    />
                    {/*
                      * The rate field follows the *edited* kind, not the stored one — switching to
                      * "fixed" before saving must show a money field, or the operator types 20 meaning
                      * 20 cents into a control still labelled %.
                      */}
                    {form.data.amount_type === 'percent' ? (
                        <NumberField
                            label={t('tax.rate')}
                            suffix="%"
                            step={0.1}
                            value={Number(form.data.amount)}
                            error={form.errors.amount}
                            onChange={(value) => form.setData('amount', String(value ?? 0))}
                        />
                    ) : (
                        <MoneyField
                            label={t('tax.amount')}
                            value={form.data.amount}
                            error={form.errors.amount}
                            onChange={(value) => form.setData('amount', value)}
                        />
                    )}
                    <NumberField
                        label={t('category.sequence')}
                        value={form.data.sequence}
                        error={form.errors.sequence}
                        onChange={(value) => form.setData('sequence', value)}
                        hint={t('tax.sequenceHint')}
                    />
                    <SelectField
                        label={t('tax.rounding')}
                        value={form.data.rounding_strategy}
                        error={form.errors.rounding_strategy}
                        options={roundingOptions(t)}
                        onChange={(value) => form.setData('rounding_strategy', value)}
                    />
                </FormSection>

                <div className="space-y-3">
                    <ToggleField
                        label={t('tax.priceInclude')}
                        checked={form.data.price_include}
                        onChange={(checked) => form.setData('price_include', checked)}
                    />
                    <ToggleField
                        label={t('tax.includeBase')}
                        checked={form.data.include_base_amount}
                        onChange={(checked) => form.setData('include_base_amount', checked)}
                        description={t('tax.includeBaseHint')}
                    />
                    <ToggleField
                        label={t('tax.baseAffected')}
                        checked={form.data.is_base_affected}
                        onChange={(checked) => form.setData('is_base_affected', checked)}
                        description={t('tax.baseAffectedHint')}
                    />
                    <ToggleField
                        label={t('tax.negativeFactor')}
                        checked={form.data.has_negative_factor}
                        onChange={(checked) => form.setData('has_negative_factor', checked)}
                        description={t('tax.negativeFactorHint')}
                    />
                    <ToggleField
                        label={t('state.active')}
                        checked={form.data.active}
                        onChange={(checked) => form.setData('active', checked)}
                    />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        loading={form.processing}
                        disabled={!form.isDirty}
                        onClick={() => form.patch(routes.taxes.update(tax.id), { preserveScroll: true })}
                    >
                        {t('action.save')}
                    </Button>
                    <Button variant="ghost" disabled={!form.isDirty} onClick={() => form.reset()}>
                        {t('action.cancel')}
                    </Button>
                    <div className="ms-auto">
                        {/*
                          * Confirmed by name, because the answer is usually "deactivate". The server
                          * refuses outright once a product, a fiscal position, a compound chain, an
                          * open tab or a closed report points at the tax, and says which — so this
                          * button succeeds only for a tax nothing has used yet.
                          */}
                        <ConfirmAction
                            label={t('tax.remove')}
                            title={t('tax.remove')}
                            message={t('tax.removeConfirm', { name: tax.name })}
                            confirmPhrase={tax.name}
                            onConfirm={() => remove(routes.taxes.destroy(tax.id))}
                        />
                    </div>
                </div>
            </CardBody>
        </Card>
    );
}

function TaxTester({ taxes, selectedIds }: { taxes: TaxRow[]; selectedIds: number[] }): JSX.Element {
    const t = useT();
    const [priceUnit, setPriceUnit] = useState('10.00');
    const [qty, setQty] = useState<number | null>(1);

    const definitions = useMemo<TaxDefinition[]>(
        () =>
            taxes
                .filter((tax) => selectedIds.includes(tax.id))
                .map((tax) => ({
                    id: tax.id,
                    name: tax.name,
                    amountType: asAmountType(tax.amount_type),
                    amount: tax.amount,
                    priceInclude: tax.price_include,
                    includeBaseAmount: tax.include_base_amount,
                    isBaseAffected: tax.is_base_affected,
                    hasNegativeFactor: tax.has_negative_factor,
                    sequence: tax.sequence,
                    taxGroupId: tax.tax_group_id,
                })),
        [selectedIds, taxes],
    );

    const result = useMemo(() => {
        if (definitions.length === 0) return null;
        try {
            return computeOrderTaxes({
                currency: TEST_CURRENCY,
                taxes: definitions,
                lines: [
                    {
                        id: 'test',
                        quantity: String(qty ?? 0),
                        priceUnit: priceUnit === '' ? '0' : priceUnit,
                        taxIds: definitions.map((definition) => definition.id),
                    },
                ],
            });
        } catch {
            return null;
        }
    }, [definitions, priceUnit, qty]);

    return (
        <Card>
            <CardHeader title={t('tax.tester')} description={t('tax.testerHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <MoneyField label={t('tax.testBase')} value={priceUnit} onChange={setPriceUnit} />
                    <NumberField label={t('tax.testQty')} value={qty} min={0} step={1} onChange={setQty} />
                </FormSection>

                {definitions.length === 0 ? (
                    <Notice tone="info">Cochez une ou plusieurs taxes dans la liste ci-dessus.</Notice>
                ) : result === null ? (
                    <Notice tone="danger">{t('state.error')}</Notice>
                ) : (
                    <>
                        <ul className="flex flex-wrap gap-1">
                            {definitions.map((definition) => (
                                <li key={definition.id}>
                                    <Badge tone="brand">{definition.name}</Badge>
                                </li>
                            ))}
                        </ul>

                        <DefinitionList
                            columns={3}
                            items={[
                                { label: t('tax.testResultExcl'), value: money(result.totals.totalExcluded, EUR) },
                                { label: t('tax.testResultTax'), value: money(result.totals.totalTax, EUR) },
                                {
                                    label: t('tax.testResultIncl'),
                                    value: (
                                        <span className="text-lg font-bold">
                                            {money(result.totals.totalIncluded, EUR)}
                                        </span>
                                    ),
                                },
                            ]}
                        />

                        <table className="w-full border-collapse text-sm">
                            <caption className="sr-only">{t('order.taxes')}</caption>
                            <thead className="bg-slate-50">
                                <tr>
                                    <th scope="col" className="px-3 py-1.5 text-start text-xs uppercase text-slate-600">
                                        Taxe
                                    </th>
                                    <th scope="col" className="px-3 py-1.5 text-end text-xs uppercase text-slate-600">
                                        {t('report.base')}
                                    </th>
                                    <th scope="col" className="px-3 py-1.5 text-end text-xs uppercase text-slate-600">
                                        {t('report.taxAmount')}
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {(result.lines[0]?.taxes ?? []).map((line) => (
                                    <tr key={line.taxId}>
                                        <td className={cn('px-3 py-1.5')}>
                                            {taxes.find((tax) => tax.id === line.taxId)?.name ?? `#${line.taxId}`}
                                        </td>
                                        <td className="px-3 py-1.5 text-end tabular-nums">{money(line.base, EUR)}</td>
                                        <td className="px-3 py-1.5 text-end tabular-nums">{money(line.amount, EUR)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </>
                )}
            </CardBody>
        </Card>
    );
}

function asAmountType(value: string): TaxDefinition['amountType'] {
    return value === 'fixed' || value === 'division' || value === 'group' ? value : 'percent';
}
