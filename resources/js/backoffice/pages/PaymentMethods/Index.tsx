/**
 * `PaymentMethods/Index` — `GET /payment-methods` (BOF-110…BOF-119).
 *
 * List on the left, editor for the selected method on the right.
 *
 * **`is_cash_count` is given its own column and its own warning** because it is the one switch on
 * this screen that breaks something invisible: it decides whether a method lands in the drawer
 * count at session close. Set it on a card terminal and every reconciliation from that day on is
 * short by the card takings, with nothing on screen to say why.
 *
 * `PATCH /payment-methods/{paymentMethod}` validates nine keys (`WRITABLE_PAYMENT_KEYS`).
 * `method_type`, `terminal_provider`, `payment_provider_id` and `currency_id` are not among them,
 * so those controls are rendered **locked with the reason** rather than as inputs that accept a
 * change, report success and come back unchanged. The provider list arrives on the page purely so
 * the linked provider can be named instead of shown as an id.
 */

import { Head, useForm } from '@inertiajs/react';
import { cn } from '@shared/ui';
import { useMemo, useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import {
    NumberField,
    SaveBar,
    SelectField,
    TextField,
    ToggleField,
    useDirtyGuard,
} from '../../components/form';
import { FormSection } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, BoolCell, Card, CardBody, CardHeader, EmptyState, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import {
    METHOD_TYPE_LABEL,
    ONLINE_METHOD_TYPES,
    TERMINAL_LABEL,
    toForm,
    type PaymentMethodRow,
    type PaymentMethodsIndexProps,
    type PaymentProviderRow,
} from './types';

export default function PaymentMethodsIndex({ methods, providers }: PaymentMethodsIndexProps): JSX.Element {
    const t = useT();
    const [search, setSearch] = useState('');
    const [selectedId, setSelectedId] = useState<number | null>(methods[0]?.id ?? null);

    const selected = methods.find((method) => method.id === selectedId) ?? null;

    const providerName = useMemo(() => {
        const map = new Map(providers.map((provider) => [provider.id, provider.name]));
        return (id: number | null): string => (id === null ? '—' : (map.get(id) ?? `#${id}`));
    }, [providers]);

    const columns: Column<PaymentMethodRow>[] = [
        {
            id: 'name',
            header: t('payment.title'),
            locked: true,
            cell: (row) => (
                <button
                    type="button"
                    onClick={() => setSelectedId(row.id)}
                    aria-pressed={row.id === selectedId}
                    className="text-start font-medium text-brand-700 hover:underline"
                >
                    {row.name}
                </button>
            ),
            sortValue: (row) => row.name,
            searchValue: (row) => row.name,
            exportValue: (row) => row.name,
        },
        {
            id: 'method_type',
            header: t('tax.amountType'),
            cell: (row) => (
                <span className="flex flex-wrap gap-1">
                    <Badge tone="brand">{METHOD_TYPE_LABEL[row.method_type] ?? row.method_type}</Badge>
                    {ONLINE_METHOD_TYPES.has(row.method_type) ? <Badge tone="info">{t('payment.online')}</Badge> : null}
                </span>
            ),
            sortValue: (row) => row.method_type,
            searchValue: (row) => METHOD_TYPE_LABEL[row.method_type] ?? row.method_type,
            exportValue: (row) => row.method_type,
        },
        {
            id: 'is_cash_count',
            header: t('payment.cashCount'),
            align: 'center',
            locked: true,
            cell: (row) => <BoolCell value={row.is_cash_count} labels={[t('state.yes'), t('state.no')]} />,
            sortValue: (row) => row.is_cash_count,
            exportValue: (row) => (row.is_cash_count ? '1' : '0'),
        },
        {
            id: 'terminal_provider',
            header: t('payment.terminal'),
            cell: (row) => (
                <span className="flex flex-col">
                    <span>{TERMINAL_LABEL[row.terminal_provider] ?? row.terminal_provider}</span>
                    <span className="text-xs text-slate-500">{providerName(row.payment_provider_id)}</span>
                </span>
            ),
            sortValue: (row) => row.terminal_provider,
            searchValue: (row) => `${row.terminal_provider} ${providerName(row.payment_provider_id)}`,
            exportValue: (row) => row.terminal_provider,
        },
        {
            id: 'allow_change',
            header: t('payment.allowChange'),
            align: 'center',
            defaultHidden: true,
            cell: (row) => <BoolCell value={row.allow_change} labels={[t('state.yes'), t('state.no')]} />,
            sortValue: (row) => row.allow_change,
            exportValue: (row) => (row.allow_change ? '1' : '0'),
        },
        {
            id: 'allow_refund',
            header: t('payment.allowRefund'),
            align: 'center',
            defaultHidden: true,
            cell: (row) => <BoolCell value={row.allow_refund} labels={[t('state.yes'), t('state.no')]} />,
            sortValue: (row) => row.allow_refund,
            exportValue: (row) => (row.allow_refund ? '1' : '0'),
        },
        {
            id: 'is_rounding_target',
            header: t('payment.roundingTarget'),
            align: 'center',
            cell: (row) => <BoolCell value={row.is_rounding_target} labels={[t('state.yes'), t('state.no')]} />,
            sortValue: (row) => row.is_rounding_target,
            exportValue: (row) => (row.is_rounding_target ? '1' : '0'),
        },
        {
            id: 'ledger_code',
            header: t('payment.ledger'),
            defaultHidden: true,
            cell: (row) => <span className="font-mono text-xs">{row.ledger_code ?? '—'}</span>,
            sortValue: (row) => row.ledger_code,
            exportValue: (row) => row.ledger_code,
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
                <Badge tone={row.active ? 'ok' : 'neutral'}>
                    {row.active ? t('state.active') : t('state.inactive')}
                </Badge>
            ),
            sortValue: (row) => row.active,
            exportValue: (row) => (row.active ? '1' : '0'),
        },
    ];

    return (
        <AppLayout title={t('payment.title')} description={t('payment.cashCountHint')}>
            <Head title={t('payment.title')} />

            <div className="space-y-6">
                <DataTable
                    columns={columns}
                    rows={methods}
                    getRowId={(row) => row.id}
                    storageKey="payment-methods"
                    caption={t('payment.title')}
                    search={{ value: search, onChange: setSearch }}
                    exportFilename="modes-de-paiement"
                    perPage={50}
                    rowClassName={(row) => (row.id === selectedId ? 'bg-brand-50' : undefined)}
                />

                {selected === null ? (
                    <Card>
                        <EmptyState title={t('state.empty')} hint={t('state.emptyHint')} />
                    </Card>
                ) : (
                    <MethodEditor key={selected.id} method={selected} providers={providers} />
                )}

                <Notice tone="info" title={t('payment.createMissingTitle')}>
                    {t('payment.createMissing')}
                </Notice>
            </div>
        </AppLayout>
    );
}

