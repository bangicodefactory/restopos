/**
 * Mirror of `app/Enums/*` — generated from the PHP backed enums and kept in sync by hand.
 *
 * docs/CONVENTIONS.md: "The same literals are re-declared in packages/domain/src/enums.ts —
 * they must match." Every entry below is a verbatim copy of the PHP case value. Adding a case on
 * the PHP side without adding it here is a bug the compiler cannot see, so the pair is covered by
 * tests/Unit/Enums/EnumParityTest.php on the server side.
 *
 * Style: a frozen const object plus a same-named union type, so both a value ("OrderState.Draft")
 * and a type ("state: OrderState") are available without TypeScript's `enum` (which is not
 * erasable and breaks `isolatedModules`).
 */

export const AccessLevel = {
    Minimal: 'minimal',
    Basic: 'basic',
    Advanced: 'advanced',
} as const;
export type AccessLevel = (typeof AccessLevel)[keyof typeof AccessLevel];

export const AccountingExportFormat = {
    Csv: 'csv',
    Json: 'json',
    Xlsx: 'xlsx',
    Api: 'api',
} as const;
export type AccountingExportFormat = (typeof AccountingExportFormat)[keyof typeof AccountingExportFormat];

export const AccountingExportState = {
    Draft: 'draft',
    Generated: 'generated',
    Sent: 'sent',
    Failed: 'failed',
} as const;
export type AccountingExportState = (typeof AccountingExportState)[keyof typeof AccountingExportState];

export const AddressType = {
    Contact: 'contact',
    Invoice: 'invoice',
    Delivery: 'delivery',
    Other: 'other',
} as const;
export type AddressType = (typeof AddressType)[keyof typeof AddressType];

export const AmountTaxMode = {
    Incl: 'incl',
    Excl: 'excl',
} as const;
export type AmountTaxMode = (typeof AmountTaxMode)[keyof typeof AmountTaxMode];

export const AttributeCreateVariant = {
    Always: 'always',
    Dynamic: 'dynamic',
    NoVariant: 'no_variant',
} as const;
export type AttributeCreateVariant = (typeof AttributeCreateVariant)[keyof typeof AttributeCreateVariant];

export const AttributeDisplayType = {
    Radio: 'radio',
    Pills: 'pills',
    Select: 'select',
    Color: 'color',
    Multi: 'multi',
} as const;
export type AttributeDisplayType = (typeof AttributeDisplayType)[keyof typeof AttributeDisplayType];

export const AuditSeverity = {
    Info: 'info',
    Notice: 'notice',
    Warning: 'warning',
    Critical: 'critical',
} as const;
export type AuditSeverity = (typeof AuditSeverity)[keyof typeof AuditSeverity];

export const BarcodeEncoding = {
    Any: 'any',
    Ean13: 'ean13',
    Ean8: 'ean8',
    Upca: 'upca',
    Gs1128: 'gs1_128',
} as const;
export type BarcodeEncoding = (typeof BarcodeEncoding)[keyof typeof BarcodeEncoding];

export const BarcodeRuleType = {
    Product: 'product',
    Weight: 'weight',
    Price: 'price',
    Discount: 'discount',
    Customer: 'customer',
    Cashier: 'cashier',
    Coupon: 'coupon',
    Lot: 'lot',
    Package: 'package',
    Alias: 'alias',
} as const;
export type BarcodeRuleType = (typeof BarcodeRuleType)[keyof typeof BarcodeRuleType];

export const CashCountType = {
    Opening: 'opening',
    Closing: 'closing',
    MidShift: 'mid_shift',
} as const;
export type CashCountType = (typeof CashCountType)[keyof typeof CashCountType];

export const CashMovementType = {
    CashIn: 'cash_in',
    CashOut: 'cash_out',
    OpeningFloat: 'opening_float',
    ClosingLift: 'closing_lift',
    Difference: 'difference',
} as const;
export type CashMovementType = (typeof CashMovementType)[keyof typeof CashMovementType];

export const CashRoundingMethod = {
    HalfUp: 'half_up',
    Up: 'up',
    Down: 'down',
} as const;
export type CashRoundingMethod = (typeof CashRoundingMethod)[keyof typeof CashRoundingMethod];

export const DayPeriod = {
    Morning: 'morning',
    Afternoon: 'afternoon',
    Evening: 'evening',
} as const;
export type DayPeriod = (typeof DayPeriod)[keyof typeof DayPeriod];

