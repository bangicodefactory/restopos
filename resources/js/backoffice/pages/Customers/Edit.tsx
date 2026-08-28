/**
 * `Customers/Edit` — `GET /customers/{customer}/edit` (BOF-119, BAN-453).
 *
 * Three things on one page, in the order a manager asks for them: what this customer owes, what they
 * have bought, and their details.
 *
 * The balance and the order count are **read-only**. They are caches over the account ledger and the
 * orders, and the ledger is the record (`CustomerAccountLedger`) — a field that could type over a
 * debt would let it be cleared with the moves still saying otherwise.
 */

import { Head, router, useForm } from '@inertiajs/react';
import { Button } from '@shared/ui';
import { useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { SaveBar, TextField, ToggleField, useDirtyGuard } from '../../components/form';
import { FormSection, SelectField, TextareaField } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, Card, CardBody, CardHeader, Notice, Stat } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { date } from '../../lib/format';
import { EUR, money } from '../../lib/money';
import { routes } from '../../lib/routes';

import type {
    CustomerAccountMoveRow,
    CustomerEditProps,
    CustomerOrderRow,
    MergeCandidate,
    NamedRow,
} from './types';

export default function CustomerEdit({
    customer,
    orders,
    accountMoves,
    pricelists,
    fiscalPositions,
    countries,
    mergeCandidates,
}: CustomerEditProps): JSX.Element {
    const t = useT();

    const form = useForm<{
        name: string;
        is_company: boolean;
        email: string;
        phone: string;
        mobile: string;
        vat: string;
        street: string;
        street2: string;
        city: string;
        zip: string;
        country_id: string;
        barcode: string;
        pricelist_id: string;
        fiscal_position_id: string;
        marketing_opt_in: boolean;
        note: string;
        active: boolean;
    }>({
        name: customer.name,
        is_company: customer.is_company,
        email: customer.email ?? '',
        phone: customer.phone ?? '',
        mobile: customer.mobile ?? '',
        vat: customer.vat ?? '',
        street: customer.street ?? '',
        street2: customer.street2 ?? '',
        city: customer.city ?? '',
        zip: customer.zip ?? '',
        country_id: customer.country_id === null ? '' : String(customer.country_id),
        barcode: customer.barcode ?? '',
        pricelist_id: customer.pricelist_id === null ? '' : String(customer.pricelist_id),
        fiscal_position_id: customer.fiscal_position_id === null ? '' : String(customer.fiscal_position_id),
        marketing_opt_in: customer.marketing_opt_in,
        note: customer.note ?? '',
        active: customer.active,
    });

    useDirtyGuard(form.isDirty, t('confirm.leave'));

    const optional = (rows: NamedRow[]): { value: string; label: string }[] => [
        { value: '', label: t('customer.none') },
        ...rows.map((row) => ({ value: String(row.id), label: row.name })),
    ];

    const orderColumns: Column<CustomerOrderRow>[] = [
        {
            id: 'ordered_at',
            header: t('customer.orderedAt'),
            locked: true,
            cell: (row) => (row.ordered_at === null ? '—' : date(row.ordered_at)),
            sortValue: (row) => row.ordered_at ?? '',
            exportValue: (row) => row.ordered_at ?? '',
        },
        {
            id: 'tracking_number',
            header: t('customer.orderRef'),
            cell: (row) => row.tracking_number,
            sortValue: (row) => row.tracking_number,
            exportValue: (row) => row.tracking_number,
        },
        {
            id: 'state',
            header: t('state.active'),
            cell: (row) => <Badge tone={row.state === 'cancelled' ? 'neutral' : 'ok'}>{row.state}</Badge>,
            sortValue: (row) => row.state,
            exportValue: (row) => row.state,
        },
        {
            id: 'amount_total',
            header: t('customer.orderTotal'),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{money(row.amount_total, EUR)}</span>,
            sortValue: (row) => Number(row.amount_total),
            exportValue: (row) => row.amount_total,
        },
    ];

    const moveColumns: Column<CustomerAccountMoveRow>[] = [
        {
            id: 'occurred_at',
            header: t('customer.orderedAt'),
            locked: true,
            cell: (row) => (row.occurred_at === null ? '—' : date(row.occurred_at)),
            sortValue: (row) => row.occurred_at ?? '',
            exportValue: (row) => row.occurred_at ?? '',
        },
        {
            id: 'description',
            header: t('customer.moveReason'),
            cell: (row) => row.description ?? row.move_type,
            sortValue: (row) => row.description ?? '',
            exportValue: (row) => row.description ?? row.move_type,
        },
        {
            id: 'amount',
            header: t('customer.moveAmount'),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{money(row.amount, EUR)}</span>,
            sortValue: (row) => Number(row.amount),
            exportValue: (row) => row.amount,
        },
        {
            id: 'balance_after',
            header: t('customer.balanceAfter'),
            align: 'end',
            cell: (row) => <span className="tabular-nums text-slate-500">{money(row.balance_after, EUR)}</span>,
            sortValue: (row) => Number(row.balance_after),
            exportValue: (row) => row.balance_after,
        },
    ];

    return (
        <AppLayout title={customer.name} description={t('customer.hint')}>
            <Head title={customer.name} />

            <div className="space-y-6">
                <Card>
                    <CardBody className="flex flex-wrap gap-8">
                        <Stat label={t('customer.balance')} value={money(customer.account_balance, EUR)} />
                        <Stat label={t('customer.orders')} value={String(customer.order_count)} />
                        <Stat
                            label={t('customer.lastVisit')}
                            value={customer.last_order_at === null ? '—' : date(customer.last_order_at)}
                        />
                        <Stat label={t('customer.points')} value={customer.loyalty_points_cache} />
                    </CardBody>
                </Card>

                <Card>
                    <CardHeader title={t('customer.details')} />
                    <CardBody className="space-y-4">
                        <FormSection>
                            <TextField
                                label={t('customer.name')}
                                value={form.data.name}
                                error={form.errors.name}
                                onChange={(value) => form.setData('name', value)}
                            />
                            <ToggleField
                                label={t('customer.isCompany')}
                                checked={form.data.is_company}
                                onChange={(checked) => form.setData('is_company', checked)}
                            />
                            <TextField
                                label={t('customer.email')}
                                type="email"
                                value={form.data.email}
                                error={form.errors.email}
                                onChange={(value) => form.setData('email', value)}
                            />
                            <TextField
                                label={t('customer.phone')}
                                type="tel"
                                value={form.data.phone}
                                error={form.errors.phone}
                                onChange={(value) => form.setData('phone', value)}
                            />
                            <TextField
                                label={t('customer.mobile')}
                                type="tel"
                                value={form.data.mobile}
                                error={form.errors.mobile}
                                onChange={(value) => form.setData('mobile', value)}
                            />
                            <TextField
                                label={t('customer.vat')}
                                value={form.data.vat}
                                error={form.errors.vat}
                                onChange={(value) => form.setData('vat', value)}
                            />
                        </FormSection>

                        <FormSection title={t('customer.address')}>
                            <TextField
                                label={t('customer.street')}
                                value={form.data.street}
                                error={form.errors.street}
                                onChange={(value) => form.setData('street', value)}
                            />
                            <TextField
                                label={t('customer.street2')}
                                value={form.data.street2}
                                error={form.errors.street2}
                                onChange={(value) => form.setData('street2', value)}
                            />
                            <TextField
                                label={t('customer.zip')}
                                value={form.data.zip}
                                error={form.errors.zip}
                                onChange={(value) => form.setData('zip', value)}
                            />
                            <TextField
                                label={t('customer.city')}
                                value={form.data.city}
                                error={form.errors.city}
                                onChange={(value) => form.setData('city', value)}
                            />
                            <SelectField
                                label={t('customer.country')}
                                value={form.data.country_id}
                                error={form.errors.country_id}
                                options={optional(countries)}
                                onChange={(value) => form.setData('country_id', value)}
                            />
                        </FormSection>

                        <FormSection title={t('customer.commercial')} description={t('customer.commercialHint')}>
                            <SelectField
                                label={t('customer.pricelist')}
                                value={form.data.pricelist_id}
                                error={form.errors.pricelist_id}
                                options={optional(pricelists)}
                                onChange={(value) => form.setData('pricelist_id', value)}
                            />
                            <SelectField
                                label={t('customer.fiscalPosition')}
                                value={form.data.fiscal_position_id}
                                error={form.errors.fiscal_position_id}
                                options={optional(fiscalPositions)}
                                onChange={(value) => form.setData('fiscal_position_id', value)}
                            />
                            <TextField
                                label={t('customer.card')}
                                value={form.data.barcode}
                                error={form.errors.barcode}
                                onChange={(value) => form.setData('barcode', value)}
                            />
                            <ToggleField
                                label={t('customer.marketing')}
                                hint={t('customer.marketingHint')}
                                checked={form.data.marketing_opt_in}
                                error={form.errors.marketing_opt_in}
                                onChange={(checked) => form.setData('marketing_opt_in', checked)}
                            />
                            <ToggleField
                                label={t('state.active')}
                                checked={form.data.active}
                                onChange={(checked) => form.setData('active', checked)}
                            />
                        </FormSection>

                        <TextareaField
                            label={t('customer.note')}
                            value={form.data.note}
                            error={form.errors.note}
                            onChange={(value) => form.setData('note', value)}
                        />

                        <SaveBar
                            dirty={form.isDirty}
                            processing={form.processing}
                            errorCount={Object.keys(form.errors).length}
                            onSave={() => {
                                form.transform((data) => ({
                                    ...data,
                                    country_id: data.country_id === '' ? null : Number(data.country_id),
                                    pricelist_id: data.pricelist_id === '' ? null : Number(data.pricelist_id),
                                    fiscal_position_id:
                                        data.fiscal_position_id === '' ? null : Number(data.fiscal_position_id),
                                    // An emptied text field means "no value", and the columns are
                                    // nullable. Posting an empty string would store one and make
                                    // "no email" and "an email of nothing" two different states.
                                    email: data.email === '' ? null : data.email,
                                    phone: data.phone === '' ? null : data.phone,
                                    mobile: data.mobile === '' ? null : data.mobile,
                                    vat: data.vat === '' ? null : data.vat,
                                    barcode: data.barcode === '' ? null : data.barcode,
                                }));
                                form.patch(routes.customers.update(customer.uuid), { preserveScroll: true });
                            }}
                            onCancel={() => form.reset()}
                        />
                    </CardBody>
                </Card>

                <MergeInto customer={customer} candidates={mergeCandidates} />

                <Card>
                    <CardHeader title={t('customer.history')} />
                    <CardBody>
                        <DataTable
                            columns={orderColumns}
                            rows={orders}
                            getRowId={(row) => row.id}
                            storageKey="customer-orders"
                            caption={t('customer.history')}
                            exportFilename={`commandes-${customer.name}`}
                        />
                    </CardBody>
                </Card>

                {accountMoves.length > 0 ? (
                    <Card>
                        <CardHeader title={t('customer.account')} description={t('customer.accountHint')} />
                        <CardBody>
                            <DataTable
                                columns={moveColumns}
                                rows={accountMoves}
                                getRowId={(row) => row.id}
                                storageKey="customer-account"
                                caption={t('customer.account')}
                                exportFilename={`compte-${customer.name}`}
                            />
                        </CardBody>
                    </Card>
                ) : null}
            </div>
        </AppLayout>
    );
}

