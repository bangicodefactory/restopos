/**
 * `PosConfigs/Index` and `PosConfigs/Edit` props — spec 05 §12.
 *
 * `config` is `$config->attributesToArray()` plus the pivot id arrays, i.e. **every column of
 * `pos_configs`**. They are all declared below rather than hidden behind an index signature: this
 * table is the widest settings surface in the product (BOF-030…BOF-079) and a typo in a field
 * name should be a compile error, not a silently-undefined switch.
 *
 * Decimal columns (`amount_authorized_diff`, `global_discount_percent`) arrive as strings.
 */

import type { Deferred, MoneyString } from '../../types/inertia';

export type PosConfigListRow = {
    id: number;
    uuid: string;
    name: string;
    active: boolean;
    is_restaurant: boolean;
    self_ordering_mode: string;
    currency_id: number;
    config_revision: number;
};

export type PosConfigsIndexProps = {
    configs: PosConfigListRow[];
    currencies: { id: number; code: string; name: string }[];
};

export type PosConfigRecord = {
    id: number;
    uuid: string;
    company_id: number;
    name: string;
    access_token: string;
    currency_id: number;
    cash_rounding_id: number | null;
    use_cash_rounding: boolean;
    only_round_cash_payments: boolean;
    config_revision: number;
    last_config_change_at: string | null;
    active: boolean;

    // catalogue & pricing
    pricelist_id: number | null;
    use_pricelists: boolean;
    limit_categories: boolean;
    tax_display: string;
    use_fiscal_positions: boolean;
    default_fiscal_position_id: number | null;
    show_product_images: boolean;
    show_category_images: boolean;
    group_products_by_category: boolean;
    allow_manual_discount: boolean;
    restrict_price_control: boolean;
    show_margins_to_all: boolean;

    // presets & tips
    use_presets: boolean;
    default_preset_id: number | null;
    enable_tips: boolean;
    tip_product_id: number | null;
    tip_after_payment: boolean;

    // payments
    has_cash_control: boolean;
    set_maximum_difference: boolean;
    amount_authorized_diff: MoneyString | null;
    auto_validate_terminal_payment: boolean;
    use_fast_payment: boolean;
    self_order_online_payment_method_id: number | null;

    // receipts
    show_receipt_header_footer: boolean;
    receipt_header: string | null;
    receipt_footer: string | null;
    basic_receipt: boolean;
    auto_print_receipt: boolean;
    skip_receipt_screen: boolean;

    // restaurant
    is_restaurant: boolean;
    enable_split_bill: boolean;
    enable_bill_print: boolean;
    default_screen: string;
    idle_return_seconds: number;

    // preparation
    use_preparation_printers: boolean;
    use_preparation_display: boolean;
    prep_auto_fire_first_course: boolean;

    // hardware
    use_iot_box: boolean;
    proxy_ip: string | null;
    iot_scan: boolean;
    iot_scale: boolean;
    iot_print: boolean;
    iot_cashdrawer: boolean;
    use_epos_printer: boolean;
    epos_printer_ip: string | null;
    big_scrollbars: boolean;
    customer_display_bg_media_id: number | null;
    /**
     * The receipt's brand mark.
     *
     * `receipt.ts` has built its blob key as `logo:{receipt_logo_media_id}` since it was written and
     * `build.ts` emits the image node — but this field was absent from the back-office wire
     * entirely, so the column could never be set and every receipt printed without a logo.
     */
    receipt_logo_media_id: number | null;

    // barcode
    fallback_barcode_nomenclature_id: number | null;

    // self-order (edited on `SelfOrder/Settings`)
    self_ordering_mode: string;
    self_ordering_service_mode: string;
    self_ordering_pay_after: string;
    self_ordering_default_language_id: number | null;
    self_ordering_default_user_id: number | null;
    self_ordering_brand_name: string | null;
    self_ordering_brand_media_id: number | null;
    self_ordering_primary_color: string | null;
    self_ordering_text_color: string | null;
    kiosk_idle_seconds: number;
    kiosk_confirmation_seconds: number;

    // discount
    enable_global_discount: boolean;
    global_discount_percent: string;
    global_discount_product_id: number | null;

    // flags & limits
    use_employee_login: boolean;
    enable_loyalty: boolean;
    enable_sms_receipt: boolean;
    sms_template_id: number | null;
    email_receipt_template_id: number | null;
    order_edit_tracking: boolean;
    /**
     * Per-register ability overrides keyed by role (BOF-118).
     *
     * `null` means "use the venue defaults in `config/pos.php`". An empty object is not the same
     * thing — it is a deliberate override granting that role nothing.
     */
    role_abilities: Record<string, string[]> | null;
    limited_product_count: number;
    limited_customer_count: number;

    created_at: string | null;
    updated_at: string | null;

    // pivots, appended by the controller
    payment_method_ids: number[];
    pricelist_ids: number[];
    fiscal_position_ids: number[];
    preset_ids: number[];
    printer_ids: number[];
    limited_category_ids: number[];
    employee_ids: number[];
    /** employee id → the level they hold *on this register* (BOF-117). */
    employee_access_levels: Record<string, string>;
    floor_ids: number[];
    prep_display_ids: number[];
    note_ids: number[];
    bill_ids: number[];
};

