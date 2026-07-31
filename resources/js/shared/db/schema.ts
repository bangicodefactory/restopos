import type { OutboxEntry } from '@domain/sync/outbox';
import type {
    ApprovalRow,
    AuditEntryRow,
    BarcodeNomenclatureRow,
    BarcodeRuleRow,
    BlobRow,
    CashRoundingRow,
    ComboItemRow,
    ComboRow,
    CompanyRow,
    CountryRow,
    CourseRow,
    CurrencyRow,
    CustomerRow,
    EmployeeRow,
    FiscalPositionRow,
    FiscalPositionTaxRow,
    MediaFileRow,
    MetaRow,
    OrderLineRow,
    OrderRow,
    PaymentMethodRow,
    PaymentRow,
    PosBillRow,
    PosCategoryRow,
    PosConfigRow,
    PosDeviceRow,
    PosNoteRow,
    PosPresetRow,
    PosPrinterRow,
    PosSessionRow,
    PrepDisplayRow,
    PrepOrderLineRow,
    PrepOrderRow,
    PrepStageRow,
    PresetServiceWindowRow,
    PricelistItemRow,
    PricelistRow,
    ProductAttributeExclusionRow,
    ProductAttributeLineRow,
    ProductAttributeLineValueRow,
    ProductAttributeRow,
    ProductAttributeValueRow,
    ProductCategoryRow,
    ProductPackagingRow,
    ProductRow,
    ProductVariantRow,
    RestaurantFloorRow,
    RestaurantTableRow,
    SettingRow,
    TaxGroupRow,
    TaxRow,
    UomRow,
} from '@domain/types';
import Dexie, { type Table } from 'dexie';

/**
 * The offline store (spec 03 §3.3).
 *
 * Design decisions, each load-bearing:
 *
 *  - **One database per config** (`pos-3`). A shared back-of-house tablet that operates two
 *    registers keeps two clean datasets, and "reset this register" is `Dexie.delete('pos-3')`.
 *  - **Static rows keyed by the server `id`; dynamic rows keyed by `uuid`.** The uuid is minted by
 *    the client and is the idempotency key for sync forever after; the server `id` is a late-bound
 *    attribute.
 *  - **Precomputed `searchText` / `phoneDigits`** on products, variants and customers. Substring
 *    search over 5 000 precomputed, diacritic-folded strings is ~1 ms; doing `toLocaleLowerCase()`
 *    per keystroke over raw fields is not.
 *  - **Compound indexes** on `pricelistItems` (the hottest non-tax computation) and on
 *    `orders [state+syncState]` (the ticket list and the unsynced-orders data-loss guard).
 *  - **Sync bookkeeping lives on `meta` and `outbox`**, never smeared across the data tables.
 *  - **`blobs` holds `Blob`s natively** — base64 in a string costs 33 % more and forces a decode on
 *    every render. Receipt assets live here rather than in a SW cache because browsers evict SW
 *    caches under pressure far more readily than IndexedDB, and receipts are legally required.
 */
export class PosDb extends Dexie {
    // ── static (server-owned, keyed by id) ───────────────────────────────────
    settings!: Table<SettingRow, number>;
    currencies!: Table<CurrencyRow, number>;
    companies!: Table<CompanyRow, number>;
    countries!: Table<CountryRow, number>;
    uoms!: Table<UomRow, number>;

    taxGroups!: Table<TaxGroupRow, number>;
    taxes!: Table<TaxRow, number>;
    fiscalPositions!: Table<FiscalPositionRow, number>;
    fiscalPositionTaxes!: Table<FiscalPositionTaxRow, number>;
    cashRoundings!: Table<CashRoundingRow, number>;

    posCategories!: Table<PosCategoryRow, number>;
    productCategories!: Table<ProductCategoryRow, number>;
    products!: Table<ProductRow, number>;
    variants!: Table<ProductVariantRow, number>;
    packagings!: Table<ProductPackagingRow, number>;
    attributes!: Table<ProductAttributeRow, number>;
    attributeValues!: Table<ProductAttributeValueRow, number>;
    attributeLines!: Table<ProductAttributeLineRow, number>;
    attributeLineValues!: Table<ProductAttributeLineValueRow, number>;
    attributeExclusions!: Table<ProductAttributeExclusionRow, number>;
    combos!: Table<ComboRow, number>;
    comboItems!: Table<ComboItemRow, number>;

    pricelists!: Table<PricelistRow, number>;
    pricelistItems!: Table<PricelistItemRow, number>;

    barcodeNomenclatures!: Table<BarcodeNomenclatureRow, number>;
    barcodeRules!: Table<BarcodeRuleRow, number>;

