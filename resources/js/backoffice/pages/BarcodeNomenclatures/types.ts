/**
 * `BarcodeNomenclatures/Index` props (BOF-043, BAN-488).
 *
 * A nomenclature is how a venue reads the barcodes on its own shelves. A supermarket that prints
 * weight into an EAN-13 — `21`, then the product code, then the grams — needs a rule saying which
 * digits are which, or every scan of a weighed item is a miss or the wrong product at the wrong
 * price.
 */

export type BarcodeRuleRow = {
    id: number;
    name: string;
    rule_type: string;
    /**
     * The syntax `packages/domain/src/barcode/pattern.ts` parses: literal digits, `.` for any
     * character, `{NNDDD}` for an embedded field of N integer and D decimal digits.
     */
    pattern: string;
    encoding: string;
    alias: string | null;
    sequence: number;
    active: boolean;
};

export type NomenclatureRow = {
    id: number;
    name: string;
    upc_ean_conv: string;
    is_gs1: boolean;
    /**
     * Shared by every venue on the instance — the standard EAN-13 and UPC-A nomenclatures ship as
     * global rows, which is why `barcode_nomenclatures.company_id` is nullable.
     *
     * Readable and usable by anyone; editable by nobody through this screen, because a change would
     * alter what every venue scans.
     */
    is_shared: boolean;
    rules: BarcodeRuleRow[];
};

export type Option = { value: string; label: string };

export type BarcodeNomenclaturesIndexProps = {
    nomenclatures: NomenclatureRow[];
    rule_types: Option[];
    encodings: Option[];
    conversions: Option[];
};
