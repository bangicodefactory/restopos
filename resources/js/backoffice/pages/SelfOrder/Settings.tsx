/**
 * `SelfOrder/Settings` — `GET /self-order/{config}/settings` (SLF-001…019, BOF-070…079).
 *
 * Four things: the mode, the payment rules, the branding and links, and the QR codes.
 *
 * **The mode is the switch everything else hangs off.** `consultation` is a menu with no cart, so
 * the pay-after rule and the online payment method genuinely do not apply; `kiosk` is the only
 * mode with idle timers. Those controls are disabled with their reason rather than hidden, which
 * is the same rule the register settings screen follows.
 *
 * **QR codes are generated in the browser**, by `lib/qr` + `components/qr/QrCode` — no
 * dependency, no network, no third-party image service handed the venue's capability token. The
 * QR encodes the public URL and nothing else; the token *is* the capability, which is why
 * rotating it is a separately-confirmed action that invalidates every printed code.
 *
 * **Contract gap, surfaced not faked:** this page receives no table list, so per-table QR codes
 * cannot be enumerated from it (`self.tablesUnavailable`). Rather than drop the feature, the
 * sheet builder takes the table tokens the operator pastes in — they are visible on
 * `Floors/Edit` — and lays them out as a printable A4 sheet with a print stylesheet, so the
 * codes an operator actually needs on tables can still be produced today.
 */

import { Head, router, useForm } from '@inertiajs/react';
import { Button, cn } from '@shared/ui';
import { useMemo, useState, type JSX } from 'react';

import {
    ColorField,
    MultiSelectField,
    NumberField,
    SaveBar,
    SelectField,
    TextField,
    TextareaField,
    useDirtyGuard,
} from '../../components/form';
import { FormSection } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { QrCode } from '../../components/qr/QrCode';
import { ConfirmAction } from '../../components/ui/ConfirmAction';
import { TokenField } from '../../components/ui/CopyButton';
import { Tabs, type TabItem } from '../../components/ui/Tabs';
import { Badge, Card, CardBody, CardHeader } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { absoluteUrl, routes } from '../../lib/routes';

import {
    PAY_AFTER_HINT,
    capabilitiesOf,
    parseTableTokens,
    selfOrderUrl,
    toForm,
    type SelfOrderSettingsProps,
} from './types';

