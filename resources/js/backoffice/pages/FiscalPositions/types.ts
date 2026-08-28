/**
 * `FiscalPositions/Index` props (BOF-036, BAN-398).
 *
 * A fiscal position rewrites which tax applies. Takeaway VAT is the everyday case: the same dish
 * carries one rate eaten in and another taken away, and the difference is the tax authority's money
 * either way.
 */

export type MappingRow = {
    id: number;
    tax_src_id: number;
    source_name: string;
    /**
     * `null` means the source tax is removed entirely — which is what an export or exempt regime
     * does, and a first-class choice rather than an unfinished row.
     */
    tax_dest_id: number | null;
    destination_name: string | null;
};

export type PositionRow = {
    id: number;
    name: string;
    /** Fires without the cashier choosing it, on the country and postcode rule below. */
    auto_apply: boolean;
    country_id: number | null;
    zip_from: string | null;
    zip_to: string | null;
    vat_required: boolean;
    sequence: number;
    active: boolean;
    mappings: MappingRow[];
};

export type FiscalPositionsIndexProps = {
    positions: PositionRow[];
    taxes: { id: number; name: string; amount: string }[];
    countries: { id: number; code: string; name: string }[];
};
