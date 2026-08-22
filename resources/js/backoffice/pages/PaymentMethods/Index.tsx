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
 * **Everything the endpoint accepts is editable here (BAN-424).** `method_type`, `currency_id`,
 * `terminal_provider` and `payment_provider_id` used to be rendered locked because the rule set
 * dropped them — which stopped being true when the endpoint was widened, leaving four controls that
 * nobody could reach through any door. A method can now be created and removed from this page too.
 *
 * Two fields are deliberately not ordinary inputs:
 *
 *  - **`terminal_config` is write-only.** It is `encrypted:array` and `$hidden` on the model because
 *    it holds the terminal's pairing secret; sending it to the page would decrypt it into the page
 *    source of every manager who opens this screen. The page is told only *whether* one is set, and
 *    the field replaces it wholesale.
 *  - **`image_media_id` has no control at all.** The endpoint accepts it, but the app has no media
 *    *upload* route — only `GET /api/media/{id}` to serve one — so a picker would offer a choice of
 *    nothing. Stated here rather than rendered as a locked field implying the endpoint is the
 *    obstacle.
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
import { FormSection, type Option } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { ConfirmAction } from '../../components/ui/ConfirmAction';
import { Badge, BoolCell, Card, CardBody, CardHeader, EmptyState, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { useGuardedDelete } from '../../lib/guardedRequest';
import { routes } from '../../lib/routes';

import {
    METHOD_TYPE_LABEL,
    ONLINE_METHOD_TYPES,
    QR_METHOD_LABEL,
    TERMINAL_LABEL,
    toForm,
    type CurrencyRow,
    type PaymentMethodRow,
    type PaymentMethodsIndexProps,
    type PaymentProviderRow,
} from './types';

/** A `Record<value, label>` map rendered as select options, in map order. */
function labelOptions(labels: Record<string, string>): Option[] {
    return Object.entries(labels).map(([value, label]) => ({ value, label }));
}

function currencyOptions(currencies: CurrencyRow[]): Option[] {
    return currencies.map((currency) => ({
        value: String(currency.id),
        label: `${currency.code} — ${currency.name}`,
    }));
}

export default function PaymentMethodsIndex({
    methods,
    providers,
    currencies,
}: PaymentMethodsIndexProps): JSX.Element {
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
                    <MethodEditor
                        key={selected.id}
                        method={selected}
                        providers={providers}
                        currencies={currencies}
                    />
                )}

                <AddPaymentMethod currencies={currencies} />
            </div>
        </AppLayout>
    );
}

// ───────────────────────────────────────────────────────────── editor

function MethodEditor({
    method,
    providers,
    currencies,
}: {
    method: PaymentMethodRow;
    providers: PaymentProviderRow[];
    currencies: CurrencyRow[];
}): JSX.Element {
    const t = useT();
    const form = useForm(toForm(method));
    const remove = useGuardedDelete();

    // Write-only, and kept outside `useForm` so it is never part of the form's dirty state or its
    // reset value: there is nothing to reset it *to*, because the page is never told what is stored.
    const [terminalConfig, setTerminalConfig] = useState('');
    const configError = useMemo(() => parseConfigError(terminalConfig), [terminalConfig]);

    useDirtyGuard(form.isDirty || terminalConfig.trim() !== '', t('confirm.leave'));

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
                        value={form.data.method_type}
                        error={form.errors.method_type}
                        options={labelOptions(METHOD_TYPE_LABEL)}
                        onChange={(value) => form.setData('method_type', value)}
                    />
                    <SelectField
                        label={t('payment.currency')}
                        value={String(form.data.currency_id)}
                        error={form.errors.currency_id}
                        options={currencyOptions(currencies)}
                        onChange={(value) => form.setData('currency_id', Number(value))}
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
                        value={form.data.terminal_provider}
                        error={form.errors.terminal_provider}
                        options={labelOptions(TERMINAL_LABEL)}
                        onChange={(value) => form.setData('terminal_provider', value)}
                    />
                    <SelectField
                        label={t('payment.provider')}
                        value={form.data.payment_provider_id}
                        error={form.errors.payment_provider_id}
                        options={providerOptions}
                        placeholder={t('state.none')}
                        onChange={(value) => form.setData('payment_provider_id', value)}
                    />
                    <SelectField
                        label={t('payment.qrMethod')}
                        value={form.data.qr_code_method}
                        error={form.errors.qr_code_method}
                        options={labelOptions(QR_METHOD_LABEL)}
                        onChange={(value) => form.setData('qr_code_method', value)}
                    />
                    {form.data.qr_code_method === 'none' ? null : (
                        <TextField
                            label={t('payment.qrPayload')}
                            value={form.data.default_qr_payload}
                            error={form.errors.default_qr_payload}
                            onChange={(value) => form.setData('default_qr_payload', value)}
                            hint={t('payment.qrPayloadHint')}
                            maxLength={4096}
                        />
                    )}
                    <div className="md:col-span-2 space-y-2">
                        <TextField
                            label={t('payment.terminalConfig')}
                            value={terminalConfig}
                            error={configError === null ? undefined : t('payment.terminalConfigInvalid')}
                            onChange={setTerminalConfig}
                            hint={
                                method.has_terminal_config
                                    ? t('payment.terminalConfigSet')
                                    : t('payment.terminalConfigHint')
                            }
                        />
                    </div>
                    <div className={cn('md:col-span-2')}>
                        <Notice tone="info">
                            {ONLINE_METHOD_TYPES.has(method.method_type)
                                ? t('payment.onlineHint')
                                : t('payment.offlineHint')}
                        </Notice>
                    </div>
                </FormSection>

                <SaveBar
                    dirty={form.isDirty || terminalConfig.trim() !== ''}
                    processing={form.processing}
                    errorCount={Object.keys(form.errors).length + (configError === null ? 0 : 1)}
                    onSave={() => {
                        if (configError !== null) return;

                        // The config is only ever *sent*, and only when the operator typed one.
                        // Omitting the key leaves whatever is stored alone; sending `null` clears it,
                        // which is what an emptied field would wrongly do on every unrelated save.
                        const parsed = parseConfig(terminalConfig);

                        form.transform((data) =>
                            parsed === undefined ? data : { ...data, terminal_config: parsed },
                        );

                        form.patch(routes.paymentMethods.update(method.id), {
                            preserveScroll: true,
                            onSuccess: () => setTerminalConfig(''),
                        });
                    }}
                    onCancel={() => {
                        form.reset();
                        setTerminalConfig('');
                    }}
                />

                <div className="flex justify-end border-t border-slate-200 pt-4">
                    {/*
                      * The server refuses once money has gone through the method or it appears on a
                      * closed session's report, and names which — `useGuardedDelete` is what puts
                      * that message in front of the operator instead of reloading in silence.
                      */}
                    <ConfirmAction
                        label={t('payment.remove')}
                        title={t('payment.remove')}
                        message={t('payment.removeConfirm', { name: method.name })}
                        confirmPhrase={method.name}
                        onConfirm={() => remove(routes.paymentMethods.destroy(method.id))}
                    />
                </div>
            </CardBody>
        </Card>
    );
}

