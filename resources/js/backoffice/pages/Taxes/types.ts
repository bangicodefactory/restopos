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
    sequence: number;
};

export type TaxesIndexProps = {
    taxes: TaxRow[];
    groups: TaxGroupRow[];
};

/**
 * Keys `PATCH /taxes/{tax}` validates (BAN-396).
 *
 * All of them, now. `amount_type`, `tax_group_id`, `rounding_strategy` and `has_negative_factor`
 * used to be excluded and rendered `disabled` — which is not a data-integrity guard, only an
 * unreachable field: the four the engine actually branches on could be changed by nobody, through
 * any door, at any time.
 *
 * The real guard is on the server and is narrower and better aimed: the fields that change what a
 * tax *computes* are frozen while an unpaid order already carries it, because the engine reads
 * `taxes` live on every sync and a line is never recomputed once rung up. Change a rate mid-service
 * and one tab carries two rates for the same tax.
 */
export const WRITABLE_TAX_KEYS = [
    'name',
    'description',
    'tax_group_id',
    'amount_type',
    'amount',
    'price_include',
    'include_base_amount',
    'is_base_affected',
    'has_negative_factor',
    'sequence',
    'rounding_strategy',
    'active',
] as const;