// ───────────────────────────────────────────────────────────── editor

function MethodEditor({
    method,
    providers,
}: {
    method: PaymentMethodRow;
    providers: PaymentProviderRow[];
}): JSX.Element {
    const t = useT();
    const locked = t('payment.readOnly');
    const form = useForm(toForm(method));

    useDirtyGuard(form.isDirty, t('confirm.leave'));

    const providerOptions = providers.map((provider) => ({
        value: String(provider.id),
        label: `${provider.name} (${provider.code})`,
    }));

    return (
        <Card>
            <CardHeader
                title={method.name}
                description={METHOD_TYPE_LABEL[method.method_type] ?? method.method_type}
                actions={
                    <>
                        {method.is_cash_count ? <Badge tone="brand">{t('payment.cashCount')}</Badge> : null}
                        <Badge tone={method.active ? 'ok' : 'neutral'}>
                            {method.active ? t('state.active') : t('state.inactive')}
                        </Badge>
                    </>
                }
            />
            <CardBody>
                <FormSection title={t('config.group.general')}>
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
                        min={0}
                    />
                    <SelectField
                        label={t('tax.amountType')}
                        value={method.method_type}
                        onChange={() => undefined}
                        options={Object.entries(METHOD_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
                        disabled
                        lockedReason={locked}
                    />
                    <NumberField
                        label="Devise (id)"
                        value={method.currency_id}
                        onChange={() => undefined}
                        disabled
                        lockedReason={locked}
                    />
                </FormSection>

                <FormSection title={t('config.group.accounting')} description={t('payment.ledgerHint')}>
                    <TextField
                        label={t('payment.ledger')}
                        value={form.data.ledger_code}
                        error={form.errors.ledger_code}
                        onChange={(value) => form.setData('ledger_code', value)}
                        maxLength={32}
                        placeholder="5311"
                    />
                    <ToggleField
                        label={t('payment.cashCount')}
                        checked={form.data.is_cash_count}
                        onChange={(checked) => form.setData('is_cash_count', checked)}
                        description={t('payment.cashCountHint')}
                    />
                    <ToggleField
                        label={t('payment.roundingTarget')}
                        checked={form.data.is_rounding_target}
                        onChange={(checked) => form.setData('is_rounding_target', checked)}
                        description={t('payment.roundingHint')}
                    />
                    <ToggleField
                        label={t('state.active')}
                        checked={form.data.active}
                        onChange={(checked) => form.setData('active', checked)}
                    />
                </FormSection>

                <FormSection title={t('config.group.payments')}>
                    <ToggleField
                        label={t('payment.allowChange')}
                        checked={form.data.allow_change}
                        onChange={(checked) => form.setData('allow_change', checked)}
                        description={t('payment.allowChangeHint')}
                    />
                    <ToggleField
                        label={t('payment.allowRefund')}
                        checked={form.data.allow_refund}
                        onChange={(checked) => form.setData('allow_refund', checked)}
                    />
                    <ToggleField
                        label={t('payment.identify')}
                        checked={form.data.identify_customer}
                        onChange={(checked) => form.setData('identify_customer', checked)}
                        description={t('payment.identifyHint')}
                    />
                </FormSection>

                <FormSection title={t('payment.terminal')} description={t('payment.terminalHint')}>
                    <SelectField
                        label={t('payment.terminal')}
                        value={method.terminal_provider}
                        onChange={() => undefined}
                        options={Object.entries(TERMINAL_LABEL).map(([value, label]) => ({ value, label }))}
                        disabled
                        lockedReason={locked}
                    />
                    <SelectField
                        label={t('payment.provider')}
                        value={method.payment_provider_id === null ? '' : String(method.payment_provider_id)}
                        onChange={() => undefined}
                        options={providerOptions}
                        placeholder={t('state.none')}
                        disabled
                        lockedReason={locked}
                    />
                    <div className={cn('md:col-span-2')}>
                        <Notice tone="info">
                            {ONLINE_METHOD_TYPES.has(method.method_type)
                                ? t('payment.onlineHint')
                                : t('payment.offlineHint')}
                        </Notice>
                    </div>
                </FormSection>

                <SaveBar
                    dirty={form.isDirty}
                    processing={form.processing}
                    errorCount={Object.keys(form.errors).length}
                    onSave={() =>
                        form.patch(routes.paymentMethods.update(method.id), { preserveScroll: true })
                    }
                    onCancel={() => form.reset()}
                />
            </CardBody>
        </Card>
    );
}
