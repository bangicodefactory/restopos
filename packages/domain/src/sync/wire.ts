import type {
    CourseRow,
    Iso,
    Money,
    OrderLineRow,
    OrderRow,
    PaymentRow,
    SyncErrorShape,
    Uuid,
} from '../types';

/**
 * The wire contract between the offline clients and `/api/pos/*` (spec 01 §5, spec 03 §3.6).
 *
 * These types are the *only* place the shape of the protocol is written down on the client. Both
 * the sync engine (`@shared/sync`) and the tests import them; nothing hand-rolls a payload.
 *
 * Two rules that the types enforce:
 *   1. Every monetary field is a `string`. JSON numbers go through a double on both ends.
 *   2. Mutations are ORM-style *commands* (`{op, uuid, …}`), not whole documents — appending a line
 *      to a 60-line restaurant tab is a 400-byte push, not a 40 kB one.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap & delta (pull)
// ─────────────────────────────────────────────────────────────────────────────

export type BootstrapProfile = 'register' | 'self_order' | 'prep_display';

export type BootstrapLimits = {
    products: number;
    customers: number;
    products_total: number;
};

/**
 * `GET /api/pos/{config}/bootstrap`.
 *
 * `data` is keyed by entity name in the dependency order of spec 01 §5.2; the client applies it in
 * that order inside a single IndexedDB transaction so referential integrity holds at every commit.
 */
export type BootstrapResponse = {
    server_time: Iso;
    /** Any change bumps this; a client whose stored revision differs wipes and re-bootstraps. */
    config_revision: number;
    profile: BootstrapProfile;
    schema_version?: number;
    min_client_version?: string;
    limits: BootstrapLimits;
    data: Record<string, unknown[]>;
    tombstones?: Record<string, Array<number | string>>;
};

/** `GET /api/pos/{config}/delta?since=`. Same shape, plus the has-more flag. */
export type DeltaResponse = BootstrapResponse & {
    since: Iso | null;
    has_more?: boolean;
};

