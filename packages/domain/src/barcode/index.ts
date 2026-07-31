export {
    eanToUpc,
    gtinCheckDigit,
    isValidEan8,
    isValidEan13,
    isValidGtin,
    isValidUpcA,
    stripGtinPadding,
    upcToEan,
    withCheckDigit,
} from './checksum';

export { FNC1, looksLikeGs1, parseGs1 } from './gs1';
export type { AiKind, Gs1Element, Gs1Parse } from './gs1';

export { matchPattern, patternToRegExp } from './pattern';
export type { PatternMatch } from './pattern';

export {
    buildNomenclature,
    conversionCandidates,
    parseBarcode,
    parseBarcodeWithFallback,
} from './nomenclature';
export type { BarcodeKind, Nomenclature, ParsedBarcode } from './nomenclature';
