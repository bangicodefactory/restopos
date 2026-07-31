/**
 * `@domain` — framework-free domain logic shared by every RestoPOS front-end.
 *
 * Zero runtime dependencies (see docs/CONVENTIONS.md). The money / tax / pricing surface below
 * is the TypeScript half of the parity pair described in docs/spec/04-tax-engine.md; the PHP
 * half lives in `app/Support/{Money,Tax,Pricing}`.
 *
 * NOTE TO OTHER AGENTS: append your exports, do not replace this file.
 */

// ---------------------------------------------------------------- money (spec §2, §3)
export { Decimal, MAX_SCALE, PRICE_SCALE, ZERO, ONE, HUNDRED, MINUS_ONE } from './money/decimal';
export {
    applyRounding,
    parseRoundingMode,
    HALF_UP,
    HALF_DOWN,
    HALF_EVEN,
    UP,
    DOWN,
    type RoundingMode,
} from './money/rounding';

// ---------------------------------------------------------------- tax (spec §5 - §9)
export { TaxEngine, taxEngine, computeOrderTaxes, flattenTaxes, MAX_GROUP_DEPTH } from './tax/engine';
export { mapTaxes } from './tax/fiscal-position';
export { CurrencyRounder, CashRoundingCalculator, type CashRoundingResult } from './tax/rounder';
export type {
    CashRounding,
    CashRoundingStrategy,
    Currency,
    FiscalPosition,
    FiscalPositionMapping,
    LineInput,
    LineResult,
    LineTaxResult,
    OrderInput,
    OrderResult,
    OrderTotals,
    TaxAmountType,
    TaxDefinition,
    TaxGroupResult,
    TaxRoundingMethod,
} from './tax/types';

// ---------------------------------------------------------------- pricing (spec §10, §11)
export { PricelistResolver, MAX_PRICELIST_DEPTH } from './pricing/pricelist';
export type {
    Pricelist,
    PricelistAppliedOn,
    PricelistBase,
    PricelistComputePrice,
    PricelistContext,
    PricelistItem,
} from './pricing/pricelist';
export {
    ComboPriceDistributor,
    comboPriceDistributor,
    distributeComboPrice,
} from './pricing/combo';
export type {
    ComboComponentInput,
    ComboComponentPrice,
    ComboDistributionInput,
} from './pricing/combo';

// ---------------------------------------------------------------- enums (mirror of app/Enums/*)
// `export *` rather than a 160-line explicit list. Five names collide with the tax/pricing types
// exported above (TaxAmountType, TaxRoundingMethod, PricelistAppliedOn, PricelistComputePrice,
// PricelistBase); the explicit exports above win, and the enum *values* for those five remain
// available from '@domain/enums'.
export * from './enums';

// ---------------------------------------------------------------- client row types (spec 01 §5)
export * from './types';

// ---------------------------------------------------------------- ESC/POS IR (spec 03 §7.1, §7.2)
export {
    ByteBuilder,
    EscPosBuilder,
    ESC,
    GS,
    LF,
    NUL,
    PRINTER_PROFILES,
    SIZE_MULTIPLIERS,
    canEncode,
    columnsFor,
    displayWidth,
    drawerKickDoc,
    emitRaster,
    encodeText,
    findUnprintableNodes,
    highTableLength,
    layoutCols,
    layoutRow,
    mergeStyle,
    padTo,
    resolveProfile,
    toEscPos,
    toPlainText,
    truncate,
    walkNodes,
    wrap,
} from './escpos/index';
export type {
    Align,
    BarcodeSymbology,
    Codepage,
    DocKind,
    EscPosDoc,
    EscPosNode,
    PrinterProfile,
    PrinterProfileId,
    QrErrorCorrection,
    RasterImage,
    ReceiptWidth,
    TextSize,
    TextStyle,
} from './escpos/index';

// ---------------------------------------------------------------- receipts (spec 03 §7.1)
export {
    DEFAULT_LABELS,
    buildBillDoc,
    buildPrepTicketDoc,
    buildReceiptDoc,
    descriptorToText,
    formatDateTime,
    formatMoney,
    formatPercent,
    formatQuantity,
    toDescriptor,
} from './receipt/index';
export type {
    CurrencyFormat,
    PrepTicketView,
    ReceiptConfigView,
    ReceiptDescriptor,
    ReceiptElement,
    ReceiptLabels,
    ReceiptLineView,
    ReceiptOrderView,
    ReceiptPaymentView,
    ReceiptTaxLineView,
} from './receipt/index';

// ---------------------------------------------------------------- barcode nomenclature (spec 03 §7.5)
export {
    FNC1,
    buildNomenclature,
    conversionCandidates,
    eanToUpc,
    gtinCheckDigit,
    isValidEan8,
    isValidEan13,
    isValidGtin,
    isValidUpcA,
    looksLikeGs1,
    matchPattern,
    parseBarcode,
    parseBarcodeWithFallback,
    parseGs1,
    patternToRegExp,
    stripGtinPadding,
    upcToEan,
    withCheckDigit,
} from './barcode/index';
export type {
    AiKind,
    BarcodeKind,
    Gs1Element,
    Gs1Parse,
    Nomenclature,
    ParsedBarcode,
    PatternMatch,
} from './barcode/index';

// ---------------------------------------------------------------- sequences & references (spec 03 §6)
export {
    SEQ_ORDER,
    TOKEN_ALPHABET,
    createMemoryCounterStore,
    cryptoRandom,
    devicePrefix,
    formatOrderReference,
    formatTrackingNumber,
    generateReceiptToken,
    generateUuid,
    nextOrderReference,
} from './sequence/index';
export type { CounterStore, RandomSource, TrackingPrefixSource } from './sequence/index';

// ---------------------------------------------------------------- sync protocol & outbox (spec 03 §3.6)
export {
    ConflictCode,
    DEFAULT_BACKOFF,
    Outbox,
    classifyHttpError,
    computeBackoff,
    createMemoryOutboxStorage,
    isRetryable,
} from './sync/index';
export type {
    ApprovalCommand,
    BackoffPolicy,
    BootstrapLimits,
    BootstrapProfile,
    BootstrapResponse,
    DeltaResponse,
    EnqueueInput,
    GenericCommand,
    GenericCommandKind,
    OrderCommand,
    OrderOp,
    OutboxDeps,
    OutboxEntry,
    OutboxKind,
    OutboxState,
    OutboxStats,
    OutboxStorage,
    RecordCommand,
    RecordOp,
    SyncError,
    SyncPushRequest,
    SyncPushResponse,
    SyncRecordResult,
    SyncStatus,
    SyncWarning,
    TombstoneResponse,
} from './sync/index';
