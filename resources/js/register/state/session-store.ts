import type { Money, PosSessionRow } from '@domain/types';
import { createPosStore } from '@shared/store';

/**
 * The cash session (REG-001 … REG-024).
 *
 * The closing figures are **server-computed on purpose** (REG-014): expected cash is derived from
 * synced orders, and two devices that each computed it from their own replica would disagree. So
 * this store holds what the server said, and the closing screen refuses to guess when offline.
 */

export type PaymentTotal = {
    payment_method_id: number;
    name: string;
    is_cash_count: boolean;
    expected_amount: Money;
    payment_count: number;
    refund_amount: Money;
    change_amount: Money;
};

export type ClosingData = {
    session_id: number;
    opening_balance: Money;
    cash_in: Money;
    cash_out: Money;
    expected_cash: Money;
    payment_totals: PaymentTotal[];
    order_count: number;
    draft_order_count: number;
    amount_authorized_diff: Money;
    enforces_maximum_difference: boolean;
};

/** Something about this register's configuration that stops a session opening (REG-002). */
export type RegisterProblem = { code: string; message: string };

/**
 * What the server says about opening a session here, answered *before* one exists.
 *
 * Both halves are questions the open pane cannot answer for itself: the expected float lives in the
 * previous session's close, and whether the register can trade at all depends on configuration the
 * till does not replicate. Null when the server has not been reached — offline, the pane falls back
 * to asking for a count and letting the open attempt fail, which is what it always did.
 */
export type OpeningContext = { expected_float: Money; problems: RegisterProblem[] };

export type SessionSlice = {
    session: PosSessionRow | null;
    opening: OpeningContext | null;
    closingData: ClosingData | null;
    busy: boolean;
    error: string | null;

    setSession: (session: PosSessionRow | null) => void;
    setOpening: (opening: OpeningContext | null) => void;
    setClosingData: (data: ClosingData | null) => void;
    setBusy: (busy: boolean) => void;
    setError: (error: string | null) => void;
};

export const usePosSessionStore = createPosStore<SessionSlice>((set) => ({
    session: null,
    opening: null,
    closingData: null,
    busy: false,
    error: null,

    setSession: (session) =>
        set((state) => {
            state.session = session;
        }),

    setOpening: (opening) =>
        set((state) => {
            state.opening = opening;
        }),

    setClosingData: (data) =>
        set((state) => {
            state.closingData = data;
        }),

    setBusy: (busy) =>
        set((state) => {
            state.busy = busy;
        }),

    setError: (error) =>
        set((state) => {
            state.error = error;
        }),
}));

/** REG-005 — a denomination count row. */
export type DenominationCount = { pos_bill_id: number; denomination_value: Money; quantity: number };

export function countTotal(counts: readonly DenominationCount[]): number {
    return counts.reduce((sum, row) => sum + Number.parseFloat(row.denomination_value) * row.quantity, 0);
}