export const DefaultScreen = {
    Tables: 'tables',
    Register: 'register',
} as const;
export type DefaultScreen = (typeof DefaultScreen)[keyof typeof DefaultScreen];

export const DenominationType = {
    Bill: 'bill',
    Coin: 'coin',
} as const;
export type DenominationType = (typeof DenominationType)[keyof typeof DenominationType];

export const DeviceType = {
    Register: 'register',
    Kiosk: 'kiosk',
    CustomerDisplay: 'customer_display',
    SelfMobile: 'self_mobile',
    PrepDisplay: 'prep_display',
} as const;
export type DeviceType = (typeof DeviceType)[keyof typeof DeviceType];

export const DiscountApplicability = {
    Order: 'order',
    Cheapest: 'cheapest',
    Specific: 'specific',
} as const;
export type DiscountApplicability = (typeof DiscountApplicability)[keyof typeof DiscountApplicability];

export const DiscountMode = {
    Percent: 'percent',
    PerPoint: 'per_point',
    PerOrder: 'per_order',
} as const;
export type DiscountMode = (typeof DiscountMode)[keyof typeof DiscountMode];

export const EmployeeRole = {
    Minimal: 'minimal',
    Cashier: 'cashier',
    Manager: 'manager',
} as const;
export type EmployeeRole = (typeof EmployeeRole)[keyof typeof EmployeeRole];

export const InvoiceLineType = {
    Product: 'product',
    Section: 'section',
    Note: 'note',
    Rounding: 'rounding',
    Discount: 'discount',
} as const;
export type InvoiceLineType = (typeof InvoiceLineType)[keyof typeof InvoiceLineType];

export const InvoiceState = {
    Draft: 'draft',
    Issued: 'issued',
    Sent: 'sent',
    Cancelled: 'cancelled',
} as const;
export type InvoiceState = (typeof InvoiceState)[keyof typeof InvoiceState];

export const InvoiceType = {
    Invoice: 'invoice',
    CreditNote: 'credit_note',
} as const;
export type InvoiceType = (typeof InvoiceType)[keyof typeof InvoiceType];

export const LoyaltyAppliesOn = {
    Current: 'current',
    Future: 'future',
    Both: 'both',
} as const;
export type LoyaltyAppliesOn = (typeof LoyaltyAppliesOn)[keyof typeof LoyaltyAppliesOn];

export const LoyaltyCommunicationTrigger = {
    Create: 'create',
    PointsReach: 'points_reach',
    ExpirySoon: 'expiry_soon',
} as const;
export type LoyaltyCommunicationTrigger = (typeof LoyaltyCommunicationTrigger)[keyof typeof LoyaltyCommunicationTrigger];

export const LoyaltyMovementType = {
    Earn: 'earn',
    Spend: 'spend',
    Adjust: 'adjust',
    Expire: 'expire',
    Topup: 'topup',
    Issue: 'issue',
} as const;
export type LoyaltyMovementType = (typeof LoyaltyMovementType)[keyof typeof LoyaltyMovementType];

export const LoyaltyPointState = {
    Pending: 'pending',
    Confirmed: 'confirmed',
    Rejected: 'rejected',
    Reverted: 'reverted',
} as const;
export type LoyaltyPointState = (typeof LoyaltyPointState)[keyof typeof LoyaltyPointState];

export const LoyaltyProgramType = {
    Coupons: 'coupons',
    GiftCard: 'gift_card',
    Loyalty: 'loyalty',
    Promotion: 'promotion',
    PromoCode: 'promo_code',
    BuyXGetY: 'buy_x_get_y',
    Ewallet: 'ewallet',
    NextOrderCoupons: 'next_order_coupons',
} as const;
export type LoyaltyProgramType = (typeof LoyaltyProgramType)[keyof typeof LoyaltyProgramType];

export const LoyaltyRewardType = {
    Discount: 'discount',
    Product: 'product',
    Shipping: 'shipping',
} as const;
export type LoyaltyRewardType = (typeof LoyaltyRewardType)[keyof typeof LoyaltyRewardType];

export const LoyaltyTrigger = {
    Auto: 'auto',
    WithCode: 'with_code',
} as const;
export type LoyaltyTrigger = (typeof LoyaltyTrigger)[keyof typeof LoyaltyTrigger];

