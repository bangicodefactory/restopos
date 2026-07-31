import type { RoundingMode } from '../money/rounding';

/**
 * Wire/DTO shapes for the tax engine — docs/spec/04-tax-engine.md §4 and §12.
 * Every monetary or quantity field is a decimal STRING (§1.2).
 */

export type TaxAmountType = 'percent' | 'fixed' | 'division' | 'group';

export type TaxRoundingMethod = 'round_per_line' | 'round_globally';

export type CashRoundingStrategy = 'add_invoice_line' | 'biggest_tax';

/** §4.1 */
export type Currency = {
    readonly code: string;
    readonly decimalPlaces: number;
    readonly rounding: string;
    readonly roundingMode?: RoundingMode;
};

/** §4.2 */
export type TaxDefinition = {
    readonly id: number;
    readonly name?: string;
    readonly amountType: TaxAmountType;
    readonly amount: string;
    readonly priceInclude?: boolean;
    readonly includeBaseAmount?: boolean;
    readonly isBaseAffected?: boolean;
    readonly hasNegativeFactor?: boolean;
    readonly sequence: number;
    readonly taxGroupId: number;
    readonly childrenTaxIds?: readonly number[];
};

/** §4.3 */
export type LineInput = {
    readonly id: string;
    readonly quantity: string;
    readonly priceUnit: string;
    readonly discount?: string;
    readonly taxIds?: readonly number[];
    readonly sign?: string;
};

/** §4.5 */
export type FiscalPositionMapping = {
    readonly taxSrcId: number;
    readonly taxDestId: number | null;
};

export type FiscalPosition = {
    readonly id?: number;
    readonly name?: string;
    readonly mappings: readonly FiscalPositionMapping[];
};

/** §4.6 */
export type CashRounding = {
    readonly rounding: string;
    readonly method: RoundingMode;
    readonly strategy?: CashRoundingStrategy;
};

/** §4.4 */
export type OrderInput = {
    readonly currency: Currency;
    readonly roundingMethod?: TaxRoundingMethod;
    readonly taxes: readonly TaxDefinition[];
    readonly lines: readonly LineInput[];
    readonly documentSign?: string;
    readonly fiscalPosition?: FiscalPosition | null;
    readonly cashRounding?: CashRounding | null;
};

/** §12 */
export type LineTaxResult = {
    readonly taxId: number;
    readonly base: string;
    readonly amount: string;
};

export type LineResult = {
    readonly id: string;
    readonly priceUnit: string;
    readonly priceSubtotal: string;
    readonly priceTotal: string;
    readonly taxes: readonly LineTaxResult[];
};

export type TaxGroupResult = {
    readonly taxGroupId: number;
    readonly base: string;
    readonly amount: string;
};

export type OrderTotals = {
    readonly totalExcluded: string;
    readonly totalTax: string;
    readonly totalIncluded: string;
    readonly roundedTotal: string;
    readonly roundingDelta: string;
    readonly taxGroups: readonly TaxGroupResult[];
};

export type OrderResult = {
    readonly lines: readonly LineResult[];
    readonly totals: OrderTotals;
};