export type OptionRow = { id: number; name: string };

export type PosConfigOptions = {
    payment_methods: { id: number; name: string; method_type: string; is_cash_count: boolean }[];
    pricelists: { id: number; name: string; currency_id: number }[];
    fiscal_positions: OptionRow[];
    // BOF-033 — the rounding rule a cash total is snapped to. `cash_rounding_id` is meaningless
    // without the list to choose from.
    cash_roundings: { id: number; name: string; rounding: string; rounding_method: string }[];
    presets: { id: number; name: string; service_at: string }[];
    printers: { id: number; name: string; printer_type: string }[];
    categories: { id: number; name: string; parent_id: number | null }[];
    /** Products marked `special_kind = tip` — the only ones a tip can be booked against (RST-120). */
    tip_products: { id: number; name: string }[];
    employees: { id: number; name: string; default_role: string }[];
    /** Ability defaults per role, from `config/pos.php` — what an override starts from. */
    ability_defaults: Record<string, string[]>;
    notes: { id: number; name: string; note_scope: string }[];
    bills: { id: number; name: string; value: string; currency_id: number }[];
};

export type PairedDevice = {
    id: number;
    uuid: string;
    name: string | null;
    device_identifier: number;
    device_type: string;
    last_seen_at: string | null;
    active: boolean;
};

export type PosConfigEditProps = {
    config: PosConfigRecord;
    options: Deferred<PosConfigOptions>;
    devices: Deferred<PairedDevice[]>;
};

export type PairingCodeResponse = {
    code: string;
    expires_at: string;
    ttl_seconds: number;
};

/**
 * The keys `PATCH /pos-configs/{config}` actually validates.
 *
 * Laravel's `validate()` silently drops anything not listed in the rules, so a field outside this
 * set would appear to save and then reappear unchanged after a reload. Every control bound to a
 * key that is *not* here is rendered disabled with `config.readOnly` as the reason — a visibly
 * locked switch is honest; a switch that forgets is not.
 *
 * `currency_id` is the one key the server accepts that is *not* here. It is only settable until the
 * register takes its first payment — after that, changing it would re-denominate every session and
 * order already recorded — so it belongs to register creation (BAN-472) rather than to a settings
 * tab that would refuse it for the rest of the register's life.
 */
export const WRITABLE_CONFIG_KEYS = [
    'name',
    'active',
    'is_restaurant',
    'use_pricelists',
    'limit_categories',
    'tip_after_payment',
    'tip_product_id',
    'use_fiscal_positions',
    'has_cash_control',
    'set_maximum_difference',
    'amount_authorized_diff',
    'use_preparation_display',
    'use_preparation_printers',
    'use_employee_login',
    'enable_tips',
    'enable_split_bill',
    'enable_global_discount',
    'global_discount_percent',
    'limited_product_count',
    'limited_customer_count',
    'receipt_header',
    'receipt_footer',
    'receipt_logo_media_id',
    'customer_display_bg_media_id',
    'use_iot_box',
    'proxy_ip',
    'iot_scan',
    'iot_scale',
    'iot_print',
    'iot_cashdrawer',
    'use_epos_printer',
    'epos_printer_ip',

    // Widened in BAN-466, in step with `PosConfigRequest`. The default pricelist and default
    // fiscal position lead the list because they are the two fields that decide every price the
    // till quotes, and neither could be set at all.
    'pricelist_id',
    'default_fiscal_position_id',
    'default_preset_id',
    'use_presets',
    'tax_display',
    'default_screen',
    'idle_return_seconds',
    'show_product_images',
    'show_category_images',
    'group_products_by_category',
    'big_scrollbars',
    'allow_manual_discount',
    'restrict_price_control',
    'show_margins_to_all',
    'auto_validate_terminal_payment',
    'use_fast_payment',
    'use_cash_rounding',
    'cash_rounding_id',
    'only_round_cash_payments',
    'show_receipt_header_footer',
    'basic_receipt',
    'auto_print_receipt',
    'skip_receipt_screen',
    'enable_bill_print',
    'prep_auto_fire_first_course',
    'order_edit_tracking',

    'payment_method_ids',
    'pricelist_ids',
    'fiscal_position_ids',
    'preset_ids',
    'printer_ids',
    'limited_category_ids',
    'employee_ids',
    'employee_access_levels',
    'role_abilities',
    'floor_ids',
    'prep_display_ids',
    'note_ids',
    'bill_ids',
] as const;

export type WritableConfigKey = (typeof WRITABLE_CONFIG_KEYS)[number];

export function isWritable(key: string): key is WritableConfigKey {
    return (WRITABLE_CONFIG_KEYS as readonly string[]).includes(key);
}
