/**
 * `Taxes/Index` props — spec 05 §12 (BOF-091, BOF-092).
 */

import type { MoneyString } from '../../types/inertia';

export type TaxRow = {
    id: number;
    name: string;
    description: string | null;
    tax_group_id: number;
    /** `percent | fixed | division | group` */
    amount_type: string;
    amount: MoneyString;
    price_include: boolean;
    include_base_amount: boolean;
    is_base_affected: boolean;
    has_negative_factor: boolean;
    sequence: number;
    /** `inherit | round_per_line | round_globally` */
    rounding_strategy: string;
    active: boolean;
};

export type TaxGroupRow = {
    id: number;
    name: string;
    receipt_label: string | null;
};

export type TaxesIndexProps = {
    taxes: TaxRow[];
    groups: TaxGroupRow[];
};

/** Keys `PATCH /taxes/{tax}` validates. `amount_type`, `tax_group_id` and the rounding strategy
 *  are **not** among them — changing a tax's type under posted orders is a data-integrity
 *  question, not a form field (BOF-091). */
export const WRITABLE_TAX_KEYS = [
    'name',
    'description',
    'amount',
    'price_include',
    'include_base_amount',
    'is_base_affected',
    'sequence',
    'active',
] as const;
