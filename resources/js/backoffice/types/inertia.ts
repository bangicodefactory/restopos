/**
 * Shapes that are the same on every back-office page.
 *
 * `SharedProps` mirrors `App\Http\Middleware\HandleInertiaRequests::share()` exactly
 * (spec 05 §12). `Paginator<T>` mirrors what `LengthAwarePaginator::through()` serialises —
 * the list pages for products, orders and sessions all arrive in that envelope.
 */

export type AuthUser = {
    id: number;
    name: string;
    email: string;
};

export type Auth = {
    user: AuthUser;
    abilities: string[];
};

export type Flash = {
    success: string | null;
    error: string | null;
};

export type SharedProps = {
    auth: Auth | null;
    flash: Flash;
};

/** One entry of Laravel's `links` array: `« Previous`, `1`, `2`, `Next »`. */
export type PaginatorLink = {
    url: string | null;
    label: string;
    active: boolean;
};

export type Paginator<T> = {
    data: T[];
    current_page: number;
    first_page_url: string;
    from: number | null;
    last_page: number;
    last_page_url: string;
    links: PaginatorLink[];
    next_page_url: string | null;
    path: string;
    per_page: number;
    prev_page_url: string | null;
    to: number | null;
    total: number;
};

/**
 * A prop declared with `Inertia::defer()`.
 *
 * It is genuinely absent from the first response — not null, *missing* — so every consumer
 * must handle `undefined` and render a skeleton. Typing it as `T | undefined` rather than
 * `T | null` keeps that distinction visible at the call site.
 */
export type Deferred<T> = T | undefined;

/** `{value, label}` option pairs, as the controllers emit them for enum-backed fields. */
export type EnumOption = {
    value: string;
    label: string;
};

/** A decimal string on the wire (docs/CONVENTIONS.md "Money"). Never a JS number. */
export type MoneyString = string;

/**
 * Laravel serialises `decimal` columns as strings but raw aggregate queries
 * (`selectRaw('sum(...)')`) come back as whatever the driver decided — string on pgsql,
 * number on sqlite. Report props are typed with this and parsed through `toDecimal()`.
 */
export type NumericLike = string | number | null;
