import type { PrepOrderState, PrepStageType } from '@domain/enums';

/**
 * The kitchen wire contract — a verbatim transcription of `docs/spec/05-api-contract.md` §8, §9
 * and §11.3.
 *
 * These are deliberately *not* the `PrepOrderRow` / `PrepOrderLineRow` shapes in `@domain/types`.
 * Those describe a register-side projection (`order_reference`, `table_name`, `attributes[]`,
 * numeric `quantity`) and they do not match what `/api/kitchen/{display}/orders` actually
 * returns (`table_label`, `guest_count`, `age_seconds`, decimal-string `quantity`,
 * `change_type`, per-line timestamps). Coding against the contract is the rule; the drift is
 * reported rather than papered over.
 */

/** Per-line state (spec §9). `todo` is the arrival state. */
export type KitchenLineState = 'todo' | 'in_progress' | 'ready' | 'served' | 'cancelled';

/** Why this line is on the board — the change-delta engine's verdict (spec §8, KDS-016/017/018). */
export type KitchenChangeType = 'new' | 'cancelled' | 'note_update' | 'fire_course';

export type KitchenDisplay = {
    id: number;
    name: string;
    /** `columns` → a stage per column; `list` → one consolidated column (KDS-013). */
    layout: 'columns' | 'list' | string;
    average_prep_minutes: number;
    late_threshold_minutes: number;
    done_retention_minutes: number;
    sound_on_new_order: boolean;
};

export type KitchenStage = {
    id: number;
    prep_display_id: number;
    name: string;
    stage_type: PrepStageType;
    color: string | null;
    alert_after_minutes: number | null;
    sequence: number;
    is_default?: boolean;
};

export type KitchenLine = {
    id: number;
    uuid: string;
    pos_order_line_uuid: string;
    prep_stage_id: number;
    course_index: number | null;
    product_id: number | null;
    display_name: string;
    /** Decimal string; signed — negative is work to undo (spec §8). */
    quantity: string;
    change_type: KitchenChangeType;
    customer_note: string | null;
    internal_note: string | null;
    state: KitchenLineState;
    started_at: string | null;
    ready_at: string | null;
    served_at: string | null;
    fired_at: string | null;
    /** Only present on the broadcast `Ticket` payload; absent from the board endpoint. */
    pos_category_id?: number | null;
    combo_parent_uuid?: string | null;
};

export type KitchenOrder = {
    id: number;
    uuid: string;
    prep_display_id: number;
    pos_order_id: number | null;
    tracking_number: string | null;
    table_label: string | null;
    guest_count: number | null;
    preset_label: string | null;
    customer_name: string | null;
    order_note: string | null;
    state: PrepOrderState;
    fired_at: string | null;
    first_started_at: string | null;
    ready_at: string | null;
    served_at: string | null;
    is_recalled: boolean;
    /** Server-computed age at the instant of the response; the client re-derives from `fired_at`. */
    age_seconds: number;
    lines: KitchenLine[];
};

/** `GET /api/kitchen/{display}/orders` */
export type KitchenBoardResponse = {
    server_time: string;
    display: KitchenDisplay;
    stages: KitchenStage[];
    orders: KitchenOrder[];
};

/** Response of the three mutation endpoints (spec §9). */
export type KitchenMutationResponse = {
    prep_order_id: number;
    state: PrepOrderState;
    lines: KitchenLine[];
};

/** The `Ticket` payload of `kitchen.ticket.created` (spec §8). */
export type KitchenTicket = {
    prep_order_id: number;
    prep_order_uuid: string;
    prep_display_id: number;
    order_uuid: string;
    tracking_number: string | null;
    table_label: string | null;
    guest_count: number | null;
    fired_at: string | null;
    lines: Array<
        Pick<
            KitchenLine,
            'id' | 'product_id' | 'display_name' | 'quantity' | 'change_type' | 'customer_note' | 'internal_note'
        > & {
            line_uuid: string;
            line_id: number | null;
            pos_category_id: number | null;
            course_id: number | null;
            course_index: number | null;
            combo_parent_uuid: string | null;
        }
    >;
};

/** The `kitchen.ticket.updated` payload (spec §11.3) — thin by design. */
export type KitchenTicketUpdate = {
    v: number;
    prep_order_id: number;
    prep_order_uuid: string;
    state: PrepOrderState;
    lines: Array<{ id: number; uuid: string; pos_order_line_uuid: string; state: KitchenLineState }>;
    recalled: boolean;
};

/**
 * A queued mutation (KDS-020).
 *
 * The board is a *display*: a stage bump that cannot reach the server must still be visible on the
 * line, so every action is applied optimistically and parked here until it is acknowledged.
 */
export type QueuedAction =
    | { id: string; at: number; attempts: number; kind: 'stage'; prepOrderId: number; stageId: number }
    | { id: string; at: number; attempts: number; kind: 'recall'; prepOrderId: number }
    | { id: string; at: number; attempts: number; kind: 'line'; lineId: number; state: KitchenLineState };

/** What a display device needs to remember between boots. */
export type KitchenPairing = {
    configId: number;
    deviceToken: string;
    deviceUuid: string;
    deviceName: string;
};