/**
 * The terminal configuration the operator typed, as the endpoint wants it.
 *
 * `undefined` means "they typed nothing, leave the stored one alone" — which is why this is not a
 * plain parse: an empty box on an unrelated save must not clear a working terminal's credentials.
 */
function parseConfig(raw: string): Record<string, unknown> | undefined {
    if (raw.trim() === '') return undefined;

    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

/** Null when the box is empty or holds a JSON object; a marker otherwise. */
function parseConfigError(raw: string): 'invalid' | null {
    if (raw.trim() === '') return null;

    return parseConfig(raw) === undefined ? 'invalid' : null;
}

/**
 * Adding a payment method (BOF-110).
 *
 * The three fields with no safe default are asked for up front — the kind, the currency and whether
 * it counts into the drawer. Everything else is set on the editor once the method exists, and a new
 * method reaches no till until a register is pointed at it, which happens on the register's own
 * settings page.
 */
function AddPaymentMethod({ currencies }: { currencies: CurrencyRow[] }): JSX.Element {
    const t = useT();

    const form = useForm<{
        name: string;
        method_type: string;
        currency_id: number | null;
        is_cash_count: boolean;
    }>({
        name: '',
        method_type: 'bank',
        currency_id: currencies[0]?.id ?? null,
        is_cash_count: false,
    });

    return (
        <Card>
            <CardHeader title={t('payment.add')} description={t('payment.addHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('payment.name')}
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <SelectField
                        label={t('tax.amountType')}
                        value={form.data.method_type}
                        error={form.errors.method_type}
                        options={labelOptions(METHOD_TYPE_LABEL)}
                        onChange={(value) => form.setData('method_type', value)}
                    />
                    <SelectField
                        label={t('payment.currency')}
                        value={form.data.currency_id === null ? '' : String(form.data.currency_id)}
                        error={form.errors.currency_id}
                        options={currencyOptions(currencies)}
                        onChange={(value) => form.setData('currency_id', Number(value))}
                    />
                </FormSection>

                <ToggleField
                    label={t('payment.cashCount')}
                    checked={form.data.is_cash_count}
                    onChange={(checked) => form.setData('is_cash_count', checked)}
                    description={t('payment.cashCountHint')}
                />

                <SaveBar
                    dirty={form.data.name.trim() !== '' && form.data.currency_id !== null}
                    processing={form.processing}
                    errorCount={Object.keys(form.errors).length}
                    saveLabel={t('payment.add')}
                    onSave={() =>
                        form.post(routes.paymentMethods.store(), {
                            preserveScroll: true,
                            onSuccess: () => form.reset(),
                        })
                    }
                    onCancel={() => form.reset()}
                />
            </CardBody>
        </Card>
    );
}
