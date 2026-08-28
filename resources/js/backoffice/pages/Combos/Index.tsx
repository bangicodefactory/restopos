/**
 * `Combos/Index` — `GET /combos` (BOF-088, BAN-416).
 *
 * Courses, not menus. A row here is "Starters" or "Mains"; the menu itself is a product, and the
 * **Menus** column says which ones offer this course. The menu entry has been in the sidebar since
 * the back office was built, pointing at nothing — a formule could only be created by SQL (BAN-416).
 */

import { Head, Link, router, useForm } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import { FormSection, MoneyField, TextField } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, Card, CardBody, CardHeader } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { EUR, money } from '../../lib/money';
import { routes } from '../../lib/routes';

import type { ComboListRow, CombosIndexProps } from './types';

export default function CombosIndex({ combos }: CombosIndexProps): JSX.Element {
    const t = useT();
    const [search, setSearch] = useState('');

    const columns: Column<ComboListRow>[] = [
        {
            id: 'name',
            header: t('combo.name'),
            locked: true,
            cell: (row) => row.name,
            sortValue: (row) => row.name,
            searchValue: (row) => row.name,
            exportValue: (row) => row.name,
        },
        {
            id: 'menus',
            header: t('combo.menus'),
            cell: (row) =>
                row.menus.length === 0 ? (
                    // A course on no menu is never offered to anyone. Worth saying, not hiding.
                    <Badge tone="warn">{t('combo.orphan')}</Badge>
                ) : (
                    <span className="text-sm">{row.menus.map((menu) => menu.name).join(' · ')}</span>
                ),
            sortValue: (row) => row.menus.length,
            searchValue: (row) => row.menus.map((menu) => menu.name).join(' '),
            exportValue: (row) => row.menus.map((menu) => menu.name).join(' / '),
        },
        {
            id: 'item_count',
            header: t('combo.dishes'),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{row.item_count}</span>,
            sortValue: (row) => row.item_count,
            exportValue: (row) => row.item_count,
        },
        {
            id: 'choices',
            header: t('combo.choices'),
            cell: (row) => t('combo.choicesOf', { free: String(row.qty_free), max: String(row.qty_max) }),
            sortValue: (row) => row.qty_max,
            exportValue: (row) => `${row.qty_free}/${row.qty_max}`,
        },
        {
            id: 'base_price',
            header: t('combo.weight'),
            align: 'end',
            cell: (row) => <span className="tabular-nums">{money(row.base_price, EUR)}</span>,
            sortValue: (row) => Number(row.base_price),
            exportValue: (row) => row.base_price,
        },
        {
            id: 'active',
            header: t('state.active'),
            align: 'center',
            cell: (row) => (
                <Badge tone={row.active ? 'ok' : 'neutral'}>
                    {row.active ? t('state.active') : t('state.inactive')}
                </Badge>
            ),
            sortValue: (row) => row.active,
            exportValue: (row) => (row.active ? '1' : '0'),
        },
        {
            id: 'actions',
            header: '',
            align: 'end',
            cell: (row) => (
                <Link
                    href={routes.combos.edit(row.id)}
                    className={cn('rounded-pos px-2 py-1 text-sm text-brand-700 hover:underline', FOCUS_RING)}
                >
                    {t('action.edit')}
                </Link>
            ),
        },
        {
            id: 'remove',
            header: '',
            align: 'end',
            exportValue: () => '',
            cell: (row) => (
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => router.delete(routes.combos.destroy(row.id), { preserveScroll: true })}
                >
                    {t('action.delete')}
                </Button>
            ),
        },
    ];

    return (
        <AppLayout title={t('combo.title')} description={t('combo.hint')}>
            <Head title={t('combo.title')} />

            <AddCombo />

            <DataTable
                columns={columns}
                rows={combos}
                getRowId={(row) => row.id}
                storageKey="combos"
                caption={t('combo.title')}
                search={{ value: search, onChange: setSearch }}
                exportFilename="formules"
                onRowHref={(row) => routes.combos.edit(row.id)}
                rowClassName={(row) => (row.active ? undefined : 'opacity-60')}
            />
        </AppLayout>
    );
}

function AddCombo(): JSX.Element {
    const t = useT();
    const [open, setOpen] = useState(false);

    const form = useForm<{ name: string; base_price: string }>({ name: '', base_price: '0' });

    if (!open) {
        return (
            <Button variant="ghost" onClick={() => setOpen(true)}>
                {t('combo.add')}
            </Button>
        );
    }

    return (
        <Card>
            <CardHeader title={t('combo.add')} description={t('combo.addHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('combo.name')}
                        value={form.data.name}
                        error={form.errors.name}
                        required
                        onChange={(value) => form.setData('name', value)}
                    />
                    <MoneyField
                        label={t('combo.weight')}
                        hint={t('combo.weightHint')}
                        value={form.data.base_price}
                        error={form.errors.base_price}
                        onChange={(value) => form.setData('base_price', value)}
                    />
                </FormSection>

                <div className="flex gap-2">
                    <Button
                        loading={form.processing}
                        onClick={() => form.post(routes.combos.store(), { onSuccess: () => setOpen(false) })}
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