export default function SelfOrderSettings({
    config,
    modes,
    serviceModes,
    payAfterModes,
    customLinks,
    paymentMethods,
}: SelfOrderSettingsProps): JSX.Element {
    const t = useT();
    const [tab, setTab] = useState('mode');
    const form = useForm(toForm(config));

    useDirtyGuard(form.isDirty, t('confirm.leave'));

    const capabilities = capabilitiesOf(form.data.self_ordering_mode);
    const disabledReason = t('self.modeLock');

    const venueUrl = absoluteUrl(routes.shells.selfOrder(config.access_token));

    const tabs: TabItem[] = [
        { id: 'mode', label: t('self.mode') },
        { id: 'branding', label: t('self.branding') },
        { id: 'links', label: t('self.links'), badge: <Badge>{form.data.custom_link_ids.length}</Badge> },
        { id: 'qr', label: t('self.qr') },
    ];

    return (
        <AppLayout
            title={`${t('self.title')} — ${config.name}`}
            breadcrumbs={[{ label: t('config.title'), href: routes.posConfigs.index() }]}
            actions={
                <>
                    <Badge tone={form.data.self_ordering_mode === 'nothing' ? 'neutral' : 'ok'}>
                        {modes.find((mode) => mode.value === form.data.self_ordering_mode)?.label ??
                            form.data.self_ordering_mode}
                    </Badge>
                    <a
                        href={routes.shells.selfOrder(config.access_token)}
                        className="inline-flex min-h-touch items-center rounded-pos bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
                    >
                        {t('action.open')}
                    </a>
                </>
            }
        >
            <Head title={`${t('self.title')} — ${config.name}`} />

            <Card>
                <CardBody>
                    <Tabs items={tabs} active={tab} onChange={setTab} label={t('self.title')}>
                        {tab === 'mode' ? (
                            <>
                                <FormSection title={t('self.mode')} description={t('self.modeHint')}>
                                    <SelectField
                                        label={t('self.mode')}
                                        value={form.data.self_ordering_mode}
                                        error={form.errors.self_ordering_mode}
                                        onChange={(value) => form.setData('self_ordering_mode', value)}
                                        options={modes}
                                    />
                                    <SelectField
                                        label={t('self.serviceMode')}
                                        value={form.data.self_ordering_service_mode}
                                        error={form.errors.self_ordering_service_mode}
                                        onChange={(value) => form.setData('self_ordering_service_mode', value)}
                                        options={serviceModes}
                                        disabled={!capabilities.service}
                                        lockedReason={capabilities.service ? undefined : disabledReason}
                                        hint={t('self.serviceModeHint')}
                                    />
                                </FormSection>

                                <FormSection title={t('self.payAfter')} description={t('self.payAfterHint')}>
                                    <SelectField
                                        label={t('self.payAfter')}
                                        value={form.data.self_ordering_pay_after}
                                        error={form.errors.self_ordering_pay_after}
                                        onChange={(value) => form.setData('self_ordering_pay_after', value)}
                                        options={payAfterModes}
                                        disabled={!capabilities.payment}
                                        lockedReason={capabilities.payment ? undefined : disabledReason}
                                        hint={PAY_AFTER_HINT[form.data.self_ordering_pay_after]}
                                    />
                                    <SelectField
                                        label={t('self.onlineMethod')}
                                        value={
                                            form.data.self_order_online_payment_method_id === null
                                                ? ''
                                                : String(form.data.self_order_online_payment_method_id)
                                        }
                                        error={form.errors.self_order_online_payment_method_id}
                                        onChange={(value) =>
                                            form.setData(
                                                'self_order_online_payment_method_id',
                                                value === '' ? null : Number(value),
                                            )
                                        }
                                        options={paymentMethods.map((method) => ({
                                            value: String(method.id),
                                            label: `${method.name} (${method.method_type})`,
                                        }))}
                                        placeholder={t('state.none')}
                                        disabled={!capabilities.payment}
                                        lockedReason={capabilities.payment ? undefined : disabledReason}
                                        hint={t('self.onlineMethodHint')}
                                    />
                                </FormSection>

                                <FormSection title={t('self.kiosk')} description={t('self.kioskHint')}>
                                    <NumberField
                                        label={t('self.kioskIdle')}
                                        value={form.data.kiosk_idle_seconds}
                                        error={form.errors.kiosk_idle_seconds}
                                        onChange={(value) => form.setData('kiosk_idle_seconds', value)}
                                        min={10}
                                        max={600}
                                        suffix="s"
                                        disabled={!capabilities.kiosk}
                                        lockedReason={capabilities.kiosk ? undefined : disabledReason}
                                    />
                                    <NumberField
                                        label={t('self.kioskConfirmation')}
                                        value={form.data.kiosk_confirmation_seconds}
                                        error={form.errors.kiosk_confirmation_seconds}
                                        onChange={(value) => form.setData('kiosk_confirmation_seconds', value)}
                                        min={5}
                                        max={300}
                                        suffix="s"
                                        disabled={!capabilities.kiosk}
                                        lockedReason={capabilities.kiosk ? undefined : disabledReason}
                                    />
                                </FormSection>
                            </>
                        ) : null}

                        {tab === 'branding' ? (
                            <FormSection title={t('self.branding')}>
                                <TextField
                                    label={t('self.brandName')}
                                    value={form.data.self_ordering_brand_name}
                                    error={form.errors.self_ordering_brand_name}
                                    onChange={(value) => form.setData('self_ordering_brand_name', value)}
                                    maxLength={96}
                                    placeholder={config.name}
                                />
                                <NumberField
                                    label={t('self.defaultLanguage')}
                                    value={config.self_ordering_default_language_id}
                                    onChange={() => undefined}
                                    disabled
                                    lockedReason={t('self.readOnly')}
                                />
                                <ColorField
                                    label={t('self.primaryColor')}
                                    value={form.data.self_ordering_primary_color}
                                    error={form.errors.self_ordering_primary_color}
                                    onChange={(value) => form.setData('self_ordering_primary_color', value)}
                                />
                                <ColorField
                                    label={t('self.textColor')}
                                    value={form.data.self_ordering_text_color}
                                    error={form.errors.self_ordering_text_color}
                                    onChange={(value) => form.setData('self_ordering_text_color', value)}
                                />
                                <div className="md:col-span-2">
                                    <BrandPreview
                                        brand={form.data.self_ordering_brand_name || config.name}
                                        background={form.data.self_ordering_primary_color}
                                        text={form.data.self_ordering_text_color}
                                    />
                                </div>
                            </FormSection>
                        ) : null}

                        {tab === 'links' ? (
                            <FormSection columns={1} title={t('self.links')} description={t('self.linksHint')}>
                                <MultiSelectField
                                    label={t('self.links')}
                                    values={form.data.custom_link_ids}
                                    onChange={(values) => form.setData('custom_link_ids', values)}
                                    options={customLinks.map((link) => ({
                                        value: String(link.id),
                                        label: `${link.name} — ${link.url}`,
                                        disabled: !link.active,
                                    }))}
                                />
                                <LinkPreview
                                    links={customLinks.filter((link) =>
                                        form.data.custom_link_ids.includes(link.id),
                                    )}
                                />
                            </FormSection>
                        ) : null}

                        {tab === 'qr' ? (
                            <QrPanel accessToken={config.access_token} venueUrl={venueUrl} configUuid={config.uuid} />
                        ) : null}
                    </Tabs>

                    <SaveBar
                        dirty={form.isDirty}
                        processing={form.processing}
                        errorCount={Object.keys(form.errors).length}
                        onSave={() => form.patch(routes.selfOrder.update(config.uuid), { preserveScroll: true })}
                        onCancel={() => form.reset()}
                    />
                </CardBody>
            </Card>
        </AppLayout>
    );
}

