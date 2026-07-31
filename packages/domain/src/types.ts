/**
 * Client-side row types — the TypeScript shape of the bootstrap payload (docs/spec/01-schema.md §5).
 *
 * Conventions, all load-bearing:
 *
 *  - **Money is `string`.** decimal(16,4) on the wire, `Decimal` in `@domain/money`. Never `number`
 *    for anything that will be persisted or compared (docs/CONVENTIONS.md "Money").
 *  - **Quantities are `number`.** decimal(16,3), never summed into money without going through the
 *    tax engine.
 *  - **Timestamps are ISO-8601 `string`** exactly as the server sent them. Only `*Local` fields
 *    (client-side bookkeeping) are epoch-ms numbers.
 *  - **Static rows** are keyed by the server `id: number`. **Dynamic rows** (anything the register
 *    can create offline) are keyed by `uuid: string`; `id` stays `null` until the first successful
 *    sync (spec 03 §3.1).
 *  - Fields suffixed `Search` / `Digits` / `Local` are **client-computed at ingest** and never sent
 *    to the server (spec 03 §3.3).
 *  - The `Row` suffix keeps these names distinct from the tax/pricing engine's input types
 *    (`TaxDefinition`, `PricelistItem`, …) which model *computation*, not *storage*.
 */

import type {
    AccessLevel,
    AttributeCreateVariant,
    AttributeDisplayType,
    BarcodeEncoding,
    BarcodeRuleType,
    CashRoundingMethod,
    DefaultScreen,
    DeviceType,
    EmployeeRole,
    OrderPrepState,
    OrderSource,
    OrderState,
    PaymentMethodType,
    PaymentStatus,
    PrepOrderState,
    PrepStageType,
    PresetIdentification,
    PresetServiceAt,
    PriceType,
    PrinterType,
    ProductType,
    SelfOrderMode,
    SelfOrderPayAfter,
    SelfOrderServiceMode,
    SessionState,
    SpecialKind,
    SymbolPosition,
    TableShape,
    TaxAmountType,
    TaxDisplay,
    TaxRoundingMethod,
    TaxScope,
    UomType,
    UpcEanConversion,
} from './enums';

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** A client-minted identifier. Branded so a raw string cannot be passed by accident. */
export type Uuid = string & { readonly __brand: 'uuid' };

/** Cast a string that is known to be a uuid. */
export function asUuid(value: string): Uuid {
    return value as Uuid;
}

/** decimal(16,4) on the wire. */
export type Money = string;

/** ISO-8601 with millisecond precision, as produced by the server. */
export type Iso = string;

/** Epoch milliseconds from the *client* clock. Display / ordering only. */
export type EpochMs = number;

/** Sync lifecycle of a dynamic record (spec 03 §3.4.6). */
export type SyncState = 'local' | 'queued' | 'syncing' | 'synced' | 'error' | 'quarantined';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration & reference data
// ─────────────────────────────────────────────────────────────────────────────

export type SettingRow = {
    id: number;
    key: string;
    value: string | null;
    value_type: 'string' | 'int' | 'float' | 'bool' | 'json';
    company_id: number | null;
};

export type CurrencyRow = {
    id: number;
    name: string;
    symbol: string;
    iso_code: string;
    decimal_places: number;
    rounding: Money;
    symbol_position: SymbolPosition;
    thousands_separator: string;
    decimal_separator: string;
    rate: Money;
};

export type CompanyRow = {
    id: number;
    name: string;
    currency_id: number;
    country_id: number | null;
    vat: string | null;
    phone: string | null;
    email: string | null;
    website: string | null;
    street: string | null;
    city: string | null;
    zip: string | null;
    logo_media_id: number | null;
    barcode_nomenclature_id: number | null;
};

export type CountryRow = {
    id: number;
    name: string;
    code: string;
    phone_code: number | null;
    vat_label: string | null;
};

export type UomRow = {
    id: number;
    uom_category_id: number;
    name: string;
    uom_type: UomType;
    factor: string;
    rounding: string;
    is_pos_groupable: boolean;
};

