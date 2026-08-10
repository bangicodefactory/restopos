<?php

declare(strict_types=1);

namespace App\Support\Audit;

/**
 * The `audit_logs.event` vocabulary (spec 01-schema §2.K).
 *
 * Constants rather than a backed enum, deliberately. `event` is `string(64)` with no CHECK
 * constraint precisely because the set is open — every feature that lands adds to it, and an
 * auditor's question is answered by reading rows, not by exhausting a type. What the constants buy
 * is the thing an open column costs: a typo in a literal writes a row nobody will ever find again,
 * because the reader greps for the string the *writer* meant.
 *
 * Naming is `subject.action`, past tense, dot-separated, lowercase.
 */
final class AuditEvent
{
    // ------------------------------------------------------------------ session
    public const SessionOpened = 'session.opened';

    public const SessionClosed = 'session.closed';

    public const SessionOpeningControlConfirmed = 'session.opening_control_confirmed';

    /** A close over the authorised variance that a manager signed off (REG-016). */
    public const SessionOverVarianceApproved = 'session.over_variance_approved';

    /** A close that left draft orders behind. */
    public const SessionForceClosed = 'session.force_closed';

    // --------------------------------------------------------------------- cash
    public const CashMoveCreated = 'cash.move.created';

    public const CashMoveDeleted = 'cash.move.deleted';

    /** The one action that moves money with no row of its own to show for it. */
    public const CashDrawerOpened = 'cash.drawer.opened';

    // -------------------------------------------------------------------- order
    public const OrderPaymentChanged = 'order.payment.changed';

    public const OrderCancelled = 'order.cancelled';

    /** Money given back, and money a device tried to give back that was not owed (BAN-406). */
    public const RefundAccepted = 'order.refund.accepted';

    public const RefundRefused = 'order.refund.refused';

    /** A device tried to change an order that was already paid (BAN-410). */
    public const SettledOrderWriteRejected = 'order.settled_write_rejected';

    /**
     * A settled sale repriced above what the till collected, and the difference written off
     * (BAN-514). Not a fraud signal on its own — a stale catalogue does this — but it is money the
     * venue expected and did not get, so it belongs on the trail with the device that took it.
     */
    public const StalePriceWrittenOff = 'order.stale_price_written_off';

    // ----------------------------------------------------------------- people
    /** A manager PIN authorising an action the cashier could not take alone (REG-045). */
    public const EmployeeOverride = 'employee.override';

    /**
     * An override the device claimed and could not justify (BAN-430): an ability nobody defines,
     * or one the named approver does not hold. Attributed to the till that asked, not to the
     * manager it named.
     */
    public const EmployeeOverrideRefused = 'employee.override_refused';

    // ------------------------------------------------------------- back office
    public const ConfigChanged = 'config.changed';
}
