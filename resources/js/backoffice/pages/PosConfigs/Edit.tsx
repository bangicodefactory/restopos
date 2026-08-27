/**
 * `PosConfigs/Edit` — `GET /pos-configs/{config}/edit` (BOF-030…BOF-079).
 *
 * The widest settings surface in the product, organised in the same groups Odoo uses so a
 * migrating operator finds each switch where they expect it: general, interface, restaurant,
 * payments, pricing & taxes, receipts, preparation, self-order, accounting, hardware,
 * assignments.
 *
 * Two rules run through the whole screen:
 *
 *  1. **Dependency-aware enabling.** A dependent control is disabled, not hidden, while its
 *     parent is off — "where did the maximum-difference box go?" is a support call; a greyed box
 *     under an unchecked switch is self-explanatory.
 *  2. **Honest write surface.** `PATCH /pos-configs/{config}` validates a specific list of keys
 *     (`WRITABLE_CONFIG_KEYS`); Laravel silently drops the rest. Controls bound to a
 *     non-validated column are rendered locked with the reason, because a switch that flips,
 *     saves "successfully" and comes back unchanged is worse than no switch.
 *
 * Saving bumps `config_revision`, which is what tells every register to discard its cache.
 */

import { Head, useForm } from '@inertiajs/react';
import { Button, useToast } from '@shared/ui';
import { useCallback, useMemo, useState, type JSX } from 'react';

import {
    MultiSelectField,
    NumberField,
    SaveBar,
    SelectField,
    TextField,
    TextareaField,
    ToggleField,
    useDirtyGuard,
} from '../../components/form';
import { FormRow, FormSection, MoneyField } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { Tabs, type TabItem } from '../../components/ui/Tabs';
import { TokenField } from '../../components/ui/CopyButton';
import {
    Badge,
    Card,
    CardBody,
    CardHeader,
    DeferredRegion,
    Notice,
} from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { dateTime } from '../../lib/format';
import { HttpError, postJson } from '../../lib/http';
import { routes } from '../../lib/routes';

import type {
    PairedDevice,
    PairingCodeResponse,
    PosConfigEditProps,
    PosConfigOptions,
    PosConfigRecord,
} from './types';

type ConfigForm = {
    name: string;
    active: boolean;
    is_restaurant: boolean;
    use_pricelists: boolean;
    limit_categories: boolean;
    tip_after_payment: boolean;
    tip_product_id: number | null;
    use_fiscal_positions: boolean;
    has_cash_control: boolean;
    set_maximum_difference: boolean;
    amount_authorized_diff: string;
    use_preparation_display: boolean;
    use_preparation_printers: boolean;
    use_employee_login: boolean;
    enable_tips: boolean;
    enable_split_bill: boolean;
    enable_global_discount: boolean;
    global_discount_percent: string;
    limited_product_count: number;
    limited_customer_count: number;
    receipt_header: string;
    receipt_footer: string;
    payment_method_ids: number[];
    pricelist_ids: number[];
    fiscal_position_ids: number[];
    preset_ids: number[];
    printer_ids: number[];
    limited_category_ids: number[];
    employee_ids: number[];
    floor_ids: number[];
    prep_display_ids: number[];
    note_ids: number[];
    bill_ids: number[];

    // Widened in BAN-466. Each one has a matching rule in `PosConfigRequest`; the two lists move
    // together or a control saves into nothing.
    pricelist_id: number | null;
    default_fiscal_position_id: number | null;
    default_preset_id: number | null;
    use_presets: boolean;
    tax_display: string;
    default_screen: string;
    idle_return_seconds: number;
    show_product_images: boolean;
    show_category_images: boolean;
    group_products_by_category: boolean;
    big_scrollbars: boolean;
    allow_manual_discount: boolean;
    restrict_price_control: boolean;
    show_margins_to_all: boolean;
    auto_validate_terminal_payment: boolean;
    use_fast_payment: boolean;
    use_cash_rounding: boolean;
    cash_rounding_id: number | null;
    only_round_cash_payments: boolean;
    show_receipt_header_footer: boolean;
    basic_receipt: boolean;
    auto_print_receipt: boolean;
    skip_receipt_screen: boolean;
    enable_bill_print: boolean;
    prep_auto_fire_first_course: boolean;
    order_edit_tracking: boolean;
    employee_access_levels: Record<string, string>;
    role_abilities: Record<string, string[]> | null;
};

/** The levels `pos_config_employee.access_level` accepts, in increasing capability. */
const ACCESS_LEVELS = [
    { value: 'minimal', label: 'Minimal' },
    { value: 'basic', label: 'Standard' },
    { value: 'advanced', label: 'Étendu' },
] as const;

/** The two enum columns the settings screen offers, spelled the way the operator reads them. */
const TAX_DISPLAYS = [
    { value: 'subtotal', label: 'Hors taxes (sous-total)' },
    { value: 'total', label: 'Taxes comprises (total)' },
] as const;

const DEFAULT_SCREENS = [
    { value: 'tables', label: 'Plan de salle' },
    { value: 'register', label: 'Caisse' },
] as const;