/**
 * This record absorbs another.
 *
 * The record on screen is the survivor, and that is stated rather than implied: it keeps its name,
 * its contact details and its price list, and the other is archived. Getting it the wrong way round
 * is not undoable, so the button names both records.
 */
function MergeInto({
    customer,
    candidates,
}: {
    customer: CustomerEditProps['customer'];
    candidates: MergeCandidate[];
}): JSX.Element | null {
    const t = useT();
    const [chosen, setChosen] = useState<string>('');

    if (candidates.length === 0) return null;

    const loser = candidates.find((candidate) => String(candidate.id) === chosen);

    return (
        <Card>
            <CardHeader title={t('customer.merge')} description={t('customer.mergeHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <SelectField
                        label={t('customer.mergeWhich')}
                        value={chosen}
                        options={[
                            { value: '', label: t('customer.none') },
                            ...candidates.map((candidate) => ({
                                value: String(candidate.id),
                                label: `${candidate.name} — ${candidate.why}`,
                            })),
                        ]}
                        onChange={setChosen}
                    />
                </FormSection>

                {loser === undefined ? null : (
                    <>
                        <Notice tone="warn">
                            {t('customer.mergeWarning', { loser: loser.name, survivor: customer.name })}
                        </Notice>
                        <Button
                            variant="danger"
                            onClick={() =>
                                router.post(
                                    routes.customers.merge(customer.uuid),
                                    { loser_id: loser.id },
                                    { preserveScroll: true },
                                )
                            }
                        >
                            {t('customer.mergeConfirm', { loser: loser.name, survivor: customer.name })}
                        </Button>
                    </>
                )}
            </CardBody>
        </Card>
    );
}
