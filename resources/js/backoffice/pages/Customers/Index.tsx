/**
 * `Customers/Index` — `GET /customers` (BOF-119, BAN-453).
 *
 * The back office had no customer page of any kind: the register's inline picker was the only
 * customer surface in the product, so a phone number could not be corrected and two records of the
 * same regular could not be brought back together.
 *
 * Search runs on the server rather than in the table, because a venue's customer base outgrows a
 * page long before it outgrows the database — and the count under the search box says how much of it
 * this screen is showing, so a cut is never silent.
 */

import { Head, Link, router, useForm } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { FormSection, TextField } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, Card, CardBody, CardHeader, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { date } from '../../lib/format';
import { EUR, money } from '../../lib/money';
import { routes } from '../../lib/routes';

import type { CustomerListRow, CustomersIndexProps } from './types';

export default function CustomersIndex({
    customers,
    search,
    total,
    shown_limit: shownLimit,
    duplicates,
}: CustomersIndexProps): JSX.Element {
    const t = useT();
    const [query, setQuery] = useState(search);

    const columns: Column<CustomerListRow>[] = [
        {
            id: 'name',
            header: t('customer.name'),
            locked: true,
            cell: (row) => (
                <span className="flex items-center gap-2">
                    {row.name}
                    {row.is_company ? <Badge tone="neutral">{t('customer.company')}</Badge> : null}
                </span>
            ),
            sortValue: (row) => row.name,
            searchValue: (row) => row.name,
            exportValue: (row) => row.name,
        },
        {
            id: 'contact',
            header: t('customer.contact'),
            cell: (row) => (
                <span className="flex flex-col">
                    <span>{row.email ?? '—'}</span>
                    <span className="text-xs text-slate-500">{row.mobile ?? row.phone ?? ''}</span>
                </span>
            ),
            sortValue: (row) => row.email ?? '',
            searchValue: (row) => `${row.email ?? ''} ${row.phone ?? ''} ${row.mobile ?? ''}`,
            exportValue: (row) => `${row.email ?? ''} ${row.phone ?? ''}`,
        },
        {
            id: 'city',
            header: t('customer.city'),
            defaultHidden: true,
            cell: (row) => row.city ?? '—',
            sortValue: (row) => row.city ?? '',
            exportValue: (row) => row.city ?? '',
        },
        {
            id: 'vat',
            header: t('customer.vat'),
            defaultHidden: true,
            cell: (row) => row.vat ?? '—',
            sortValue: (row) => row.vat ?? '',
            exportValue: (row) => row.vat ?? '',
        },
        {
            id: 'order_count',
            header: t('customer.orders'),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{row.order_count}</span>,
            sortValue: (row) => row.order_count,
            exportValue: (row) => row.order_count,
        },
        {
            id: 'account_balance',
            header: t('customer.balance'),
            align: 'end',
            cell: (row) => (
                // Positive means owed to the venue, which is the number a manager opens this list
                // for. Zero is left blank rather than printed: a column of 0,00 € hides the two rows
                // that are not.
                Number(row.account_balance) === 0 ? null : (
                    <span className={cn('tabular-nums', Number(row.account_balance) > 0 && 'text-danger')}>
                        {money(row.account_balance, EUR)}
                    </span>
                )
            ),
            sortValue: (row) => Number(row.account_balance),
            exportValue: (row) => row.account_balance,
        },
        {
            id: 'last_order_at',
            header: t('customer.lastVisit'),
            cell: (row) => (row.last_order_at === null ? '—' : date(row.last_order_at)),
            sortValue: (row) => row.last_order_at ?? '',
            exportValue: (row) => row.last_order_at ?? '',
        },
        {
            id: 'actions',
            header: '',
            align: 'end',
            cell: (row) => (
                <Link
                    href={routes.customers.edit(row.uuid)}
                    className={cn('rounded-pos px-2 py-1 text-sm text-brand-700 hover:underline', FOCUS_RING)}
                >
                    {t('action.edit')}
                </Link>
            ),
        },
    ];

    return (
        <AppLayout title={t('customer.title')} description={t('customer.hint')}>
            <Head title={t('customer.title')} />

            <div className="space-y-4">
                <Card>
                    <CardBody className="space-y-3">
                        <FormSection>
                            <TextField
                                label={t('customer.search')}
                                hint={t('customer.searchHint')}
                                value={query}
                                onChange={setQuery}
                            />
                        </FormSection>
                        <div className="flex items-center gap-3">
                            <Button
                                onClick={() =>
                                    router.get(routes.customers.index(), query === '' ? {} : { q: query }, {
                                        preserveState: true,
                                    })
                                }
                            >
                                {t('action.apply')}
                            </Button>
                            <span className="text-sm text-slate-500">
                                {t('customer.showingOf', {
                                    shown: String(customers.length),
                                    total: String(total),
                                })}
                            </span>
                        </div>

                        {/* Never let a cut list read as the whole base. */}
                        {customers.length >= shownLimit ? (
                            <Notice tone="info">{t('customer.truncated', { limit: String(shownLimit) })}</Notice>
                        ) : null}
                    </CardBody>
                </Card>

                {duplicates.length > 0 ? <Duplicates groups={duplicates} /> : null}

                <AddCustomer />

                <DataTable
                    columns={columns}
                    rows={customers}
                    getRowId={(row) => row.id}
                    storageKey="customers"
                    caption={t('customer.title')}
                    exportFilename="clients"
                    onRowHref={(row) => routes.customers.edit(row.uuid)}
                    rowClassName={(row) => (row.active ? undefined : 'opacity-60')}
                />
            </div>
        </AppLayout>
    );
}

/**
 * Records that share a contact detail.
 *
 * Surfaced rather than merged: which of two records survives decides whose name, contact details and
 * price list the customer keeps, and that is not a machine's call. The link opens the record so the
 * merge is done from the one being kept.
 */
function Duplicates({ groups }: { groups: CustomersIndexProps['duplicates'] }): JSX.Element {
    const t = useT();

    return (
        <Card>
            <CardHeader title={t('customer.duplicates')} description={t('customer.duplicatesHint')} />
            <CardBody className="space-y-2">
                {groups.map((group) => (
                    <div key={`${group.field}-${group.value}`} className="flex flex-wrap items-baseline gap-2 text-sm">
                        <Badge tone="warn">{group.value}</Badge>
                        <span className="text-slate-600">{group.names.join(' · ')}</span>
                    </div>
                ))}
            </CardBody>
        </Card>
    );
}

function AddCustomer(): JSX.Element {
    const t = useT();
    const [open, setOpen] = useState(false);

    const form = useForm<{ name: string; email: string; phone: string }>({
        name: '',
        email: '',
        phone: '',
    });

    if (!open) {
        return (
            <Button variant="ghost" onClick={() => setOpen(true)}>
                {t('customer.add')}
            </Button>
        );
    }

    return (
        <Card>
            <CardHeader title={t('customer.add')} description={t('customer.addHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('customer.name')}
                        value={form.data.name}
                        error={form.errors.name}
                        required
                        onChange={(value) => form.setData('name', value)}
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
                </FormSection>

                <div className="flex gap-2">
                    <Button
                        loading={form.processing}
                        onClick={() => form.post(routes.customers.store(), { onSuccess: () => setOpen(false) })}
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