export const MediaCollection = {
    Image: 'image',
    SelfHome: 'self_home',
    SelfBackground: 'self_background',
    Brand: 'brand',
    FloorBackground: 'floor_background',
    ReceiptLogo: 'receipt_logo',
    Avatar: 'avatar',
} as const;
export type MediaCollection = (typeof MediaCollection)[keyof typeof MediaCollection];

export const MergeType = {
    TableLink: 'table_link',
    OrderTransfer: 'order_transfer',
    OrderMerge: 'order_merge',
    Split: 'split',
} as const;
export type MergeType = (typeof MergeType)[keyof typeof MergeType];

export const NoteScope = {
    Line: 'line',
    Order: 'order',
    Both: 'both',
} as const;
export type NoteScope = (typeof NoteScope)[keyof typeof NoteScope];

export const NotificationChannel = {
    Email: 'email',
    Sms: 'sms',
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const NotificationLogState = {
    Queued: 'queued',
    Sent: 'sent',
    Failed: 'failed',
    Bounced: 'bounced',
} as const;
export type NotificationLogState = (typeof NotificationLogState)[keyof typeof NotificationLogState];

export const NotificationPurpose = {
    Receipt: 'receipt',
    SelfOrderConfirmation: 'self_order_confirmation',
    PresetConfirmation: 'preset_confirmation',
    GiftCard: 'gift_card',
    Loyalty: 'loyalty',
    Invoice: 'invoice',
} as const;
export type NotificationPurpose = (typeof NotificationPurpose)[keyof typeof NotificationPurpose];

export const OrderEditAction = {
    LineAdded: 'line_added',
    LineRemoved: 'line_removed',
    QtyDecreased: 'qty_decreased',
    QtyIncreased: 'qty_increased',
    PriceChanged: 'price_changed',
    DiscountChanged: 'discount_changed',
    NoteChanged: 'note_changed',
    PaymentChanged: 'payment_changed',
    OrderCancelled: 'order_cancelled',
} as const;
export type OrderEditAction = (typeof OrderEditAction)[keyof typeof OrderEditAction];

export const OrderPrepState = {
    None: 'none',
    Pending: 'pending',
    Sent: 'sent',
    PartiallyReady: 'partially_ready',
    Ready: 'ready',
    Served: 'served',
} as const;
export type OrderPrepState = (typeof OrderPrepState)[keyof typeof OrderPrepState];

export const OrderSource = {
    Pos: 'pos',
    Mobile: 'mobile',
    Kiosk: 'kiosk',
    Backoffice: 'backoffice',
    Api: 'api',
} as const;
export type OrderSource = (typeof OrderSource)[keyof typeof OrderSource];

export const OrderState = {
    Draft: 'draft',
    Paid: 'paid',
    Done: 'done',
    Cancelled: 'cancelled',
} as const;
export type OrderState = (typeof OrderState)[keyof typeof OrderState];

export const PaymentMethodType = {
    Cash: 'cash',
    Bank: 'bank',
    CardTerminal: 'card_terminal',
    QrCode: 'qr_code',
    Online: 'online',
    CustomerAccount: 'customer_account',
    Voucher: 'voucher',
} as const;
export type PaymentMethodType = (typeof PaymentMethodType)[keyof typeof PaymentMethodType];

/**
 * Money that has already left the customer's card rather than sitting in a drawer.
 *
 * The mirror of `PaymentMethodType::isElectronic()` in PHP, and it must stay one: the ticket screen
 * uses it to refuse deleting an order whose payment has already been captured, and a client that
 * disagreed with the server about which methods those are would offer a delete the server would be
 * right to have prevented (REG-295).
 */
export function isElectronicMethod(type: PaymentMethodType): boolean {
    return (
        type === PaymentMethodType.CardTerminal ||
        type === PaymentMethodType.QrCode ||
        type === PaymentMethodType.Online
    );
}

export const PaymentProviderCode = {
    Stripe: 'stripe',
    Adyen: 'adyen',
    Paypal: 'paypal',
    Mollie: 'mollie',
    Razorpay: 'razorpay',
    Flutterwave: 'flutterwave',
    Aps: 'aps',
    Custom: 'custom',
} as const;
export type PaymentProviderCode = (typeof PaymentProviderCode)[keyof typeof PaymentProviderCode];

export const PaymentProviderState = {
    Disabled: 'disabled',
    Test: 'test',
    Enabled: 'enabled',
} as const;
export type PaymentProviderState = (typeof PaymentProviderState)[keyof typeof PaymentProviderState];

export const PaymentStatus = {
    Pending: 'pending',
    Authorized: 'authorized',
    Done: 'done',
    Reversed: 'reversed',
    Failed: 'failed',
    Cancelled: 'cancelled',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const PaymentTransactionState = {
    Draft: 'draft',
    Pending: 'pending',
    Authorized: 'authorized',
    Done: 'done',
    Cancelled: 'cancelled',
    Error: 'error',
} as const;
export type PaymentTransactionState = (typeof PaymentTransactionState)[keyof typeof PaymentTransactionState];

export const PrepChangeType = {
    New: 'new',
    Cancelled: 'cancelled',
    NoteUpdate: 'note_update',
    FireCourse: 'fire_course',
} as const;
export type PrepChangeType = (typeof PrepChangeType)[keyof typeof PrepChangeType];

export const PrepDisplayLayout = {
    Columns: 'columns',
    Grid: 'grid',
    List: 'list',
} as const;
export type PrepDisplayLayout = (typeof PrepDisplayLayout)[keyof typeof PrepDisplayLayout];

export const PrepLineState = {
    Todo: 'todo',
    InProgress: 'in_progress',
    Ready: 'ready',
    Served: 'served',
    Cancelled: 'cancelled',
} as const;
export type PrepLineState = (typeof PrepLineState)[keyof typeof PrepLineState];

export const PrepOrderState = {
    Pending: 'pending',
    InProgress: 'in_progress',
    Ready: 'ready',
    Served: 'served',
    Cancelled: 'cancelled',
} as const;
export type PrepOrderState = (typeof PrepOrderState)[keyof typeof PrepOrderState];

export const PrepStageType = {
    Todo: 'todo',
    InProgress: 'in_progress',
    Ready: 'ready',
    Done: 'done',
} as const;
export type PrepStageType = (typeof PrepStageType)[keyof typeof PrepStageType];

export const PresetIdentification = {
    None: 'none',
    Name: 'name',
    Address: 'address',
} as const;
export type PresetIdentification = (typeof PresetIdentification)[keyof typeof PresetIdentification];

export const PresetServiceAt = {
    Counter: 'counter',
    Table: 'table',
    Delivery: 'delivery',
} as const;
export type PresetServiceAt = (typeof PresetServiceAt)[keyof typeof PresetServiceAt];

export const PriceType = {
    Original: 'original',
    Manual: 'manual',
    Automatic: 'automatic',
} as const;
export type PriceType = (typeof PriceType)[keyof typeof PriceType];

export const PricelistAppliedOn = {
    Variant: 'variant',
    Product: 'product',
    PosCategory: 'pos_category',
    Global: 'global',
} as const;
export type PricelistAppliedOn = (typeof PricelistAppliedOn)[keyof typeof PricelistAppliedOn];

export const PricelistBase = {
    ListPrice: 'list_price',
    StandardPrice: 'standard_price',
    Pricelist: 'pricelist',
} as const;
export type PricelistBase = (typeof PricelistBase)[keyof typeof PricelistBase];

export const PricelistComputePrice = {
    Fixed: 'fixed',
    Percentage: 'percentage',
    Formula: 'formula',
} as const;
export type PricelistComputePrice = (typeof PricelistComputePrice)[keyof typeof PricelistComputePrice];

export const PrintJobState = {
    Queued: 'queued',
    Printing: 'printing',
    Printed: 'printed',
    Failed: 'failed',
    Skipped: 'skipped',
} as const;
export type PrintJobState = (typeof PrintJobState)[keyof typeof PrintJobState];

export const PrintJobType = {
    PrepNew: 'prep_new',
    PrepCancelled: 'prep_cancelled',
    PrepNoteUpdate: 'prep_note_update',
    PrepFireCourse: 'prep_fire_course',
    Bill: 'bill',
    Receipt: 'receipt',
    TipSlip: 'tip_slip',
    CashReport: 'cash_report',
    Test: 'test',
} as const;
export type PrintJobType = (typeof PrintJobType)[keyof typeof PrintJobType];

export const PrinterType = {
    Iot: 'iot',
    EpsonEpos: 'epson_epos',
    NetworkEscpos: 'network_escpos',
    Browser: 'browser',
} as const;
export type PrinterType = (typeof PrinterType)[keyof typeof PrinterType];

export const ProductType = {
    Consumable: 'consumable',
    Service: 'service',
    Combo: 'combo',
} as const;
export type ProductType = (typeof ProductType)[keyof typeof ProductType];

export const QrCodeMethod = {
    None: 'none',
    Emv: 'emv',
    Sepa: 'sepa',
    Swiss: 'swiss',
    Pix: 'pix',
    Upi: 'upi',
    Promptpay: 'promptpay',
} as const;
export type QrCodeMethod = (typeof QrCodeMethod)[keyof typeof QrCodeMethod];

export const ReceiptTicketUrlDisplayMode = {
    QrCode: 'qr_code',
    Url: 'url',
    QrCodeAndUrl: 'qr_code_and_url',
} as const;
export type ReceiptTicketUrlDisplayMode = (typeof ReceiptTicketUrlDisplayMode)[keyof typeof ReceiptTicketUrlDisplayMode];

export const RewardPointMode = {
    Order: 'order',
    Money: 'money',
    Unit: 'unit',
} as const;
export type RewardPointMode = (typeof RewardPointMode)[keyof typeof RewardPointMode];

export const SelfOrderLinkStyle = {
    Primary: 'primary',
    Secondary: 'secondary',
    Success: 'success',
    Danger: 'danger',
    Warning: 'warning',
    Info: 'info',
    Light: 'light',
    Dark: 'dark',
} as const;
export type SelfOrderLinkStyle = (typeof SelfOrderLinkStyle)[keyof typeof SelfOrderLinkStyle];

export const SelfOrderMode = {
    Nothing: 'nothing',
    Consultation: 'consultation',
    Mobile: 'mobile',
    Kiosk: 'kiosk',
} as const;
export type SelfOrderMode = (typeof SelfOrderMode)[keyof typeof SelfOrderMode];

export const SelfOrderPayAfter = {
    Each: 'each',
    Meal: 'meal',
} as const;
export type SelfOrderPayAfter = (typeof SelfOrderPayAfter)[keyof typeof SelfOrderPayAfter];

export const SelfOrderServiceMode = {
    Counter: 'counter',
    Table: 'table',
} as const;
export type SelfOrderServiceMode = (typeof SelfOrderServiceMode)[keyof typeof SelfOrderServiceMode];

export const SequencePurpose = {
    Order: 'order',
    Receipt: 'receipt',
    OrderLine: 'order_line',
    Device: 'device',
    Session: 'session',
    Invoice: 'invoice',
    Refund: 'refund',
} as const;
export type SequencePurpose = (typeof SequencePurpose)[keyof typeof SequencePurpose];

export const SessionState = {
    OpeningControl: 'opening_control',
    Opened: 'opened',
    ClosingControl: 'closing_control',
    Closed: 'closed',
} as const;
export type SessionState = (typeof SessionState)[keyof typeof SessionState];

export const SettingValueType = {
    String: 'string',
    Int: 'int',
    Float: 'float',
    Bool: 'bool',
    Json: 'json',
} as const;
export type SettingValueType = (typeof SettingValueType)[keyof typeof SettingValueType];

export const SpecialKind = {
    None: 'none',
    Tip: 'tip',
    GlobalDiscount: 'global_discount',
    LoyaltyReward: 'loyalty_reward',
    Deposit: 'deposit',
} as const;
export type SpecialKind = (typeof SpecialKind)[keyof typeof SpecialKind];

export const SymbolPosition = {
    Before: 'before',
    After: 'after',
} as const;
export type SymbolPosition = (typeof SymbolPosition)[keyof typeof SymbolPosition];

export const SyncConflictType = {
    StaleWrite: 'stale_write',
    DuplicateTableOrder: 'duplicate_table_order',
    ClosedSession: 'closed_session',
    UuidCollision: 'uuid_collision',
    PrepSnapshotStale: 'prep_snapshot_stale',
    PayloadMismatch: 'payload_mismatch',
    PriceTamper: 'price_tamper',
} as const;
export type SyncConflictType = (typeof SyncConflictType)[keyof typeof SyncConflictType];

export const SyncResolution = {
    ServerWins: 'server_wins',
    ClientWins: 'client_wins',
    Merged: 'merged',
    Rerouted: 'rerouted',
    Rejected: 'rejected',
} as const;
export type SyncResolution = (typeof SyncResolution)[keyof typeof SyncResolution];

export const TableShape = {
    Square: 'square',
    Round: 'round',
} as const;
export type TableShape = (typeof TableShape)[keyof typeof TableShape];

export const TaxAmountType = {
    Percent: 'percent',
    Fixed: 'fixed',
    Division: 'division',
    Group: 'group',
} as const;
export type TaxAmountType = (typeof TaxAmountType)[keyof typeof TaxAmountType];

export const TaxDisplay = {
    Subtotal: 'subtotal',
    Total: 'total',
} as const;
export type TaxDisplay = (typeof TaxDisplay)[keyof typeof TaxDisplay];

export const TaxRoundingMethod = {
    RoundPerLine: 'round_per_line',
    RoundGlobally: 'round_globally',
} as const;
export type TaxRoundingMethod = (typeof TaxRoundingMethod)[keyof typeof TaxRoundingMethod];

export const TaxRoundingStrategy = {
    Inherit: 'inherit',
    RoundPerLine: 'round_per_line',
    RoundGlobally: 'round_globally',
} as const;
export type TaxRoundingStrategy = (typeof TaxRoundingStrategy)[keyof typeof TaxRoundingStrategy];

export const TaxScope = {
    Line: 'line',
    Order: 'order',
} as const;
export type TaxScope = (typeof TaxScope)[keyof typeof TaxScope];

export const TerminalProvider = {
    None: 'none',
    Adyen: 'adyen',
    Stripe: 'stripe',
    Viva: 'viva',
    Razorpay: 'razorpay',
    MercadoPago: 'mercado_pago',
    PineLabs: 'pine_labs',
    Qfpay: 'qfpay',
    Six: 'six',
    Other: 'other',
} as const;
export type TerminalProvider = (typeof TerminalProvider)[keyof typeof TerminalProvider];

export const UomType = {
    Reference: 'reference',
    Bigger: 'bigger',
    Smaller: 'smaller',
} as const;
export type UomType = (typeof UomType)[keyof typeof UomType];

export const UpcEanConversion = {
    None: 'none',
    Ean2Upc: 'ean2upc',
    Upc2Ean: 'upc2ean',
    Always: 'always',
} as const;
export type UpcEanConversion = (typeof UpcEanConversion)[keyof typeof UpcEanConversion];

/** Every enum name mirrored here, for the parity test on the PHP side. */
export const MIRRORED_ENUMS = [
    'AccessLevel',
    'AccountingExportFormat',
    'AccountingExportState',
    'AddressType',
    'AmountTaxMode',
    'AttributeCreateVariant',
    'AttributeDisplayType',
    'AuditSeverity',
    'BarcodeEncoding',
    'BarcodeRuleType',
    'CashCountType',
    'CashMovementType',
    'CashRoundingMethod',
    'DayPeriod',
    'DefaultScreen',
    'DenominationType',
    'DeviceType',
    'DiscountApplicability',
    'DiscountMode',
    'EmployeeRole',
    'InvoiceLineType',
    'InvoiceState',
    'InvoiceType',
    'LoyaltyAppliesOn',
    'LoyaltyCommunicationTrigger',
    'LoyaltyMovementType',
    'LoyaltyPointState',
    'LoyaltyProgramType',
    'LoyaltyRewardType',
    'LoyaltyTrigger',
    'MediaCollection',
    'MergeType',
    'NoteScope',
    'NotificationChannel',
    'NotificationLogState',
    'NotificationPurpose',
    'OrderEditAction',
    'OrderPrepState',
    'OrderSource',
    'OrderState',
    'PaymentMethodType',
    'PaymentProviderCode',
    'PaymentProviderState',
    'PaymentStatus',
    'PaymentTransactionState',
    'PrepChangeType',
    'PrepDisplayLayout',
    'PrepLineState',
    'PrepOrderState',
    'PrepStageType',
    'PresetIdentification',
    'PresetServiceAt',
    'PriceType',
    'PricelistAppliedOn',
    'PricelistBase',
    'PricelistComputePrice',
    'PrintJobState',
    'PrintJobType',
    'PrinterType',
    'ProductType',
    'QrCodeMethod',
    'ReceiptTicketUrlDisplayMode',
    'RewardPointMode',
    'SelfOrderLinkStyle',
    'SelfOrderMode',
    'SelfOrderPayAfter',
    'SelfOrderServiceMode',
    'SequencePurpose',
    'SessionState',
    'SettingValueType',
    'SpecialKind',
    'SymbolPosition',
    'SyncConflictType',
    'SyncResolution',
    'TableShape',
    'TaxAmountType',
    'TaxDisplay',
    'TaxRoundingMethod',
    'TaxRoundingStrategy',
    'TaxScope',
    'TerminalProvider',
    'UomType',
    'UpcEanConversion',
] as const;