// ───────────────────────────────────────────────────────────── branding preview

function BrandPreview({
    brand,
    background,
    text,
}: {
    brand: string;
    background: string | null;
    text: string | null;
}): JSX.Element {
    const t = useT();
    return (
        <div
            className="rounded-pos-lg p-6 ring-1 ring-inset ring-slate-200"
            style={{ backgroundColor: background ?? '#2563eb', color: text ?? '#ffffff' }}
        >
            <p className="text-xs uppercase tracking-wide opacity-80">{t('self.preview')}</p>
            <p className="text-2xl font-bold">{brand}</p>
        </div>
    );
}

function LinkPreview({ links }: { links: { id: number; name: string; url: string; style: string }[] }): JSX.Element {
    const t = useT();

    if (links.length === 0) return <p className="text-sm text-slate-500">{t('state.none')}</p>;

    return (
        <ul className="divide-y divide-slate-100 rounded-pos ring-1 ring-inset ring-slate-200">
            {links.map((link) => (
                <li key={link.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                    <Badge tone="brand">{link.style}</Badge>
                    <span className="font-medium">{link.name}</span>
                    <span className="truncate font-mono text-xs text-slate-500">{link.url}</span>
                </li>
            ))}
        </ul>
    );
}

// ───────────────────────────────────────────────────────────── QR codes

function QrPanel({
    accessToken,
    venueUrl,
    configUuid,
}: {
    accessToken: string;
    venueUrl: string;
    configUuid: string;
}): JSX.Element {
    const t = useT();
    const [raw, setRaw] = useState('');
    const [size, setSize] = useState(180);

    const tokens = useMemo(() => parseTableTokens(raw), [raw]);

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader title={t('self.qrVenue')} description={t('self.qrHint')} />
                <CardBody className="flex flex-wrap items-start gap-6">
                    <QrCode value={venueUrl} size={200} label={venueUrl} />
                    <div className="min-w-[18rem] flex-1 space-y-3">
                        <TokenField label={t('config.accessToken')} value={accessToken} />
                        <TokenField label="URL" value={venueUrl} />
                        <ConfirmAction
                            label={t('self.rotateToken')}
                            title={t('self.rotateToken')}
                            message={t('self.rotateWarning')}
                            confirmPhrase={accessToken.slice(0, 8)}
                            onConfirm={() =>
                                router.post(routes.selfOrder.rotateToken(configUuid), {}, { preserveScroll: true })
                            }
                        />
                    </div>
                </CardBody>
            </Card>

            <Card>
                <CardHeader
                    title={t('self.qrTables')}
                    description={t('self.tablesUnavailable')}
                    actions={
                        <div className="flex flex-wrap items-end gap-2 print:hidden">
                            <label className="flex flex-col gap-1 text-xs font-medium" htmlFor="qr-size">
                                {t('self.qrSize')}
                                <select
                                    id="qr-size"
                                    value={String(size)}
                                    onChange={(event) => setSize(Number(event.target.value))}
                                    className="min-h-touch rounded-pos bg-white px-3 text-sm ring-1 ring-inset ring-slate-300"
                                >
                                    {[120, 150, 180, 220].map((value) => (
                                        <option key={value} value={String(value)}>
                                            {value} px
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <Button
                                variant="secondary"
                                size="md"
                                disabled={tokens.length === 0}
                                onClick={() => globalThis.print()}
                            >
                                {t('self.printSheet')}
                            </Button>
                        </div>
                    }
                />
                <CardBody className="space-y-4">
                    <div className="print:hidden">
                        <TextareaField
                            label={t('self.tableTokens')}
                            hint={t('self.tableTokensHint')}
                            rows={3}
                            value={raw}
                            onChange={setRaw}
                            placeholder="a1b2c3d4, e5f6g7h8"
                        />
                    </div>

                    {tokens.length === 0 ? (
                        <p className="text-sm text-slate-500">{t('self.tableTokensEmpty')}</p>
                    ) : (
                        <ul
                            aria-label={t('self.qrTables')}
                            className={cn(
                                'grid gap-4 sm:grid-cols-2 lg:grid-cols-3',
                                'print:grid-cols-2 print:gap-6',
                            )}
                        >
                            {tokens.map((token) => {
                                const url = selfOrderUrl(venueUrl, token);
                                return (
                                    <li
                                        key={token}
                                        className="flex break-inside-avoid flex-col items-center gap-2 rounded-pos-lg bg-white p-4 text-center ring-1 ring-slate-200"
                                    >
                                        <QrCode value={url} size={size} label={url} />
                                        <span className="font-mono text-xs text-slate-600">{token}</span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </CardBody>
            </Card>
        </div>
    );
}
