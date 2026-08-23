/**
 * `PosBills/Index` — `GET /pos-bills` (BOF-111).
 *
 * The coins and notes the venue actually handles. This is not decoration: the close-session count
 * sheet lists exactly these rows, so a venue whose denominations are wrong gets a sheet that does
 * not match the cash in front of the person counting it — and the variance that produces looks like
 * a till error rather than a settings one.
 *
 * The controller and its routes shipped in #79; this page did not, so `GET /pos-bills` rendered a
 * component that did not exist and the nav entry was disabled. `ReachabilityTest` exists to stop
 * that happening again.
 */

import { Head, useForm } from '@inertiajs/react';
import { Button } from '@shared/ui';
import { useMemo, useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { NumberField, SelectField, TextField } from '../../components/form';
import { FormSection, MoneyField } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { DeleteAction } from '../../components/ui/DeleteAction';
import { Badge, BoolCell, Card, CardBody, CardHeader } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import { DENOMINATION_LABEL, type BillCurrencyRow, type PosBillRow, type PosBillsIndexProps } from './types';

export default function PosBillsIndex({ bills, currencies }: PosBillsIndexProps): JSX.Element {
    const t = useT();
    const [search, setSearch] = useState('');

    const currencyName = useMemo(() => {
        const map = new Map(currencies.map((currency) => [currency.id, currency]));
        return (id: number): string => map.get(id)?.symbol ?? map.get(id)?.name ?? `#${id}`;
    }, [currencies]);

    const columns: Column<PosBillRow>[] = [
        {
            id: 'name',
            header: t('bill.title'),
            locked: true,
            cell: (row) => <span className="font-medium">{row.name}</span>,
            sortValue: (row) => row.name,
            searchValue: (row) => row.name,
            exportValue: (row) => row.name,
        },
        {
            id: 'value',
            header: t('bill.value'),
            align: 'end',
            cell: (row) => (
                <span className="tabular-nums">
                    {row.value} {currencyName(row.currency_id)}
                </span>
            ),
            sortValue: (row) => Number(row.value),
            exportValue: (row) => row.value,
        },
        {
            id: 'denomination_type',
            header: t('bill.kind'),
            cell: (row) => <Badge>{DENOMINATION_LABEL[row.denomination_type] ?? row.denomination_type}</Badge>,
            sortValue: (row) => row.denomination_type,
            exportValue: (row) => row.denomination_type,
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
            cell: (row) => <BoolCell value={row.active} labels={[t('state.yes'), t('state.no')]} />,
            sortValue: (row) => row.active,
            exportValue: (row) => (row.active ? '1' : '0'),
        },
        {
            id: 'actions',
            header: '',
            align: 'end',
            cell: (row) => (
                // Refused once the denomination appears on a closed session's cash count — those
                // figures are what a day's takings were reconciled against.
                <DeleteAction url={routes.posBills.destroy(row.id)} name={row.name} />
            ),
        },
    ];

    return (
        <AppLayout title={t('bill.title')}>
            <Head title={t('bill.title')} />

            <div className="space-y-6">
                <DataTable
                    columns={columns}
                    rows={bills}
                    getRowId={(row) => row.id}
                    storageKey="pos-bills"
                    caption={t('bill.title')}
                    search={{ value: search, onChange: setSearch }}
                    exportFilename="denominations"
                    perPage={50}
                    emptyTitle={t('state.empty')}
                    emptyHint={t('bill.hint')}
                />

                <AddDenomination currencies={currencies} />
            </div>
        </AppLayout>
    );
}

function AddDenomination({ currencies }: { currencies: BillCurrencyRow[] }): JSX.Element {
    const t = useT();

    const form = useForm<{
        name: string;
        value: string;
        denomination_type: string;
        currency_id: number | null;
        sequence: number | null;
    }>({
        name: '',
        value: '0',
        denomination_type: 'bill',
        currency_id: currencies[0]?.id ?? null,
        sequence: null,
    });

    return (
        <Card>
            <CardHeader title={t('bill.add')} description={t('bill.hint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('bill.title')}
                        required
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <MoneyField
                        label={t('bill.value')}
                        value={form.data.value}
                        error={form.errors.value}
                        onChange={(value) => form.setData('value', value)}
                    />
                    <SelectField
                        label={t('bill.kind')}
                        value={form.data.denomination_type}
                        error={form.errors.denomination_type}
                        options={Object.entries(DENOMINATION_LABEL).map(([value, label]) => ({ value, label }))}
                        onChange={(value) => form.setData('denomination_type', value)}
                    />
                    <SelectField
                        label={t('payment.currency')}
                        value={form.data.currency_id === null ? '' : String(form.data.currency_id)}
                        error={form.errors.currency_id}
                        options={currencies.map((currency) => ({
                            value: String(currency.id),
                            label: `${currency.symbol} — ${currency.name}`,
                        }))}
                        onChange={(value) => form.setData('currency_id', Number(value))}
                    />
                    <NumberField
                        label={t('category.sequence')}
                        value={form.data.sequence}
                        error={form.errors.sequence}
                        onChange={(value) => form.setData('sequence', value)}
                    />
                </FormSection>

                <Button
                    loading={form.processing}
                    disabled={form.data.name.trim() === '' || form.data.currency_id === null}
                    onClick={() =>
                        form.post(routes.posBills.store(), {
                            preserveScroll: true,
                            onSuccess: () => form.reset(),
                        })
                    }
                >
                    {t('bill.add')}
                </Button>
            </CardBody>
        </Card>
    );
}
