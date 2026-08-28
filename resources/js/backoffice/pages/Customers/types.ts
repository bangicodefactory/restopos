/**
 * `Customers/Index` and `Customers/Edit` props — spec §2.A (BOF-119).
 *
 * `Customer` uses `HasUuid`, so **every model-bound route here takes the uuid, not the id** — an id
 * 404s (BAN-499). The one exception is `loser_id` in the merge payload, which is a body field
 * resolved through the scoped model rather than a route parameter.
 */

export type CustomerListRow = {
    id: number;
    uuid: string;
    name: string;
    is_company: boolean;
    email: string | null;
    phone: string | null;
    mobile: string | null;
    city: string | null;
    vat: string | null;
    order_count: number;
    /** Positive means owed to the venue. A cache of the account moves — read-only here. */
    account_balance: string;
    last_order_at: string | null;
    active: boolean;
};

/** Records sharing a contact detail. Named by what they share, not by what differs. */
export type DuplicateGroup = {
    value: string;
    field: 'email' | 'phone' | 'mobile';
    ids: number[];
    names: string[];
};

export type NamedRow = { id: number; name: string };

export type CustomersIndexProps = {
    customers: CustomerListRow[];
    search: string;
    /** Every customer of the venue, so a list cut at `shown_limit` never reads as complete. */
    total: number;
    shown_limit: number;
    duplicates: DuplicateGroup[];
};

export type CustomerRecord = {
    id: number;
    uuid: string;
    company_id: number;
    parent_id: number | null;
    address_type: string;
    is_company: boolean;
    name: string;
    email: string | null;
    phone: string | null;
    mobile: string | null;
    vat: string | null;
    street: string | null;
    street2: string | null;
    city: string | null;
    zip: string | null;
    state_id: number | null;
    country_id: number | null;
    barcode: string | null;
    locale: string | null;
    pricelist_id: number | null;
    fiscal_position_id: number | null;
    loyalty_points_cache: string;
    account_balance: string;
    order_count: number;
    last_order_at: string | null;
    marketing_opt_in: boolean;
    note: string | null;
    active: boolean;
};

export type CustomerOrderRow = {
    id: number;
    tracking_number: string;
    state: string;
    amount_total: string;
    ordered_at: string | null;
};

export type CustomerAccountMoveRow = {
    id: number;
    amount: string;
    balance_after: string;
    move_type: string;
    description: string | null;
    occurred_at: string | null;
};

export type MergeCandidate = { id: number; name: string; why: string };

export type CustomerEditProps = {
    customer: CustomerRecord;
    orders: CustomerOrderRow[];
    accountMoves: CustomerAccountMoveRow[];
    pricelists: NamedRow[];
    fiscalPositions: NamedRow[];
    countries: NamedRow[];
    mergeCandidates: MergeCandidate[];
};
