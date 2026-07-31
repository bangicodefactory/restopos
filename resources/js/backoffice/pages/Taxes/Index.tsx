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
import { NumberField, TextField, ToggleField } from '../../components/form';
import { FormSection, MoneyField } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, Card, CardBody, CardHeader, DefinitionList, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { EUR, money, percent } from '../../lib/money';
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

                <Card>
                    <CardHeader title={t('tax.groups')} description="Le libellé de groupe est ce qui s’imprime sur le ticket." />
                    <CardBody className="p-0">
                        <table className="w-full border-collapse text-sm">
                            <caption className="sr-only">{t('tax.groups')}</caption>
                            <thead className="bg-slate-50">
                                <tr>
                                    <th scope="col" className="px-4 py-2 text-start text-xs uppercase text-slate-600">
                                        Nom
                                    </th>
                                    <th scope="col" className="px-4 py-2 text-start text-xs uppercase text-slate-600">
                                        Libellé ticket
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {groups.map((group) => (
                                    <tr key={group.id}>
                                        <td className="px-4 py-2">{group.name}</td>
                                        <td className="px-4 py-2 text-slate-600">{group.receipt_label ?? '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </CardBody>
                </Card>

                <Notice tone="info">{t('tax.fiscalPositionsMissing')}</Notice>
            </div>
        </AppLayout>
    );
}

function TaxEditor({ tax, groups }: { tax: TaxRow; groups: TaxGroupRow[] }): JSX.Element {
    const t = useT();
    const locked = 'Non modifiable : ce champ n’est pas accepté par PATCH /taxes/{id}.';

    const form = useForm<{
        name: string;
        description: string;
        amount: string;
        price_include: boolean;
        include_base_amount: boolean;
        is_base_affected: boolean;
        sequence: number | null;
        active: boolean;
    }>({
        name: tax.name,
        description: tax.description ?? '',
        amount: tax.amount,
        price_include: tax.price_include,
        include_base_amount: tax.include_base_amount,
        is_base_affected: tax.is_base_affected,
        sequence: tax.sequence,
        active: tax.active,
    });

    return (
        <Card>
            <CardHeader title={tax.name} description={groups.find((group) => group.id === tax.tax_group_id)?.name} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label="Nom"
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <TextField
                        label="Libellé court"
                        value={form.data.description}
                        error={form.errors.description}
                        onChange={(value) => form.setData('description', value)}
                    />
                    <TextField label={t('tax.amountType')} value={tax.amount_type} onChange={() => {}} disabled lockedReason={locked} />
                    {tax.amount_type === 'percent' ? (
                        <NumberField
                            label="Taux"
                            suffix="%"
                            step={0.1}
                            value={Number(form.data.amount)}
                            error={form.errors.amount}
                            onChange={(value) => form.setData('amount', String(value ?? 0))}
                        />
                    ) : (
                        <MoneyField
                            label="Montant"
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
                        hint="L’ordre d’évaluation : déterminant pour les taxes composées."
                    />
                    <TextField label={t('tax.rounding')} value={tax.rounding_strategy} onChange={() => {}} disabled lockedReason={locked} />
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
                        description="Le montant de cette taxe entre dans la base des taxes de séquence supérieure."
                    />
                    <ToggleField
                        label={t('tax.baseAffected')}
                        checked={form.data.is_base_affected}
                        onChange={(checked) => form.setData('is_base_affected', checked)}
                        description="Sa base inclut les taxes précédentes qui composent vers l’avant."
                    />
                    <ToggleField
                        label={t('tax.negativeFactor')}
                        checked={tax.has_negative_factor}
                        onChange={() => {}}
                        disabled
                        lockedReason={locked}
                    />
                    <ToggleField
                        label={t('state.active')}
                        checked={form.data.active}
                        onChange={(checked) => form.setData('active', checked)}
                    />
                </div>

                <div className="flex gap-2">
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