export type DecimalPrecisionRow = {
    id: number;
    name: string;
    digits: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tax
// ─────────────────────────────────────────────────────────────────────────────

export type TaxGroupRow = {
    id: number;
    name: string;
    sequence: number;
    preceding_subtotal: string | null;
};

export type TaxRow = {
    id: number;
    company_id: number;
    name: string;
    /** Printed on the receipt next to the amount. */
    label: string | null;
    amount_type: TaxAmountType;
    amount: string;
    tax_group_id: number;
    tax_scope: TaxScope | null;
    price_include: boolean;
    include_base_amount: boolean;
    is_base_affected: boolean;
    sequence: number;
    /** For `amount_type: 'group'` — the ids in `tax_children`, in sequence order. */
    children_tax_ids: number[];
    active: boolean;
};

export type FiscalPositionRow = {
    id: number;
    company_id: number;
    name: string;
    country_id: number | null;
    auto_apply: boolean;
    sequence: number;
};

export type FiscalPositionTaxRow = {
    id: number;
    fiscal_position_id: number;
    source_tax_id: number;
    /** `null` ⇒ the source tax is removed entirely. */
    dest_tax_id: number | null;
};

export type CashRoundingRow = {
    id: number;
    name: string;
    rounding: Money;
    rounding_method: CashRoundingMethod;
    strategy: 'add_invoice_line' | 'biggest_tax';
};

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

export type PosCategoryRow = {
    id: number;
    name: string;
    parent_id: number | null;
    sequence: number;
    color: number;
    image_media_id: number | null;
    has_image: boolean;
    self_order_visible: boolean;
    hour_after: number | null;
    hour_until: number | null;
    /** Precomputed at ingest: root → leaf, used for the breadcrumb and descendant filtering. */
    ancestorIds: number[];
};

export type ProductCategoryRow = {
    id: number;
    name: string;
    parent_id: number | null;
    complete_name: string;
};

export type ProductRow = {
    id: number;
    uuid: string;
    company_id: number;
    name: string;
    product_category_id: number | null;
    product_type: ProductType;
    default_code: string | null;
    barcode: string | null;
    uom_id: number;
    list_price: Money;
    standard_price: Money;
    tax_ids: number[];
    pos_category_ids: number[];
    tag_ids: number[];
    optional_product_ids: number[];
    combo_ids: number[];
    available_in_pos: boolean;
    self_order_available: boolean;
    to_weight: boolean;
    track_stock: boolean;
    allow_negative_stock: boolean;
    is_special: boolean;
    special_kind: SpecialKind;
    description_sale: string | null;
    public_description: string | null;
    color: number;
    pos_sequence: number;
    is_favorite: boolean;
    image_media_id: number | null;
    has_image: boolean;
    attribute_count: number;
    combo_count: number;
    active: boolean;
    updated_at: Iso;

    /** Client-computed: folded, lowercased `name + code + barcode` (spec 03 §3.3). */
    searchText: string;
};

export type ProductVariantRow = {
    id: number;
    uuid: string;
    product_id: number;
    company_id: number;
    name_suffix: string | null;
    display_name: string;
    default_code: string | null;
    barcode: string | null;
    price_extra: Money;
    /** `null` ⇒ derive from `products.list_price + price_extra`. */
    list_price: Money | null;
    standard_price: Money;
    on_hand_qty: number;
    self_order_available: boolean;
    is_active_combination: boolean;
    attribute_line_value_ids: number[];
    tax_ids: number[] | null;
    image_media_id: number | null;
    active: boolean;
    updated_at: Iso;

    /** Client-computed, includes the parent product's terms. */
    searchText: string;
};

export type ProductPackagingRow = {
    id: number;
    product_variant_id: number;
    name: string;
    qty: number;
    barcode: string | null;
};

export type ProductTagRow = {
    id: number;
    name: string;
    color: number;
    visible_to_customers: boolean;
    pos_description: string | null;
};

export type ProductAttributeRow = {
    id: number;
    name: string;
    display_type: AttributeDisplayType;
    create_variant: AttributeCreateVariant;
    sequence: number;
};

export type ProductAttributeValueRow = {
    id: number;
    product_attribute_id: number;
    name: string;
    html_color: string | null;
    image_media_id: number | null;
    is_custom: boolean;
    sequence: number;
};

export type ProductAttributeLineRow = {
    id: number;
    product_id: number;
    product_attribute_id: number;
    is_required: boolean;
    sequence: number;
};

/** The id order lines actually reference (Odoo's `product.template.attribute.value`). */
export type ProductAttributeLineValueRow = {
    id: number;
    product_attribute_line_id: number;
    product_attribute_value_id: number;
    product_id: number;
    price_extra: Money;
    sequence: number;
    active: boolean;
};

export type ProductAttributeExclusionRow = {
    id: number;
    product_id: number;
    product_attribute_line_value_id: number;
    excluded_value_id: number;
};

export type ComboRow = {
    id: number;
    name: string;
    base_price: Money;
    qty_free: number;
    qty_max: number;
    sequence: number;
};

export type ComboItemRow = {
    id: number;
    combo_id: number;
    product_variant_id: number;
    extra_price: Money;
    sequence: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Pricing
// ─────────────────────────────────────────────────────────────────────────────

export type PricelistRow = {
    id: number;
    company_id: number;
    name: string;
    currency_id: number;
    discount_policy: 'with_discount' | 'without_discount';
    sequence: number;
    active: boolean;
};

export type PricelistItemRow = {
    id: number;
    pricelist_id: number;
    applied_on: 'variant' | 'product' | 'pos_category' | 'global';
    product_variant_id: number | null;
    product_id: number | null;
    pos_category_id: number | null;
    min_quantity: number;
    date_start: Iso | null;
    date_end: Iso | null;
    compute_price: 'fixed' | 'percentage' | 'formula';
    fixed_price: Money;
    percent_price: string;
    base: 'list_price' | 'standard_price' | 'pricelist';
    base_pricelist_id: number | null;
    price_discount: string;
    price_round: string;
    price_surcharge: Money;
    price_min_margin: Money;
    price_max_margin: Money;
    sequence: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Barcode
// ─────────────────────────────────────────────────────────────────────────────

export type BarcodeNomenclatureRow = {
    id: number;
    name: string;
    upc_ean_conv: UpcEanConversion;
    is_gs1: boolean;
};

export type BarcodeRuleRow = {
    id: number;
    barcode_nomenclature_id: number;
    name: string;
    rule_type: BarcodeRuleType;
    pattern: string;
    encoding: BarcodeEncoding;
    alias: string | null;
    sequence: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// POS configuration
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentMethodRow = {
    id: number;
    company_id: number;
    name: string;
    method_type: PaymentMethodType;
    is_cash_count: boolean;
    /** Cashier must attach a customer before this method can be used. */
    identify_customer: boolean;
    split_transactions: boolean;
    payment_provider_id: number | null;
    terminal_provider: string | null;
    image_media_id: number | null;
    sequence: number;
    active: boolean;
};

export type PosPresetRow = {
    id: number;
    name: string;
    service_at: PresetServiceAt;
    identification: PresetIdentification;
    pricelist_id: number | null;
    fiscal_position_id: number | null;
    is_timing: boolean;
    slots_per_interval: number;
    interval_time_minutes: number;
    color: number;
    available_in_self: boolean;
    sequence: number;
};

export type PresetServiceWindowRow = {
    id: number;
    pos_preset_id: number;
    day_of_week: number;
    start_hour: string;
    end_hour: string;
};

export type PosNoteRow = {
    id: number;
    name: string;
    color: number;
    scope: 'line' | 'order' | 'both';
    sequence: number;
};

export type PosBillRow = {
    id: number;
    name: string;
    value: Money;
    currency_id: number | null;
    sequence: number;
};

export type PosPrinterRow = {
    id: number;
    name: string;
    printer_type: PrinterType;
    /** ip[:port] for network printers, agent printer id for the print agent. */
    address: string | null;
    epos_device_id: string | null;
    profile: string | null;
    pos_category_ids: number[];
    print_receipt: boolean;
    sequence: number;
};

export type PosConfigRow = {
    id: number;
    uuid: string;
    company_id: number;
    name: string;
    currency_id: number;
    /** Bumped by any change that invalidates the client cache wholesale (spec 01 §5.5). */
    config_revision: number;

    sequence_prefix: string | null;
    default_screen: DefaultScreen;
    is_restaurant: boolean;
    use_preparation_display: boolean;
    module_pos_restaurant_bill_split: boolean;

    iface_tax_included: TaxDisplay;
    tax_rounding_method: TaxRoundingMethod;
    cash_rounding_id: number | null;
    pricelist_id: number | null;
    available_pricelist_ids: number[];
    default_fiscal_position_id: number | null;
    available_fiscal_position_ids: number[];
    payment_method_ids: number[];
    pos_category_ids: number[];
    limit_categories: boolean;
    limited_product_count: number;
    limited_customer_count: number;

    default_preset_id: number | null;
    available_preset_ids: number[];
    floor_ids: number[];
    printer_ids: number[];
    prep_display_ids: number[];
    note_ids: number[];
    bill_ids: number[];
    trusted_config_ids: number[];

    iface_start_categ_id: number | null;
    iface_available_categ_ids: number[];
    iface_print_auto: boolean;
    iface_print_skip_screen: boolean;
    iface_electronic_scale: boolean;
    iface_customer_facing_display: boolean;
    iface_big_scrollbars: boolean;
    cash_control: boolean;
    amount_authorized_diff: Money | null;
    restrict_price_control: boolean;
    manual_discount: boolean;
    ship_later: boolean;
    set_maximum_difference: boolean;

    receipt_header: string | null;
    receipt_footer: string | null;
    receipt_logo_media_id: number | null;
    ticket_url_display_mode: string | null;

    self_ordering_mode: SelfOrderMode;
    self_ordering_service_mode: SelfOrderServiceMode;
    self_ordering_pay_after: SelfOrderPayAfter;
    self_ordering_default_language: string | null;
    self_ordering_available_languages: string[];
    self_ordering_image_media_id: number | null;
    self_order_online_payment_method_id: number | null;
    access_token: string | null;

    employee_idle_logout_seconds: number;
    allow_offline_manager_override: boolean;
    role_abilities: Record<string, string[]> | null;

    active: boolean;
    updated_at: Iso;
};

// ─────────────────────────────────────────────────────────────────────────────
// Restaurant / kitchen
// ─────────────────────────────────────────────────────────────────────────────

export type RestaurantFloorRow = {
    id: number;
    pos_config_ids: number[];
    name: string;
    background_color: string | null;
    background_media_id: number | null;
    sequence: number;
    active: boolean;
};

export type RestaurantTableRow = {
    id: number;
    floor_id: number;
    /** Merged tables resolve to their parent for ordering purposes. */
    parent_id: number | null;
    table_number: string;
    identifier: string | null;
    seats: number;
    shape: TableShape;
    position_h: number;
    position_v: number;
    width: number;
    height: number;
    color: string | null;
    active: boolean;
};

export type PrepDisplayRow = {
    id: number;
    name: string;
    pos_config_ids: number[];
    pos_category_ids: number[];
    layout: string;
    done_retention_minutes: number;
    auto_clear_minutes: number | null;
    access_token: string | null;
};

export type PrepStageRow = {
    id: number;
    prep_display_id: number;
    name: string;
    stage_type: PrepStageType;
    color: string | null;
    alert_after_minutes: number | null;
    sequence: number;
};

export type PrepOrderRow = {
    uuid: Uuid;
    id: number | null;
    prep_display_id: number;
    pos_order_uuid: Uuid;
    order_reference: string;
    tracking_number: string | null;
    table_name: string | null;
    preset_name: string | null;
    customer_note: string | null;
    state: PrepOrderState;
    fired_at: Iso | null;
    ready_at: Iso | null;
    served_at: Iso | null;
    course_index: number | null;
    updatedAtLocal: EpochMs;
};

export type PrepOrderLineRow = {
    uuid: Uuid;
    id: number | null;
    prep_order_uuid: Uuid;
    pos_order_line_uuid: Uuid;
    prep_stage_id: number;
    product_name: string;
    quantity: number;
    note: string | null;
    attributes: string[];
    state: 'todo' | 'in_progress' | 'ready' | 'served' | 'cancelled';
    is_cancelled: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

export type EmployeeRow = {
    id: number;
    uuid: string;
    name: string;
    default_role: EmployeeRole;
    access_level: AccessLevel;
    avatar_media_id: number | null;
    avatar_url: string | null;
    has_pin: boolean;
    /** HMAC-SHA256(device_secret, "pin:<id>:<pin>") — device-scoped, never a PIN hash. */
    pin_verifier: string | null;
    /** HMAC-SHA256(device_secret, "badge:<id>:<code>"). */
    badge_verifier: string | null;
    /** Resolved server-side from role + config overrides (spec 03 §2.5). */
    abilities: string[];
    active: boolean;
};

export type CustomerRow = {
    id: number;
    uuid: string;
    name: string;
    company_name: string | null;
    email: string | null;
    phone: string | null;
    mobile: string | null;
    vat: string | null;
    street: string | null;
    city: string | null;
    zip: string | null;
    country_id: number | null;
    state_id: number | null;
    barcode: string | null;
    pricelist_id: number | null;
    fiscal_position_id: number | null;
    loyalty_card_ids: number[];
    order_count: number;
    updated_at: Iso;

    /** Client-computed. */
    searchText: string;
    /** Client-computed: every digit of every phone number, concatenated. */
    phoneDigits: string;
};

export type PosDeviceRow = {
    id: number;
    uuid: string;
    pos_config_id: number;
    device_identifier: string;
    name: string;
    device_type: DeviceType;
    /** Small integer, unique per config — the entire reference-collision defence (spec 03 §6.1). */
    device_seq: number;
    current_employee_id: number | null;
};

export type PosSessionRow = {
    id: number;
    uuid: string;
    pos_config_id: number;
    /** Human-readable session reference, e.g. `SALLE/00042`. Mirrors `pos_sessions.name`. */
    name: string;
    opened_by_employee_id: number | null;
    state: SessionState;
    opened_at: Iso | null;
    closed_at: Iso | null;
    opening_float: Money;
    closing_balance: Money | null;
    order_seq: number;
    is_rescue: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Orders — dynamic records, keyed by uuid
// ─────────────────────────────────────────────────────────────────────────────

/** What the kitchen has already been told, so a re-fire only sends the delta. */
export type PrepSnapshot = {
    at: Iso;
    lines: Record<string, number>;
    noteHash: string;
};

export type OrderBaseline = {
    serverRev: string | null;
    order: Partial<OrderRow>;
    lines: Record<string, Partial<OrderLineRow>>;
    payments: Record<string, Partial<PaymentRow>>;
    deletedLineUuids: string[];
};

export type OrderRow = {
    uuid: Uuid;
    /** Server id, `null` until the first successful sync. */
    id: number | null;
    pos_session_id: number;
    pos_config_id: number;
    company_id: number;
    pos_device_id: number | null;

    name: string | null;
    receipt_number: string;
    tracking_number: string;
    sequence_number: number | null;
    access_token: string;
    ticket_code: string | null;
    source: OrderSource;

    state: OrderState;
    ordered_at: Iso;
    paid_at: Iso | null;
    closed_at: Iso | null;
    cancelled_at: Iso | null;
    cancel_reason: string | null;

    customer_id: number | null;
    employee_id: number | null;
    pricelist_id: number | null;
    fiscal_position_id: number | null;
    pos_preset_id: number | null;
    preset_time: Iso | null;
    currency_id: number;
    currency_rate: string;
    floating_order_name: string | null;

    /** Server-authoritative; present once acknowledged (spec 03 §3.7). */
    amount_untaxed: Money;
    amount_tax: Money;
    amount_total: Money;
    amount_rounding: Money;
    amount_paid: Money;
    amount_change: Money;
    amount_due: Money;
    amount_discount: Money;

    restaurant_table_id: number | null;
    guest_count: number;
    is_tipped: boolean;
    tip_amount: Money;
    split_from_order_uuid: Uuid | null;
    split_letter: string | null;

    is_refund: boolean;
    refunded_order_uuid: Uuid | null;
    to_invoice: boolean;

    general_customer_note: string | null;
    internal_note: string | null;
    prep_state: OrderPrepState;
    unsent_change_count: number;
    last_prep_sent_at: Iso | null;
    last_prep_snapshot: PrepSnapshot | null;

    self_order_table_id: number | null;
    table_stand_number: string | null;
    customer_email: string | null;
    customer_phone: string | null;

    print_count: number;
    is_edited: boolean;
    client_created_at: Iso;

    // ── client-only sync bookkeeping, never sent ──────────────────────────────
    updatedAtLocal: EpochMs;
    syncState: SyncState;
    syncError: SyncErrorShape | null;
    /** Bumped on every mutation. The memo key for every derived value (spec 03 §3.4.4). */
    rev: number;
    baseline: OrderBaseline | null;
};

export type OrderLineRow = {
    uuid: Uuid;
    id: number | null;
    order_uuid: Uuid;
    line_number: number;

    product_variant_id: number;
    product_id: number;
    /** Frozen at sale time — kitchen routing must survive a later recategorisation. */
    pos_category_id: number | null;
    full_product_name: string;
    uom_id: number;

    quantity: number;
    price_unit: Money;
    price_extra: Money;
    price_type: PriceType;
    discount_percent: string;
    discount_notice: string | null;

    /** Client proposal; the server recomputes and overwrites on ack. */
    price_subtotal: Money;
    price_subtotal_incl: Money;

    tax_ids: number[];
    attribute_line_value_ids: number[];
    custom_attribute_values: Array<{ uuid: Uuid; value_id: number; custom_value: string }>;

    customer_note: string | null;
    internal_note: Array<{ text: string; color_index: number }> | null;

    combo_parent_uuid: Uuid | null;
    combo_id: number | null;
    combo_item_id: number | null;
    course_uuid: Uuid | null;

    refunded_line_uuid: Uuid | null;
    refunded_line_id: number | null;
    refunded_quantity: number;

    skip_preparation: boolean;
    is_edited: boolean;
    rev: number;
};

export type PaymentRow = {
    uuid: Uuid;
    id: number | null;
    order_uuid: Uuid;
    pos_session_id: number;
    payment_method_id: number;
    currency_id: number;
    amount: Money;
    is_change: boolean;
    is_refund: boolean;
    label: string | null;
    paid_at: Iso;
    customer_id: number | null;
    employee_id: number | null;
    payment_status: PaymentStatus;

    card_brand: string | null;
    card_last4: string | null;
    auth_code: string | null;
    transaction_reference: string | null;
    terminal_ticket: string | null;
    rev: number;
};

export type CourseRow = {
    uuid: Uuid;
    id: number | null;
    order_uuid: Uuid;
    index: number;
    name: string | null;
    fired: boolean;
    fired_at: Iso | null;
    rev: number;
};

/** A manager override performed at the till (spec 03 §2.3). */
export type ApprovalRow = {
    uuid: Uuid;
    order_uuid: Uuid | null;
    ability: string;
    manager_employee_id: number;
    verified: 'online' | 'offline';
    at: Iso;
    context: Record<string, string | number | null>;
};

export type AuditEntryRow = {
    uuid: Uuid;
    kind: string;
    employee_id: number | null;
    at: Iso;
    payload: Record<string, unknown>;
    syncedAt: EpochMs | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure rows
// ─────────────────────────────────────────────────────────────────────────────

export type MetaRow = {
    key: string;
    value: unknown;
};

export type BlobRow = {
    key: string;
    blob: Blob;
    contentType: string;
    fetchedAt: EpochMs;
};

export type MediaFileRow = {
    id: number;
    model: string;
    model_id: number;
    collection: string;
    checksum: string;
    url: string;
    variants: Record<string, string>;
};

/** Classified sync failure (spec 03 §3.6.6). */
export type SyncErrorShape =
    | { kind: 'offline' }
    | { kind: 'server_unreachable'; status?: number }
    | { kind: 'auth'; detail: 'revoked' | 'expired' }
    | { kind: 'version'; min: string }
    | { kind: 'validation'; field: string; message: string }
    | { kind: 'conflict'; reason: string; serverState: unknown }
    | { kind: 'rejected'; code: string; message: string }
    | { kind: 'unknown'; message: string };

// ─────────────────────────────────────────────────────────────────────────────
// Device / session context
// ─────────────────────────────────────────────────────────────────────────────

export type DeviceInfo = {
    device_id: string;
    device_identifier: string;
    device_seq: number;
    config_id: number;
    name: string;
    kind: DeviceType;
    app_version: string;
};

export type CashierContext = {
    employee_id: number;
    name: string;
    role: EmployeeRole;
    abilities: readonly string[];
    since: EpochMs;
};

/** Everything the receipt/pricing code needs that is not on the order itself. */
export type PosContext = {
    config: PosConfigRow;
    company: CompanyRow;
    currency: CurrencyRow;
    session: PosSessionRow | null;
    device: DeviceInfo | null;
    cashier: CashierContext | null;
};