function initialForm(config: PosConfigRecord): ConfigForm {
    return {
        name: config.name,
        active: config.active,
        is_restaurant: config.is_restaurant,
        use_pricelists: config.use_pricelists,
        limit_categories: config.limit_categories,
        tip_after_payment: config.tip_after_payment,
        tip_product_id: config.tip_product_id,
        use_fiscal_positions: config.use_fiscal_positions,
        has_cash_control: config.has_cash_control,
        set_maximum_difference: config.set_maximum_difference,
        amount_authorized_diff: config.amount_authorized_diff ?? '0',
        use_preparation_display: config.use_preparation_display,
        use_preparation_printers: config.use_preparation_printers,
        use_employee_login: config.use_employee_login,
        enable_tips: config.enable_tips,
        enable_split_bill: config.enable_split_bill,
        enable_global_discount: config.enable_global_discount,
        global_discount_percent: config.global_discount_percent,
        limited_product_count: config.limited_product_count,
        limited_customer_count: config.limited_customer_count,
        receipt_header: config.receipt_header ?? '',
        receipt_footer: config.receipt_footer ?? '',
        payment_method_ids: config.payment_method_ids,
        pricelist_ids: config.pricelist_ids,
        fiscal_position_ids: config.fiscal_position_ids,
        preset_ids: config.preset_ids,
        printer_ids: config.printer_ids,
        limited_category_ids: config.limited_category_ids,
        employee_ids: config.employee_ids,
        floor_ids: config.floor_ids,
        prep_display_ids: config.prep_display_ids,
        note_ids: config.note_ids,
        bill_ids: config.bill_ids,

        pricelist_id: config.pricelist_id,
        default_fiscal_position_id: config.default_fiscal_position_id,
        default_preset_id: config.default_preset_id,
        use_presets: config.use_presets,
        tax_display: config.tax_display,
        default_screen: config.default_screen,
        idle_return_seconds: config.idle_return_seconds,
        show_product_images: config.show_product_images,
        show_category_images: config.show_category_images,
        group_products_by_category: config.group_products_by_category,
        big_scrollbars: config.big_scrollbars,
        allow_manual_discount: config.allow_manual_discount,
        restrict_price_control: config.restrict_price_control,
        show_margins_to_all: config.show_margins_to_all,
        auto_validate_terminal_payment: config.auto_validate_terminal_payment,
        use_fast_payment: config.use_fast_payment,
        use_cash_rounding: config.use_cash_rounding,
        cash_rounding_id: config.cash_rounding_id,
        only_round_cash_payments: config.only_round_cash_payments,
        show_receipt_header_footer: config.show_receipt_header_footer,
        basic_receipt: config.basic_receipt,
        auto_print_receipt: config.auto_print_receipt,
        skip_receipt_screen: config.skip_receipt_screen,
        enable_bill_print: config.enable_bill_print,
        prep_auto_fire_first_course: config.prep_auto_fire_first_course,
        order_edit_tracking: config.order_edit_tracking,
        employee_access_levels: config.employee_access_levels,
        role_abilities: config.role_abilities,
    };
}

