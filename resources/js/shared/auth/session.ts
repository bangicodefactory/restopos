import type { CashierContext, EmployeeRow, PosSessionRow } from '@domain/types';

import { META, getMeta, setMeta, type PosDb } from '../db';
import { createPosStore } from '../store/create-store';

/**
 * Who is at the till, and which session their sales belong to (spec 03 §2.3, §2.5).
 *
 * The active employee is held in memory **and** mirrored to IndexedDB, so a crash or a reload
 * restores the cashier without a re-PIN. An idle timeout returns the lock screen.
 *
 * Ability checks here are **UX**. The control is the server-side re-check on ingest: a discount
 * above the configured limit without a matching approval record is rejected there, whatever the
 * client believed.
 */

export type SessionState = {
    cashier: CashierContext | null;
    session: PosSessionRow | null;
    locked: boolean;

    setCashier: (employee: EmployeeRow) => void;
    clearCashier: () => void;
    setSession: (session: PosSessionRow | null) => void;
    lock: () => void;
    unlock: () => void;
};

export const useSessionStore = createPosStore<SessionState>((set) => ({
    cashier: null,
    session: null,
    locked: true,

    setCashier: (employee) =>
        set((state) => {
            state.cashier = {
                employee_id: employee.id,
                name: employee.name,
                role: employee.default_role,
                abilities: employee.abilities,
                since: Date.now(),
            };
            state.locked = false;
        }),

    clearCashier: () =>
        set((state) => {
            state.cashier = null;
            state.locked = true;
        }),

    setSession: (session) =>
        set((state) => {
            state.session = session;
        }),

    lock: () =>
        set((state) => {
            state.locked = true;
        }),

    unlock: () =>
        set((state) => {
            state.locked = state.cashier === null;
        }),
}));

/** Restore the cashier after a reload. Returns `null` when the lock screen should show. */
export async function restoreCashier(db: PosDb): Promise<CashierContext | null> {
    const stored = await getMeta<CashierContext | null>(db, META.activeEmployee, null);
    if (!stored) return null;
    useSessionStore.setState({ cashier: stored, locked: false });
    return stored;
}

export async function persistCashier(db: PosDb, cashier: CashierContext | null): Promise<void> {
    await setMeta(db, META.activeEmployee, cashier);
}

/** Ability check for the current cashier. */
export function can(cashier: CashierContext | null, ability: string): boolean {
    return cashier?.abilities.includes(ability) ?? false;
}

/** React binding — `const allowed = useCan('line.discount')`. */
export function useCan(): (ability: string) => boolean {
    const cashier = useSessionStore((state) => state.cashier);
    return (ability: string): boolean => can(cashier, ability);
}

/** The ability constants, mirroring `App\Enums\Ability` (spec 03 §2.5). */
export const Ability = {
    OrderCreate: 'order.create',
    OrderDeleteDraft: 'order.delete_draft',
    OrderVoidPaid: 'order.void_paid',
    LineDiscount: 'line.discount',
    LineDiscountAbove: 'line.discount.above_limit',
    LinePriceOverride: 'line.price_override',
    RefundCreate: 'refund.create',
    CashDrawerOpenNoSale: 'cash.drawer.no_sale',
    CashInOut: 'cash.in_out',
    CashInOutDelete: 'cash.in_out.delete',
    SessionOpen: 'session.open',
    SessionClose: 'session.close',
    SessionCloseOverVariance: 'session.close.over_variance',
    ViewMargins: 'report.margins',
    ReprintReceipt: 'receipt.reprint',
    TableTransfer: 'table.transfer',
    BillSplit: 'bill.split',
} as const;
export type Ability = (typeof Ability)[keyof typeof Ability];
