import { createPosStore } from '@shared/store';

import { recordOrderScreen } from '../domain/order-actions';
import { useOrderStore } from './order-store';

/**
 * Transient UI state — one store per concern (spec 03 §3.4.2).
 *
 * Nothing here is persisted except the per-order screen (which lives on the order store, because it
 * must survive a reload with the order). Keeping the numpad buffer, the open dialog and the current
 * screen out of the order store is what stops a keystroke from bumping `order.rev` and forcing a
 * tax recomputation.
 */

export type Screen = 'products' | 'payment' | 'receipt' | 'tickets' | 'floor' | 'floorEditor' | 'split';

/** The numpad's meaning (REG-105). `quantity` is the resting mode after every action. */
export type NumpadMode = 'quantity' | 'price' | 'discount';

/** On a phone only one pane fits; on a till both are visible. */
export type Pane = 'order' | 'catalog';

export type DialogKind =
    | 'productInfo'
    | 'variant'
    | 'combo'
    | 'scale'
    | 'openPrice'
    | 'customer'
    | 'notes'
    | 'guests'
    | 'cashMove'
    | 'syncPanel'
    | 'orderName'
    | 'approval'
    | 'closeSession'
    | 'refund'
    | 'transfer'
    /** "Send these to the kitchen first?" — asked on Pay when the delta is non-empty (RST-143). */
    | 'sendBeforePay';

export type DialogState = { kind: DialogKind; payload?: Record<string, unknown> } | null;

export type UiSlice = {
    screen: Screen;
    pane: Pane;
    numpadMode: NumpadMode;
    buffer: string;
    /** `null` = the category root. */
    categoryId: number | null;
    search: string;
    dialog: DialogState;
    /** Set while a "transfer this order" gesture is in flight (RST-054). */
    transferOrderUuid: string | null;
    /** Split-bill working selection, keyed by line uuid. */
    splitSelection: Record<string, number>;
    /** Receipt currently previewed (uuid), so the receipt screen survives a re-render. */
    receiptOrderUuid: string | null;
    lastScanAt: number;
    /**
     * Overrides a manager has granted on this device, keyed by line uuid (REG-045, BAN-518).
     *
     * Only the *local* half. The authoritative record is the `ApprovalRow` written to IndexedDB and
     * synced, which the server re-checks on ingest — this is what lets the screen stop refusing the
     * edit once the manager has said yes. Keyed by line, because that is the scope the approval was
     * granted at; a removed line's uuid never comes back, so nothing has to clear it.
     *
     * Deliberately **not** persisted: this store is plain zustand, so a reload mid-order asks again
     * even though the approval itself is still in IndexedDB and will still be pushed. Re-asking is
     * the conservative direction, and a manager standing at the till is cheaper than a screen that
     * believes it has permission it can no longer show the provenance of.
     */
    lineApprovals: Record<string, string[]>;

    setScreen: (screen: Screen) => void;
    setPane: (pane: Pane) => void;
    setNumpadMode: (mode: NumpadMode) => void;
    setBuffer: (buffer: string) => void;
    appendBuffer: (digit: string) => void;
    clearBuffer: () => void;
    setCategory: (categoryId: number | null) => void;
    setSearch: (search: string) => void;
    openDialog: (kind: DialogKind, payload?: Record<string, unknown>) => void;
    closeDialog: () => void;
    startTransfer: (orderUuid: string | null) => void;
    setSplitQuantity: (lineUuid: string, quantity: number) => void;
    resetSplit: () => void;
    setReceiptOrder: (orderUuid: string | null) => void;
    noteScan: () => void;
    grantLineApproval: (lineUuid: string, ability: string) => void;
};

export const useUiStore = createPosStore<UiSlice>((set) => ({
    screen: 'products',
    pane: 'catalog',
    numpadMode: 'quantity',
    buffer: '',
    categoryId: null,
    search: '',
    dialog: null,
    transferOrderUuid: null,
    splitSelection: {},
    receiptOrderUuid: null,
    lastScanAt: 0,
    lineApprovals: {},

    setScreen: (screen) => {
        set((state) => {
            state.screen = screen;
            state.buffer = '';
        });

        // REG-125 — remember where this order was, so re-selecting it (or reloading mid-payment)
        // comes back here. Only the screens an order can meaningfully be *on*: 'floor' and
        // 'tickets' are register-wide views, not a place an order sits.
        const orderUuid = useOrderStore.getState().selectedOrderUuid;

        if (orderUuid !== null && (screen === 'products' || screen === 'payment' || screen === 'receipt')) {
            recordOrderScreen(orderUuid, screen);
        }
    },

    setPane: (pane) =>
        set((state) => {
            state.pane = pane;
        }),

    setNumpadMode: (mode) =>
        set((state) => {
            state.numpadMode = mode;
            state.buffer = '';
        }),

    setBuffer: (buffer) =>
        set((state) => {
            state.buffer = buffer;
        }),

    appendBuffer: (digit) =>
        set((state) => {
            state.buffer = state.buffer === '0' ? digit : state.buffer + digit;
        }),

    clearBuffer: () =>
        set((state) => {
            state.buffer = '';
        }),

    setCategory: (categoryId) =>
        set((state) => {
            state.categoryId = categoryId;
            state.search = '';
        }),

    setSearch: (search) =>
        set((state) => {
            state.search = search;
        }),

    openDialog: (kind, payload) =>
        set((state) => {
            state.dialog = payload === undefined ? { kind } : { kind, payload };
        }),

    closeDialog: () =>
        set((state) => {
            state.dialog = null;
        }),

    startTransfer: (orderUuid) =>
        set((state) => {
            state.transferOrderUuid = orderUuid;
            if (orderUuid !== null) state.screen = 'floor';
        }),

    setSplitQuantity: (lineUuid, quantity) =>
        set((state) => {
            if (quantity === 0) delete state.splitSelection[lineUuid];
            else state.splitSelection[lineUuid] = quantity;
        }),

    resetSplit: () =>
        set((state) => {
            state.splitSelection = {};
        }),

    setReceiptOrder: (orderUuid) =>
        set((state) => {
            state.receiptOrderUuid = orderUuid;
        }),

    noteScan: () =>
        set((state) => {
            state.lastScanAt = Date.now();
        }),

    grantLineApproval: (lineUuid, ability) =>
        set((state) => {
            const held = state.lineApprovals[lineUuid] ?? [];

            if (!held.includes(ability)) state.lineApprovals[lineUuid] = [...held, ability];
        }),

}));
