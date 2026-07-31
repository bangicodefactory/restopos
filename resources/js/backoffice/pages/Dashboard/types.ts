/**
 * `Dashboard/Index` props — spec 05 §12, produced by `DashboardController::__invoke()`.
 */

import type { Deferred, MoneyString, NumericLike } from '../../types/inertia';

export type DashboardSession = {
    id: number;
    name: string;
    /** `opening_control | opened | closing_control | closed` */
    state: string;
    opened_at: string | null;
    order_count: number;
    order_amount_total: MoneyString;
};

export type DashboardRegister = {
    id: number;
    name: string;
    is_restaurant: boolean;
    /** `nothing | consultation | mobile | kiosk` */
    self_ordering_mode: string;
    device_count: number;
    session: DashboardSession | null;
};

export type DashboardToday = {
    order_count: number;
    revenue: MoneyString;
    open_sessions: number;
};

/** Raw `pos_sessions` columns, selected in the controller. */
export type RescueSession = {
    id: number;
    name: string;
    pos_config_id: number;
    opened_at: string | null;
    opening_notes: string | null;
    order_count: number;
};

/**
 * Not emitted by the controller today.
 *
 * The brief asks the dashboard for a 14-day sparkline and a top-products panel; spec 05 §12 gives
 * the page neither series. Rather than invent a second data path (a JSON endpoint the contract
 * does not define), the panels are built against these optional props and render an explicit
 * "no data on this page" state with a link to the report that does have the numbers. The day the
 * controller adds `salesTrend` / `topProducts`, the panels light up with no further change.
 */
export type DashboardTrendPoint = {
    day: string;
    revenue: NumericLike;
    order_count: number;
};

export type DashboardTopProduct = {
    product_id: number | null;
    product_name: string | null;
    quantity: NumericLike;
    total_amount: NumericLike;
};

export type DashboardProps = {
    registers: DashboardRegister[];
    today: Deferred<DashboardToday>;
    rescueSessions: Deferred<RescueSession[]>;
    salesTrend?: DashboardTrendPoint[];
    topProducts?: DashboardTopProduct[];
};