    paymentMethods!: Table<PaymentMethodRow, number>;
    presets!: Table<PosPresetRow, number>;
    presetWindows!: Table<PresetServiceWindowRow, number>;
    notes!: Table<PosNoteRow, number>;
    bills!: Table<PosBillRow, number>;
    printers!: Table<PosPrinterRow, number>;
    configs!: Table<PosConfigRow, number>;

    floors!: Table<RestaurantFloorRow, number>;
    restaurantTables!: Table<RestaurantTableRow, number>;
    prepDisplays!: Table<PrepDisplayRow, number>;
    prepStages!: Table<PrepStageRow, number>;

    employees!: Table<EmployeeRow, number>;
    customers!: Table<CustomerRow, number>;
    devices!: Table<PosDeviceRow, number>;
    sessions!: Table<PosSessionRow, number>;
    mediaFiles!: Table<MediaFileRow, number>;

    // ── dynamic (client-creatable, keyed by uuid) ────────────────────────────
    orders!: Table<OrderRow, string>;
    lines!: Table<OrderLineRow, string>;
    payments!: Table<PaymentRow, string>;
    courses!: Table<CourseRow, string>;
    approvals!: Table<ApprovalRow, string>;
    prepOrders!: Table<PrepOrderRow, string>;
    prepOrderLines!: Table<PrepOrderLineRow, string>;

    // ── infrastructure ───────────────────────────────────────────────────────
    outbox!: Table<OutboxEntry, string>;
    meta!: Table<MetaRow, string>;
    auditLog!: Table<AuditEntryRow, string>;
    blobs!: Table<BlobRow, string>;

    readonly configId: number;

    constructor(configId: number) {
        super(dbNameFor(configId));
        this.configId = configId;

        this.version(1).stores({
            settings: 'id, key',
            currencies: 'id',
            companies: 'id',
            countries: 'id, code',
            uoms: 'id, uom_category_id',

            taxGroups: 'id',
            taxes: 'id, tax_group_id',
            fiscalPositions: 'id',
            fiscalPositionTaxes: 'id, fiscal_position_id, [fiscal_position_id+source_tax_id]',
            cashRoundings: 'id',

            posCategories: 'id, parent_id, sequence',
            productCategories: 'id, parent_id',
            products: 'id, *pos_category_ids, barcode, default_code, searchText, pos_sequence, product_type, is_special',
            variants: 'id, product_id, barcode, default_code, searchText',
            packagings: 'id, product_variant_id, barcode',
            attributes: 'id',
            attributeValues: 'id, product_attribute_id',
            attributeLines: 'id, product_id, product_attribute_id',
            attributeLineValues: 'id, product_attribute_line_id, product_id',
            attributeExclusions: 'id, product_id, product_attribute_line_value_id',
            combos: 'id',
            comboItems: 'id, combo_id, product_variant_id',

            pricelists: 'id',
            // These four compound indexes are why pricelist resolution is index-driven, not a scan.
            pricelistItems:
                'id, pricelist_id, [pricelist_id+product_variant_id], [pricelist_id+product_id], [pricelist_id+pos_category_id], [pricelist_id+applied_on]',

            barcodeNomenclatures: 'id',
            barcodeRules: 'id, barcode_nomenclature_id, sequence',

            paymentMethods: 'id, sequence',
            presets: 'id, sequence',
            presetWindows: 'id, pos_preset_id',
            notes: 'id, sequence',
            bills: 'id, sequence',
            printers: 'id, *pos_category_ids',
            configs: 'id',

            floors: 'id, sequence',
            restaurantTables: 'id, floor_id, parent_id',
            prepDisplays: 'id',
            prepStages: 'id, prep_display_id, sequence',

            employees: 'id, name',
            customers: 'id, barcode, searchText, phoneDigits',
            devices: 'id, device_identifier',
            sessions: 'id, state',
            mediaFiles: 'id, [model+model_id]',

            orders: 'uuid, id, state, syncState, pos_session_id, restaurant_table_id, updatedAtLocal, [state+syncState]',
            lines: 'uuid, order_uuid, product_variant_id, course_uuid, combo_parent_uuid',
            payments: 'uuid, order_uuid, payment_method_id',
            courses: 'uuid, order_uuid, index',
            approvals: 'uuid, order_uuid',
            prepOrders: 'uuid, prep_display_id, pos_order_uuid, state, updatedAtLocal',
            prepOrderLines: 'uuid, prep_order_uuid, prep_stage_id, state',

            outbox: 'id, seq, kind, state, nextAttemptAt, targetUuid, [state+nextAttemptAt]',
            meta: 'key',
            auditLog: 'uuid, at, syncedAt',
            blobs: 'key',
        });
    }
}