export type TombstoneResponse = {
    server_time: Iso;
    tombstones: Record<string, Array<number | string>>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Push
// ─────────────────────────────────────────────────────────────────────────────

export type RecordOp = 'create' | 'update' | 'delete';

/**
 * A per-record command. `create` for a uuid the server already knows is rewritten to `update`
 * server-side, and vice versa — both directions matter (spec 03 §3.6.3).
 */
export type RecordCommand<T> = {
    op: RecordOp;
    uuid: Uuid;
} & Partial<T>;

export type OrderOp = 'upsert' | 'cancel' | 'delete_draft';

export type ApprovalCommand = {
    uuid: Uuid;
    ability: string;
    manager_employee_id: number;
    verified: 'online' | 'offline';
    at: Iso;
    context: Record<string, string | number | null>;
};

export type OrderCommand = {
    uuid: Uuid;
    op: OrderOp;
    /** Last server rev we acknowledged; `null` on create. Drives optimistic concurrency. */
    base_rev: string | null;
    order: Partial<Omit<OrderRow, 'syncState' | 'syncError' | 'rev' | 'baseline' | 'updatedAtLocal'>> & {
        /** Proposals only — the server recomputes and never trusts these. */
        amount_total_client?: Money;
        amount_tax_client?: Money;
    };
    lines: Array<RecordCommand<OrderLineRow>>;
    payments: Array<RecordCommand<PaymentRow>>;
    courses: Array<RecordCommand<CourseRow>>;
    approvals: ApprovalCommand[];
};

/** `POST /api/pos/sync` body. One request may carry many orders; each is processed independently. */
export type SyncPushRequest = {
    device_id: string;
    employee_id: number | null;
    client_version: string;
    client_time: Iso;
    orders: OrderCommand[];
    /** Non-order intents: session lifecycle, cash moves, partner creation, audit batches. */
    commands?: GenericCommand[];
};

export type GenericCommandKind =
    | 'session.open'
    | 'session.close'
    | 'session.cash_move'
    | 'partner.create'
    | 'audit.batch'
    | 'prep.sent'
    | 'order.cancel';

export type GenericCommand = {
    uuid: Uuid;
    kind: GenericCommandKind;
    payload: unknown;
    at: Iso;
};

// ─────────────────────────────────────────────────────────────────────────────
// Push results
// ─────────────────────────────────────────────────────────────────────────────

export type SyncStatus = 'ok' | 'conflict' | 'rejected' | 'superseded';

/**
 * Conflict codes. The first seven mirror `App\Enums\SyncConflictType` exactly; the last two are
 * transport-level and never persisted server-side.
 */
export const ConflictCode = {
    StaleWrite: 'stale_write',
    DuplicateTableOrder: 'duplicate_table_order',
    ClosedSession: 'closed_session',
    UuidCollision: 'uuid_collision',
    PrepSnapshotStale: 'prep_snapshot_stale',
    PayloadMismatch: 'payload_mismatch',
    PriceTamper: 'price_tamper',
    DoublePayment: 'double_payment',
    ReferenceCollision: 'reference_collision',
} as const;
export type ConflictCode = (typeof ConflictCode)[keyof typeof ConflictCode];

export type SyncWarning =
    | { code: 'amount_mismatch'; client: Money; server: Money; delta: Money }
    | { code: 'reference_collision'; assigned: string }
    | { code: 'session_rerouted'; from: number; to: number }
    | { code: 'line_delete_refused'; uuid: Uuid }
    | { code: string; message?: string };

/** Per-record result. A poisoned order must never block the rest of the queue. */
export type SyncRecordResult = {
    uuid: Uuid;
    status: SyncStatus;
    /** Opaque; echoed back as `base_rev` on the next push. */
    server_rev: string | null;
    order?: {
        id: number;
        name: string;
        sequence_number: number;
        /** Server-minted (BAN-496). The client's local value is a placeholder until this lands. */
        access_token: string;
        state: string;
        amount_untaxed: Money;
        amount_tax: Money;
        amount_total: Money;
        amount_paid: Money;
        amount_change: Money;
        amount_due: Money;
        updated_at: Iso;
    };
    lines?: Array<{ uuid: Uuid; id: number; price_subtotal: Money; price_subtotal_incl: Money }>;
    payments?: Array<{ uuid: Uuid; id: number }>;
    courses?: Array<{ uuid: Uuid; id: number }>;
    /** `partner.create` result — the real id for the client's negative placeholder (BAN-404). */
    partner?: { id: number; uuid: Uuid };
    /** `prep.sent` result — the prep snapshot version after the send. */
    snapshot_version?: number;
    warnings?: SyncWarning[];
    /** Present on `conflict` and `rejected`. */
    conflict?: { code: ConflictCode; message: string; serverState?: unknown };
    error?: { code: string; message: string; field?: string };
};

export type SyncPushResponse = {
    server_time: Iso;
    results: SyncRecordResult[];
    /** The server can ask a lagging device to update before it corrupts anything. */
    min_client_version?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

export type SyncError = SyncErrorShape;

/** Map an HTTP failure onto the classified error the UI knows how to present (spec 03 §3.6.6). */
export function classifyHttpError(status: number | undefined, body?: { message?: string; min_client_version?: string }): SyncError {
    if (status === undefined) return { kind: 'offline' };
    if (status === 401) return { kind: 'auth', detail: 'expired' };
    if (status === 403 || status === 410) return { kind: 'auth', detail: 'revoked' };
    if (status === 409) return { kind: 'conflict', reason: 'stale_write', serverState: null };
    if (status === 422) {
        return { kind: 'validation', field: '', message: body?.message ?? 'Validation failed' };
    }
    if (status === 426) return { kind: 'version', min: body?.min_client_version ?? '0.0.0' };
    if (status >= 500) return { kind: 'server_unreachable', status };
    return { kind: 'unknown', message: body?.message ?? `HTTP ${status}` };
}

/** `true` when retrying could plausibly succeed. `rejected` results are never retried blindly. */
export function isRetryable(error: SyncError): boolean {
    switch (error.kind) {
        case 'offline':
        case 'server_unreachable':
        case 'unknown':
            return true;
        case 'conflict':
            // The server returns its state and the client re-diffs; the follow-up push is a new entry.
            return false;
        case 'auth':
        case 'version':
        case 'validation':
        case 'rejected':
            return false;
    }
}