export default function PosConfigEdit({ config, options, devices }: PosConfigEditProps): JSX.Element {
    const t = useT();
    const [tab, setTab] = useState('general');
    const form = useForm<ConfigForm>(initialForm(config));
    const locked = t('config.readOnly');

    useDirtyGuard(form.isDirty, t('confirm.leave'));

    const dirtyCount = useMemo(() => {
        const initial = initialForm(config);
        return (Object.keys(initial) as (keyof ConfigForm)[]).filter(
            (key) => JSON.stringify(initial[key]) !== JSON.stringify(form.data[key]),
        ).length;
    }, [config, form.data]);

    const submit = useCallback(() => {
        form.patch(routes.posConfigs.update(config.uuid), { preserveScroll: true });
    }, [config.uuid, form]);

    const tabs: TabItem[] = [
        { id: 'general', label: t('config.group.general') },
        { id: 'interface', label: t('config.group.interface') },
        { id: 'restaurant', label: t('config.group.restaurant'), disabled: false },
        { id: 'payments', label: t('config.group.payments') },
        { id: 'pricing', label: t('config.group.pricing') },
        { id: 'receipts', label: t('config.group.receipts') },
        { id: 'kitchen', label: t('config.group.kitchen') },
        { id: 'selfOrder', label: t('config.group.selfOrder') },
        { id: 'accounting', label: t('config.group.accounting') },
        { id: 'hardware', label: t('config.group.hardware') },
        { id: 'assignments', label: t('config.group.assignments') },
    ];

    return (
        <AppLayout
            title={config.name}
            description={t('config.revisionHint')}
            breadcrumbs={[{ label: t('config.title'), href: routes.posConfigs.index() }]}
            actions={
                <>
                    <Badge tone="brand">{t('config.revision', { n: config.config_revision })}</Badge>
                    <a
                        href={routes.shells.register(config.id)}
                        className="inline-flex min-h-touch items-center rounded-pos bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
                    >
                        {t('dashboard.openRegister')}
                    </a>
                </>
            }
        >
            <Head title={`${t('config.edit')} — ${config.name}`} />

            <Card>
                <CardBody>
                    <Tabs items={tabs} active={tab} onChange={setTab} label={t('config.edit')}>
                        {tab === 'general' ? (
                            <FormSection>
                                <TextField
                                    label="Nom"
                                    required
                                    value={form.data.name}
                                    error={form.errors.name}
                                    onChange={(value) => form.setData('name', value)}
                                />
                                <ToggleField
                                    label={t('state.active')}
                                    checked={form.data.active}
                                    onChange={(checked) => form.setData('active', checked)}
                                    hint="Archiver un point de vente est refusé tant qu’une session est ouverte (BOF-006)."
                                />
                                <ToggleField
                                    label={t('dashboard.restaurant')}
                                    checked={form.data.is_restaurant}
                                    onChange={(checked) => form.setData('is_restaurant', checked)}
                                    description="Active les salles, les tables, les services et l’envoi en cuisine."
                                />
                                <ToggleField
                                    label="Connexion employé"
                                    checked={form.data.use_employee_login}
                                    onChange={(checked) => form.setData('use_employee_login', checked)}
                                    description="Chaque vente est attribuée à un employé identifié par PIN ou badge."
                                />
                                {/*
                                 * The currency stays read-only here even though the server now
                                 * accepts it: it is only changeable until the register takes its
                                 * first payment, and every register that has one has taken one.
                                 * A field that is writable on the day a venue is created and
                                 * refused for the rest of its life reads better as a decision made
                                 * at creation — which is BAN-472's surface, not this one.
                                 */}
                                <NumberField
                                    label="Devise (id)"
                                    value={config.currency_id}
                                    onChange={() => {}}
                                    disabled
                                    lockedReason="La devise est fixée à la création du point de vente : la changer redénominerait les sessions et commandes déjà enregistrées."
                                />
                                <SelectField
                                    label="Écran par défaut"
                                    value={form.data.default_screen}
                                    error={form.errors.default_screen}
                                    options={DEFAULT_SCREENS.map((screen) => ({
                                        value: screen.value,
                                        label: screen.label,
                                    }))}
                                    onChange={(value) => form.setData('default_screen', value)}
                                    hint="L’écran sur lequel la caisse revient entre deux ventes."
                                />
                                <FormRow>
                                    <TokenField label={t('config.accessToken')} value={config.access_token} />
                                </FormRow>
                            </FormSection>
                        ) : null}

                        {tab === 'interface' ? (
                            <FormSection description="Options d’affichage de la caisse (BOF-034).">
                                <ToggleField
                                    label="Images des produits"
                                    checked={form.data.show_product_images}
                                    onChange={(checked) => form.setData('show_product_images', checked)}
                                />
                                <ToggleField
                                    label="Images des catégories"
                                    checked={form.data.show_category_images}
                                    onChange={(checked) => form.setData('show_category_images', checked)}
                                />
                                <ToggleField
                                    label="Grouper par catégorie"
                                    checked={form.data.group_products_by_category}
                                    onChange={(checked) => form.setData('group_products_by_category', checked)}
                                />
                                <ToggleField
                                    label="Grandes barres de défilement"
                                    checked={form.data.big_scrollbars}
                                    onChange={(checked) => form.setData('big_scrollbars', checked)}
                                />
                                <NumberField
                                    label="Retour automatique (s)"
                                    value={form.data.idle_return_seconds}
                                    min={15}
                                    max={3600}
                                    error={form.errors.idle_return_seconds}
                                    onChange={(value) => form.setData('idle_return_seconds', value ?? 180)}
                                    suffix="s"
                                />
                                <NumberField
                                    label="Produits chargés"
                                    value={form.data.limited_product_count}
                                    min={1}
                                    error={form.errors.limited_product_count}
                                    onChange={(value) => form.setData('limited_product_count', value ?? 1)}
                                    hint="Plafond du chargement initial de la caisse (spec 05 §2)."
                                />
                                <NumberField
                                    label="Clients chargés"
                                    value={form.data.limited_customer_count}
                                    min={1}
                                    error={form.errors.limited_customer_count}
                                    onChange={(value) => form.setData('limited_customer_count', value ?? 1)}
                                />
                            </FormSection>
                        ) : null}

                        {tab === 'restaurant' ? (
                            <>
                                {!form.data.is_restaurant ? (
                                    <Notice tone="info" className="mb-4">
                                        Activez le mode restaurant dans l’onglet « Général » pour utiliser ces options.
                                    </Notice>
                                ) : null}
                                <FormSection>
                                    <ToggleField
                                        label="Partage d’addition"
                                        checked={form.data.enable_split_bill}
                                        disabled={!form.data.is_restaurant}
                                        onChange={(checked) => form.setData('enable_split_bill', checked)}
                                    />
                                    <ToggleField
                                        label="Impression d’addition"
                                        checked={form.data.enable_bill_print}
                                        onChange={(checked) => form.setData('enable_bill_print', checked)}
                                    />
                                    <ToggleField
                                        label="Pourboires"
                                        checked={form.data.enable_tips}
                                        disabled={!form.data.is_restaurant}
                                        onChange={(checked) => form.setData('enable_tips', checked)}
                                        hint="Les montants sont stockés ; aucun endpoint d’ajustement n’existe encore (spec 05 §15)."
                                    />
                                    {/* RST-122 — the mode the whole tip flow hangs off. The column
                                        has existed since the config table was written and was not in
                                        the controller's validated set, so this was shown locked: the
                                        only way to switch a venue into it was to edit the database. */}
                                    <ToggleField
                                        label="Pourboire après paiement"
                                        checked={form.data.tip_after_payment}
                                        disabled={!form.data.enable_tips}
                                        onChange={(checked) => form.setData('tip_after_payment', checked)}
                                        hint="Le pourboire est saisi une fois la vente encaissée, sur le ticket signé."
                                    />
                                    {/* RST-120 — where tips are booked. Only products marked as tips
                                        are offered: a catalogue-wide picker would be a search box,
                                        and this is not something a manager browses for. */}
                                    <label className="flex flex-col gap-1">
                                        <span className="text-sm text-slate-600">Produit pourboire</span>
                                        <select
                                            className="min-h-touch rounded border border-slate-300 bg-white px-2 disabled:opacity-50"
                                            data-testid="tip-product"
                                            disabled={!form.data.enable_tips}
                                            value={form.data.tip_product_id ?? ''}
                                            onChange={(event) =>
                                                form.setData(
                                                    'tip_product_id',
                                                    event.target.value === '' ? null : Number(event.target.value),
                                                )
                                            }
                                        >
                                            <option value="">Aucun</option>
                                            {(options?.tip_products ?? []).map((product) => (
                                                <option key={product.id} value={product.id}>
                                                    {product.name}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                </FormSection>
                            </>
                        ) : null}

                        {tab === 'payments' ? (
                            <FormSection>
                                <ToggleField
                                    label="Contrôle de caisse"
                                    checked={form.data.has_cash_control}
                                    onChange={(checked) => form.setData('has_cash_control', checked)}
                                    description="Comptage du fond de caisse à l’ouverture et à la clôture."
                                />
                                <ToggleField
                                    label="Écart maximum imposé"
                                    checked={form.data.set_maximum_difference}
                                    disabled={!form.data.has_cash_control}
                                    onChange={(checked) => form.setData('set_maximum_difference', checked)}
                                    hint="Sans cette option, tout écart clôture : il est enregistré et rapporté, sans bloquer le caissier."
                                />
                                <MoneyField
                                    label="Écart autorisé"
                                    value={form.data.amount_authorized_diff}
                                    disabled={!form.data.has_cash_control || !form.data.set_maximum_difference}
                                    error={form.errors.amount_authorized_diff}
                                    onChange={(value) => form.setData('amount_authorized_diff', value)}
                                />

                                <FormRow>
                                    <DeferredRegion value={options} label={t('bill.title')}>
                                        {(value) => (
                                            <MultiSelectField
                                                label={t('config.bills')}
                                                values={form.data.bill_ids}
                                                error={form.errors.bill_ids}
                                                disabled={!form.data.has_cash_control}
                                                options={value.bills.map((row) => ({
                                                    value: String(row.id),
                                                    label: `${row.name} · ${row.value}`,
                                                }))}
                                                onChange={(values) => form.setData('bill_ids', values)}
                                                hint={t('config.billsHint')}
                                            />
                                        )}
                                    </DeferredRegion>
                                </FormRow>
                                <ToggleField
                                    label="Validation automatique du terminal"
                                    checked={form.data.auto_validate_terminal_payment}
                                    onChange={(checked) => form.setData('auto_validate_terminal_payment', checked)}
                                />
                                <ToggleField
                                    label="Paiement rapide"
                                    checked={form.data.use_fast_payment}
                                    onChange={(checked) => form.setData('use_fast_payment', checked)}
                                />
                                <ToggleField
                                    label="Arrondi en espèces"
                                    checked={form.data.use_cash_rounding}
                                    onChange={(checked) => form.setData('use_cash_rounding', checked)}
                                    description="Arrondit le total en espèces au pas choisi, là où la pièce d’un centime n’a plus cours."
                                />
                                <ToggleField
                                    label="Arrondir uniquement les espèces"
                                    checked={form.data.only_round_cash_payments}
                                    disabled={!form.data.use_cash_rounding}
                                    onChange={(checked) => form.setData('only_round_cash_payments', checked)}
                                    description="Un règlement par carte passe au centime près ; seul le paiement en espèces est arrondi."
                                />

                                <FormRow>
                                    <DeferredRegion value={options} label="Règle d’arrondi">
                                        {(value) => (
                                            <SelectField
                                                label="Règle d’arrondi"
                                                value={form.data.cash_rounding_id === null ? '' : String(form.data.cash_rounding_id)}
                                                error={form.errors.cash_rounding_id}
                                                placeholder="Aucune"
                                                disabled={!form.data.use_cash_rounding}
                                                lockedReason={
                                                    form.data.use_cash_rounding
                                                        ? undefined
                                                        : 'Activez d’abord l’arrondi en espèces.'
                                                }
                                                options={value.cash_roundings.map((row) => ({
                                                    value: String(row.id),
                                                    label: `${row.name} · ${row.rounding} (${row.rounding_method})`,
                                                }))}
                                                onChange={(chosen) =>
                                                    form.setData('cash_rounding_id', chosen === '' ? null : Number(chosen))
                                                }
                                            />
                                        )}
                                    </DeferredRegion>
                                </FormRow>

                                <FormRow>
                                    <DeferredRegion value={options} label={t('payment.title')}>
                                        {(value) => (
                                            <MultiSelectField
                                                label={t('payment.title')}
                                                values={form.data.payment_method_ids}
                                                options={value.payment_methods.map((method) => ({
                                                    value: String(method.id),
                                                    label: `${method.name} · ${method.method_type}${method.is_cash_count ? ' · 💶' : ''}`,
                                                }))}
                                                onChange={(values) => form.setData('payment_method_ids', values)}
                                                hint="Odoo refuse de modifier les modes de paiement d’une session ouverte ; la même règle s’applique côté serveur."
                                            />
                                        )}
                                    </DeferredRegion>
                                </FormRow>
                            </FormSection>
                        ) : null}

                        {tab === 'pricing' ? (
                            <FormSection>
                                <ToggleField
                                    label="Listes de prix"
                                    checked={form.data.use_pricelists}
                                    onChange={(checked) => form.setData('use_pricelists', checked)}
                                />
                                <ToggleField
                                    label="Positions fiscales"
                                    checked={form.data.use_fiscal_positions}
                                    onChange={(checked) => form.setData('use_fiscal_positions', checked)}
                                />
                                <ToggleField
                                    label="Remise globale"
                                    checked={form.data.enable_global_discount}
                                    onChange={(checked) => form.setData('enable_global_discount', checked)}
                                />
                                <NumberField
                                    label="Remise globale (%)"
                                    value={Number(form.data.global_discount_percent)}
                                    min={0}
                                    max={100}
                                    step={0.5}
                                    suffix="%"
                                    disabled={!form.data.enable_global_discount}
                                    error={form.errors.global_discount_percent}
                                    onChange={(value) => form.setData('global_discount_percent', String(value ?? 0))}
                                />
                                <ToggleField
                                    label="Remise manuelle"
                                    checked={form.data.allow_manual_discount}
                                    onChange={(checked) => form.setData('allow_manual_discount', checked)}
                                />
                                <ToggleField
                                    label="Contrôle du prix restreint"
                                    checked={form.data.restrict_price_control}
                                    onChange={(checked) => form.setData('restrict_price_control', checked)}
                                />
                                <SelectField
                                    label="Affichage des taxes"
                                    value={form.data.tax_display}
                                    error={form.errors.tax_display}
                                    options={TAX_DISPLAYS.map((mode) => ({ value: mode.value, label: mode.label }))}
                                    onChange={(value) => form.setData('tax_display', value)}
                                    hint="Prix affichés taxes comprises ou hors taxes sur la caisse."
                                />
                                <ToggleField
                                    label="Limiter les catégories"
                                    checked={form.data.limit_categories}
                                    onChange={(checked) => form.setData('limit_categories', checked)}
                                />

                                <FormRow>
                                    <DeferredRegion value={options} label={t('pricelist.title')}>
                                        {(value) => (
                                            <div className="grid gap-4 md:grid-cols-3">
                                                {/*
                                                 * The two fields this whole ticket is about. Every
                                                 * price the till quotes is decided here, and
                                                 * neither could be set from anywhere: the rule set
                                                 * dropped them, so the only way to point a register
                                                 * at a pricelist was to edit the database.
                                                 *
                                                 * A pricelist prices in its own currency, so the
                                                 * server refuses one that disagrees with this
                                                 * register's — the till would otherwise quote its
                                                 * amounts under the wrong symbol.
                                                 */}
                                                <SelectField
                                                    label="Liste de prix par défaut"
                                                    value={form.data.pricelist_id === null ? '' : String(form.data.pricelist_id)}
                                                    error={form.errors.pricelist_id}
                                                    placeholder="Prix de vente du produit"
                                                    options={value.pricelists.map((row) => ({
                                                        value: String(row.id),
                                                        label: row.name,
                                                    }))}
                                                    onChange={(chosen) =>
                                                        form.setData('pricelist_id', chosen === '' ? null : Number(chosen))
                                                    }
                                                />
                                                <SelectField
                                                    label="Position fiscale par défaut"
                                                    value={
                                                        form.data.default_fiscal_position_id === null
                                                            ? ''
                                                            : String(form.data.default_fiscal_position_id)
                                                    }
                                                    error={form.errors.default_fiscal_position_id}
                                                    placeholder="Taxes du produit"
                                                    options={value.fiscal_positions.map((row) => ({
                                                        value: String(row.id),
                                                        label: row.name,
                                                    }))}
                                                    onChange={(chosen) =>
                                                        form.setData(
                                                            'default_fiscal_position_id',
                                                            chosen === '' ? null : Number(chosen),
                                                        )
                                                    }
                                                />
                                                <MultiSelectField
                                                    label={t('pricelist.title')}
                                                    values={form.data.pricelist_ids}
                                                    disabled={!form.data.use_pricelists}
                                                    options={value.pricelists.map((row) => ({
                                                        value: String(row.id),
                                                        label: row.name,
                                                    }))}
                                                    onChange={(values) => form.setData('pricelist_ids', values)}
                                                />
                                                <MultiSelectField
                                                    label={t('tax.fiscalPositions')}
                                                    values={form.data.fiscal_position_ids}
                                                    disabled={!form.data.use_fiscal_positions}
                                                    options={value.fiscal_positions.map((row) => ({
                                                        value: String(row.id),
                                                        label: row.name,
                                                    }))}
                                                    onChange={(values) => form.setData('fiscal_position_ids', values)}
                                                />
                                                <MultiSelectField
                                                    label={t('product.categories')}
                                                    values={form.data.limited_category_ids}
                                                    disabled={!form.data.limit_categories}
                                                    options={value.categories.map((row) => ({
                                                        value: String(row.id),
                                                        label: row.name,
                                                    }))}
                                                    onChange={(values) => form.setData('limited_category_ids', values)}
                                                />
                                            </div>
                                        )}
                                    </DeferredRegion>
                                </FormRow>
                            </FormSection>
                        ) : null}

                        {tab === 'receipts' ? (
                            <FormSection columns={1}>
                                <TextareaField
                                    label="En-tête du ticket"
                                    value={form.data.receipt_header}
                                    error={form.errors.receipt_header}
                                    onChange={(value) => form.setData('receipt_header', value)}
                                    rows={3}
                                />
                                <TextareaField
                                    label="Pied du ticket"
                                    value={form.data.receipt_footer}
                                    error={form.errors.receipt_footer}
                                    onChange={(value) => form.setData('receipt_footer', value)}
                                    rows={3}
                                />
                                <div className="grid gap-4 md:grid-cols-2">
                                    <ToggleField
                                        label="Impression automatique"
                                        checked={form.data.auto_print_receipt}
                                        onChange={(checked) => form.setData('auto_print_receipt', checked)}
                                    />
                                    <ToggleField
                                        label="Ignorer l’écran de ticket"
                                        checked={form.data.skip_receipt_screen}
                                        onChange={(checked) => form.setData('skip_receipt_screen', checked)}
                                    />
                                    <ToggleField
                                        label="Ticket simplifié"
                                        checked={form.data.basic_receipt}
                                        onChange={(checked) => form.setData('basic_receipt', checked)}
                                    />
                                    <ToggleField
                                        label="Afficher en-tête et pied"
                                        checked={form.data.show_receipt_header_footer}
                                        onChange={(checked) => form.setData('show_receipt_header_footer', checked)}
                                    />
                                </div>
                            </FormSection>
                        ) : null}

                        {tab === 'kitchen' ? (
                            <FormSection>
                                <ToggleField
                                    label="Imprimantes de préparation"
                                    checked={form.data.use_preparation_printers}
                                    onChange={(checked) => form.setData('use_preparation_printers', checked)}
                                />
                                <ToggleField
                                    label="Écrans de préparation"
                                    checked={form.data.use_preparation_display}
                                    onChange={(checked) => form.setData('use_preparation_display', checked)}
                                />
                                <ToggleField
                                    label="Envoi automatique du 1er service"
                                    checked={form.data.prep_auto_fire_first_course}
                                    onChange={(checked) => form.setData('prep_auto_fire_first_course', checked)}
                                />

                                <FormRow>
                                    <DeferredRegion value={options} label={t('printer.title')}>
                                        {(value) => (
                                            <MultiSelectField
                                                label={t('printer.title')}
                                                values={form.data.printer_ids}
                                                disabled={!form.data.use_preparation_printers}
                                                options={value.printers.map((row) => ({
                                                    value: String(row.id),
                                                    label: `${row.name} · ${row.printer_type}`,
                                                }))}
                                                onChange={(values) => form.setData('printer_ids', values)}
                                            />
                                        )}
                                    </DeferredRegion>
                                </FormRow>

                                <FormRow>
                                    <DeferredRegion value={options} label={t('note.title')}>
                                        {(value) => (
                                            <MultiSelectField
                                                label={t('config.notes')}
                                                values={form.data.note_ids}
                                                error={form.errors.note_ids}
                                                options={value.notes.map((row) => ({
                                                    value: String(row.id),
                                                    label: `${row.name} · ${row.note_scope}`,
                                                }))}
                                                onChange={(values) => form.setData('note_ids', values)}
                                                hint={t('config.notesHint')}
                                            />
                                        )}
                                    </DeferredRegion>
                                </FormRow>
                            </FormSection>
                        ) : null}

                        {tab === 'selfOrder' ? (
                            <div className="space-y-4">
                                <Notice tone="info">
                                    Les réglages de commande client vivent sur leur propre écran (
                                    <a className="underline" href={routes.selfOrder.settings(config.uuid)}>
                                        {t('self.title')}
                                    </a>
                                    ), qui possède la seule route d’écriture prévue par le contrat.
                                </Notice>
                                <FormSection>
                                    <TextField label={t('self.mode')} value={config.self_ordering_mode} onChange={() => {}} disabled />
                                    <TextField
                                        label={t('self.serviceMode')}
                                        value={config.self_ordering_service_mode}
                                        onChange={() => {}}
                                        disabled
                                    />
                                    <TextField
                                        label={t('self.payAfter')}
                                        value={config.self_ordering_pay_after}
                                        onChange={() => {}}
                                        disabled
                                    />
                                    <TextField
                                        label="Marque"
                                        value={config.self_ordering_brand_name ?? ''}
                                        onChange={() => {}}
                                        disabled
                                    />
                                </FormSection>
                            </div>
                        ) : null}

                        {tab === 'accounting' ? (
                            <FormSection>
                                <ToggleField
                                    label="Suivi des modifications de commande"
                                    checked={form.data.order_edit_tracking}
                                    onChange={(checked) => form.setData('order_edit_tracking', checked)}
                                />
                                <ToggleField
                                    label="Marges visibles par tous"
                                    checked={form.data.show_margins_to_all}
                                    onChange={(checked) => form.setData('show_margins_to_all', checked)}
                                />
                                <ToggleField
                                    label="Fidélité"
                                    checked={config.enable_loyalty}
                                    onChange={() => {}}
                                    disabled
                                    lockedReason={`${locked} ${t('order.actionsUnavailable')}`}
                                />
                                <TextField
                                    label="Dernier changement de configuration"
                                    value={dateTime(config.last_config_change_at)}
                                    onChange={() => {}}
                                    disabled
                                />
                            </FormSection>
                        ) : null}

                        {tab === 'hardware' ? (
                            <FormSection>
                                <ToggleField label="Boîtier IoT" checked={config.use_iot_box} onChange={() => {}} disabled lockedReason={locked} />
                                <TextField label="IP du proxy" value={config.proxy_ip ?? ''} onChange={() => {}} disabled lockedReason={locked} />
                                <ToggleField label="Scanner" checked={config.iot_scan} onChange={() => {}} disabled lockedReason={locked} />
                                <ToggleField label="Balance" checked={config.iot_scale} onChange={() => {}} disabled lockedReason={locked} />
                                <ToggleField label="Impression" checked={config.iot_print} onChange={() => {}} disabled lockedReason={locked} />
                                <ToggleField label="Tiroir-caisse" checked={config.iot_cashdrawer} onChange={() => {}} disabled lockedReason={locked} />
                                <ToggleField
                                    label="Imprimante ePOS"
                                    checked={config.use_epos_printer}
                                    onChange={() => {}}
                                    disabled
                                    lockedReason={locked}
                                />
                                <TextField
                                    label="IP imprimante ePOS"
                                    value={config.epos_printer_ip ?? ''}
                                    onChange={() => {}}
                                    disabled
                                    lockedReason={locked}
                                />
                            </FormSection>
                        ) : null}

                        {tab === 'assignments' ? (
                            <div className="space-y-6">
                                <DeferredRegion value={options} label={t('config.group.assignments')} rows={4}>
                                    {(value) => <Assignments form={form} options={value} />}
                                </DeferredRegion>

                                <Notice tone="warn">
                                    Les salles (<code>floor_ids</code>) et les écrans cuisine (<code>prep_display_ids</code>)
                                    sont acceptés par PATCH /pos-configs/{'{id}'} mais le contrat ne fournit pas leur liste
                                    d’options sur cette page. Ils restent affectés depuis {t('nav.floors')} et{' '}
                                    {t('nav.prepDisplays')}.
                                </Notice>
                            </div>
                        ) : null}
                    </Tabs>

                    <SaveBar
                        dirty={form.isDirty}
                        dirtyCount={dirtyCount}
                        processing={form.processing}
                        errorCount={Object.keys(form.errors).length}
                        onSave={submit}
                        onCancel={() => form.reset()}
                    />
                </CardBody>
            </Card>

            <div className="mt-6">
                <DevicesPanel configUuid={config.uuid} devices={devices} />
            </div>
        </AppLayout>
    );
}

function Assignments({
    form,
    options,
}: {
    form: ReturnType<typeof useForm<ConfigForm>>;
    options: PosConfigOptions;
}): JSX.Element {
    const t = useT();
    return (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <MultiSelectField
                label={t('preset.title')}
                values={form.data.preset_ids}
                options={options.presets.map((row) => ({ value: String(row.id), label: `${row.name} · ${row.service_at}` }))}
                onChange={(values) => form.setData('preset_ids', values)}
            />
            <ToggleField
                label="Modes de service"
                checked={form.data.use_presets}
                onChange={(checked) => form.setData('use_presets', checked)}
                description="Sur place, à emporter, livraison — proposés au début de chaque commande."
            />
            {/*
             * A register could be given a list of service modes and no default, so the till opened
             * on "choose one" every time even where a venue only ever does one (BOF-032).
             *
             * Choosing a default adds it to the available list if it is not already there — an
             * unavailable default is a register whose opening screen offers a mode it then refuses.
             */}
            <SelectField
                label="Service par défaut"
                value={form.data.default_preset_id === null ? '' : String(form.data.default_preset_id)}
                error={form.errors.default_preset_id}
                placeholder="Aucun"
                disabled={!form.data.use_presets}
                lockedReason={form.data.use_presets ? undefined : 'Activez d’abord les modes de service.'}
                options={options.presets.map((row) => ({ value: String(row.id), label: row.name }))}
                onChange={(chosen) => {
                    const id = chosen === '' ? null : Number(chosen);
                    form.setData('default_preset_id', id);

                    if (id !== null && !form.data.preset_ids.includes(id)) {
                        form.setData('preset_ids', [...form.data.preset_ids, id]);
                    }
                }}
            />
            <MultiSelectField
                label={t('employee.title')}
                values={form.data.employee_ids}
                options={options.employees.map((row) => ({ value: String(row.id), label: `${row.name} · ${row.default_role}` }))}
                onChange={(values) => form.setData('employee_ids', values)}
            />
            <MultiSelectField
                label={t('payment.title')}
                values={form.data.payment_method_ids}
                options={options.payment_methods.map((row) => ({ value: String(row.id), label: row.name }))}
                onChange={(values) => form.setData('payment_method_ids', values)}
            />

            <div className="md:col-span-2 xl:col-span-3 space-y-4">
                <AccessLevels form={form} options={options} />
                <AbilityOverride form={form} options={options} />
            </div>
        </div>
    );
}

/**
 * The level each attached employee holds **on this register** (BOF-122, BAN-446).
 *
 * `pos_config_employee.access_level` has existed since the table was written, with a CHECK
 * constraint and a default of `basic`, and the pivot was synced as bare ids — so every employee on
 * every register sat at the default, and "this cashier is advanced on till 2 only" could not be
 * expressed at all.
 */
function AccessLevels({
    form,
    options,
}: {
    form: ReturnType<typeof useForm<ConfigForm>>;
    options: PosConfigOptions;
}): JSX.Element {
    const t = useT();

    const attached = options.employees.filter((row) => form.data.employee_ids.includes(row.id));

    if (attached.length === 0) {
        return <Notice tone="info">{t('config.accessLevelsEmpty')}</Notice>;
    }

    return (
        <Card>
            <CardHeader title={t('config.accessLevels')} description={t('config.accessLevelsHint')} />
            <CardBody className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {attached.map((employee) => (
                    <SelectField
                        key={employee.id}
                        label={employee.name}
                        value={form.data.employee_access_levels[String(employee.id)] ?? 'basic'}
                        options={ACCESS_LEVELS.map((level) => ({ value: level.value, label: level.label }))}
                        onChange={(value) =>
                            form.setData('employee_access_levels', {
                                ...form.data.employee_access_levels,
                                [String(employee.id)]: value,
                            })
                        }
                    />
                ))}
            </CardBody>
        </Card>
    );
}

/**
 * Per-register ability overrides (BOF-124, BAN-451).
 *
 * `EmployeeAuthService::abilitiesFor()` has read `role_abilities` off the config since it was
 * written — and the column was never created, so it answered null on every register and the
 * override had never once applied.
 *
 * Off by default, and switching it off restores `null` rather than `{}`: null means "use the venue
 * defaults", an empty object means "this role gets nothing". Collapsing those two would make
 * revoking every ability from a role silently give them all back.
 */
function AbilityOverride({
    form,
    options,
}: {
    form: ReturnType<typeof useForm<ConfigForm>>;
    options: PosConfigOptions;
}): JSX.Element {
    const t = useT();
    const defaults = options.ability_defaults;
    const override = form.data.role_abilities;

    const everyAbility = useMemo(
        () => [...new Set(Object.values(defaults).flat())].sort(),
        [defaults],
    );

    const toggle = (role: string, ability: string): void => {
        const current = override?.[role] ?? defaults[role] ?? [];
        const next = current.includes(ability)
            ? current.filter((a) => a !== ability)
            : [...current, ability];

        form.setData('role_abilities', {
            ...(override ?? defaults),
            [role]: next,
        });
    };

    return (
        <Card>
            <CardHeader
                title={t('config.abilityOverride')}
                description={t('config.abilityOverrideHint')}
                actions={
                    <ToggleField
                        label={t('config.abilityOverrideOn')}
                        checked={override !== null}
                        onChange={(on) => form.setData('role_abilities', on ? { ...defaults } : null)}
                    />
                }
            />
            {override === null ? null : (
                <CardBody className="overflow-x-auto p-0">
                    <table className="w-full border-collapse text-sm">
                        <caption className="sr-only">{t('config.abilityOverride')}</caption>
                        <thead className="bg-slate-50">
                            <tr>
                                <th scope="col" className="px-4 py-2 text-start text-xs uppercase text-slate-600">
                                    {t('employee.ability')}
                                </th>
                                {Object.keys(defaults).map((role) => (
                                    <th key={role} scope="col" className="px-4 py-2 text-xs uppercase text-slate-600">
                                        {role}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {everyAbility.map((ability) => (
                                <tr key={ability} className="border-t border-slate-100">
                                    <th scope="row" className="px-4 py-2 text-start font-normal text-slate-700">
                                        {ability}
                                    </th>
                                    {Object.keys(defaults).map((role) => (
                                        <td key={role} className="px-4 py-2 text-center">
                                            <input
                                                type="checkbox"
                                                className="h-4 w-4 rounded border-slate-300"
                                                aria-label={`${role} · ${ability}`}
                                                checked={(override[role] ?? []).includes(ability)}
                                                onChange={() => toggle(role, ability)}
                                            />
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </CardBody>
            )}
        </Card>
    );
}

/**
 * Paired devices and the pairing-code minter.
 *
 * The code is single-use with a ten-minute TTL (spec 05 §1), so it is shown once, big, with a
 * live countdown — an operator walking a tablet across a dining room needs to know whether the
 * code on their screen is still good.
 */
function DevicesPanel({
    configUuid,
    devices,
}: {
    configUuid: string;
    devices: PairedDevice[] | undefined;
}): JSX.Element {
    const t = useT();
    const toast = useToast();
    const [code, setCode] = useState<PairingCodeResponse | null>(null);
    const [busy, setBusy] = useState(false);
    const [deviceType, setDeviceType] = useState('register');

    const mint = useCallback(async () => {
        setBusy(true);
        try {
            const response = await postJson<PairingCodeResponse>(routes.posConfigs.pairingCodes(configUuid), {
                device_type: deviceType,
            });
            setCode(response);
        } catch (error) {
            toast.show({
                tone: 'danger',
                title: t('config.pairingFailed'),
                message: error instanceof HttpError ? error.message : undefined,
            });
        } finally {
            setBusy(false);
        }
    }, [configUuid, deviceType, t, toast]);

    return (
        <Card>
            <CardHeader
                title={t('config.devices')}
                actions={
                    <div className="flex flex-wrap items-center gap-2">
                        <label className="sr-only" htmlFor="pairing-device-type">
                            {t('device.type')}
                        </label>
                        <select
                            id="pairing-device-type"
                            value={deviceType}
                            onChange={(event) => setDeviceType(event.target.value)}
                            className="min-h-touch rounded-pos bg-white px-3 text-sm ring-1 ring-inset ring-slate-300"
                        >
                            <option value="register">register</option>
                            <option value="kiosk">kiosk</option>
                            <option value="customer_display">customer_display</option>
                            <option value="self_mobile">self_mobile</option>
                            <option value="prep_display">prep_display</option>
                        </select>
                        <Button size="md" loading={busy} onClick={() => void mint()}>
                            {t('config.pairing')}
                        </Button>
                    </div>
                }
            />
            <CardBody className="space-y-4">
                {code ? (
                    <div className="rounded-pos bg-brand-50 p-4 text-center ring-1 ring-brand-200">
                        <div className="text-sm text-brand-800">{t('config.pairingCode')}</div>
                        <div className="mt-1 font-mono text-3xl font-bold tracking-[0.3em] text-brand-900">
                            {code.code}
                        </div>
                        <div className="mt-1 text-xs text-brand-800">
                            {t('config.pairingExpires', { seconds: code.ttl_seconds })} · {dateTime(code.expires_at)}
                        </div>
                    </div>
                ) : null}

                <DeferredRegion value={devices} label={t('config.devices')} rows={2}>
                    {(rows) =>
                        rows.length === 0 ? (
                            <p className="text-sm text-slate-500">{t('state.empty')}</p>
                        ) : (
                            <ul className="divide-y divide-slate-100">
                                {rows.map((device) => (
                                    <li key={device.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                                        <Badge tone={device.active ? 'ok' : 'neutral'}>{device.device_type}</Badge>
                                        <span className="font-medium text-slate-800">
                                            {device.name ?? `#${device.device_identifier}`}
                                        </span>
                                        <span className="text-slate-500">
                                            {t('device.identifier')} {device.device_identifier}
                                        </span>
                                        <span className="ms-auto text-xs text-slate-500">
                                            {t('device.lastSeen')} {dateTime(device.last_seen_at)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )
                    }
                </DeferredRegion>
            </CardBody>
        </Card>
    );
}