export function dbNameFor(configId: number): string {
    return `pos-${configId}`;
}

/** Entity name (as sent by the bootstrap payload) → Dexie table. Order = spec 01 §5.2. */
export const ENTITY_TABLES: Record<string, keyof PosDb> = {
    settings: 'settings',
    currencies: 'currencies',
    companies: 'companies',
    countries: 'countries',
    uoms: 'uoms',
    tax_groups: 'taxGroups',
    taxes: 'taxes',
    fiscal_positions: 'fiscalPositions',
    fiscal_position_taxes: 'fiscalPositionTaxes',
    cash_roundings: 'cashRoundings',
    pos_categories: 'posCategories',
    product_categories: 'productCategories',
    products: 'products',
    product_variants: 'variants',
    product_packagings: 'packagings',
    product_attributes: 'attributes',
    product_attribute_values: 'attributeValues',
    product_attribute_lines: 'attributeLines',
    product_attribute_line_values: 'attributeLineValues',
    product_attribute_exclusions: 'attributeExclusions',
    combos: 'combos',
    combo_items: 'comboItems',
    pricelists: 'pricelists',
    pricelist_items: 'pricelistItems',
    barcode_nomenclatures: 'barcodeNomenclatures',
    barcode_rules: 'barcodeRules',
    payment_methods: 'paymentMethods',
    pos_presets: 'presets',
    preset_service_windows: 'presetWindows',
    pos_notes: 'notes',
    pos_bills: 'bills',
    pos_printers: 'printers',
    pos_configs: 'configs',
    restaurant_floors: 'floors',
    restaurant_tables: 'restaurantTables',
    prep_displays: 'prepDisplays',
    prep_stages: 'prepStages',
    employees: 'employees',
    customers: 'customers',
    pos_devices: 'devices',
    pos_sessions: 'sessions',
    media_files: 'mediaFiles',
    pos_orders: 'orders',
    pos_order_lines: 'lines',
    pos_payments: 'payments',
    restaurant_order_courses: 'courses',
    prep_orders: 'prepOrders',
    prep_order_lines: 'prepOrderLines',
};

/** Entities whose primary key is the client-minted uuid rather than the server id. */
export const UUID_KEYED_ENTITIES = new Set([
    'pos_orders',
    'pos_order_lines',
    'pos_payments',
    'restaurant_order_courses',
    'prep_orders',
    'prep_order_lines',
]);

/** Dependency order for applying a bootstrap/delta payload (spec 01 §5.2). */
export const LOAD_ORDER: readonly string[] = [
    'settings',
    'currencies',
    'companies',
    'countries',
    'uoms',
    'tax_groups',
    'taxes',
    'fiscal_positions',
    'fiscal_position_taxes',
    'cash_roundings',
    'pos_categories',
    'product_categories',
    'products',
    'product_variants',
    'product_packagings',
    'product_attributes',
    'product_attribute_values',
    'product_attribute_lines',
    'product_attribute_line_values',
    'product_attribute_exclusions',
    'combos',
    'combo_items',
    'pricelists',
    'pricelist_items',
    'barcode_nomenclatures',
    'barcode_rules',
    'payment_methods',
    'pos_presets',
    'preset_service_windows',
    'pos_notes',
    'pos_bills',
    'pos_printers',
    'restaurant_floors',
    'restaurant_tables',
    'prep_displays',
    'prep_stages',
    'pos_configs',
    'employees',
    'customers',
    'pos_sessions',
    'pos_devices',
    'media_files',
    'pos_orders',
    'pos_order_lines',
    'pos_payments',
    'restaurant_order_courses',
    'prep_orders',
    'prep_order_lines',
];

/** Meta keys. Centralised so a typo cannot silently create a second watermark. */
export const META = {
    configRevision: 'config.revision',
    watermarkGlobal: 'watermark.global',
    watermarkFor: (entity: string): string => `watermark.${entity}`,
    device: 'device',
    deviceToken: 'device.token',
    deviceKey: 'device.key',
    activeEmployee: 'active_employee',
    lastBootstrapAt: 'bootstrap.at',
    bootstrapEtag: 'bootstrap.etag',
    seqOrder: 'seq.order',
    pinLockouts: 'auth.pin_lockouts',
    printerBindings: 'printers.bindings',
    locale: 'ui.locale',
} as const;

let instance: PosDb | null = null;

/** Process-wide singleton. Opening the same Dexie name twice is legal but wasteful. */
export function getDb(configId: number): PosDb {
    if (instance && instance.configId === configId) return instance;
    if (instance) instance.close();
    instance = new PosDb(configId);
    return instance;
}

export function closeDb(): void {
    instance?.close();
    instance = null;
}
