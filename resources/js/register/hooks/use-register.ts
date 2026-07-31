import { formatMoney } from '@domain/receipt/index';
import type { CourseRow, OrderLineRow, OrderRow, PaymentRow } from '@domain/types';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { getCatalog, subscribeCatalog, type CatalogIndex } from '../data/catalog';
import { orderTotals, type OrderTotalsView } from '../domain/totals';
import {
    coursesOf,
    paymentsOf,
    useOrderStore,
    type OrderSlice,
} from '../state/order-store';

/**
 * The React bindings.
 *
 * Two rules govern everything here:
 *
 *  - **Never return a fresh array from a Zustand selector.** Immer's structural sharing means the
 *    relation index arrays are referentially stable until they actually change, so selectors return
 *    those and `useMemo` does the mapping. A selector that built a new array every render would put
 *    the product grid in a render loop.
 *  - **Subscribe to `rev`, not to the object graph.** Totals are memoised on `(rev, catalog
 *    version)` in `@register/domain/totals`; the hooks only need to observe the counter.
 */

const EMPTY_UUIDS: string[] = [];

export function useCatalog(): CatalogIndex {
    return useSyncExternalStore(subscribeCatalog, getCatalog, getCatalog);
}

export function useSelectedOrderUuid(): string | null {
    return useOrderStore((state) => state.selectedOrderUuid);
}

export function useOrder(orderUuid: string | null): OrderRow | null {
    return useOrderStore((state) => (orderUuid === null ? null : (state.orders[orderUuid] ?? null)));
}

export function useSelectedOrder(): OrderRow | null {
    return useOrderStore((state) =>
        state.selectedOrderUuid === null ? null : (state.orders[state.selectedOrderUuid] ?? null),
    );
}

export function useOrderLines(orderUuid: string | null): OrderLineRow[] {
    const uuids = useOrderStore((state) =>
        orderUuid === null ? EMPTY_UUIDS : (state.linesByOrder[orderUuid] ?? EMPTY_UUIDS),
    );
    const lines = useOrderStore((state) => state.lines);
    return useMemo(
        () => uuids.map((uuid) => lines[uuid]).filter((line): line is OrderLineRow => line !== undefined),
        [uuids, lines],
    );
}

export function useOrderPayments(orderUuid: string | null): PaymentRow[] {
    const uuids = useOrderStore((state) =>
        orderUuid === null ? EMPTY_UUIDS : (state.paymentsByOrder[orderUuid] ?? EMPTY_UUIDS),
    );
    const payments = useOrderStore((state) => state.payments);
    return useMemo(
        () => uuids.map((uuid) => payments[uuid]).filter((row): row is PaymentRow => row !== undefined),
        [uuids, payments],
    );
}

export function useOrderCourses(orderUuid: string | null): CourseRow[] {
    const uuids = useOrderStore((state) =>
        orderUuid === null ? EMPTY_UUIDS : (state.coursesByOrder[orderUuid] ?? EMPTY_UUIDS),
    );
    const courses = useOrderStore((state) => state.courses);
    return useMemo(
        () =>
            uuids
                .map((uuid) => courses[uuid])
                .filter((row): row is CourseRow => row !== undefined)
                .sort((a, b) => a.index - b.index),
        [uuids, courses],
    );
}

export function useTotals(orderUuid: string | null): OrderTotalsView {
    const rev = useOrderStore((state) => (orderUuid === null ? -1 : (state.orders[orderUuid]?.rev ?? -1)));
    const payments = useOrderStore((state) => state.payments);
    const version = useCatalog().version;
    // `rev`, `payments` and `version` are cache keys, not inputs: `orderTotals` reads the store
    // and the catalog directly, so these are exactly what must invalidate the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useMemo(() => orderTotals(orderUuid), [orderUuid, rev, payments, version]);
}

export function useSelectedLine(): OrderLineRow | null {
    return useOrderStore((state) =>
        state.selectedLineUuid === null ? null : (state.lines[state.selectedLineUuid] ?? null),
    );
}

/** Money formatter bound to the register's currency. */
export function useMoney(): (amount: string | number) => string {
    const catalog = useCatalog();
    return useCallback(
        (amount: string | number) => formatMoney(typeof amount === 'number' ? String(amount) : amount, catalog.currencyFormat),
        [catalog.currencyFormat],
    );
}

/** Read the whole slice once — for handlers that need a consistent snapshot, never for rendering. */
export function orderSnapshot(): OrderSlice {
    return useOrderStore.getState();
}

export { coursesOf, paymentsOf };
