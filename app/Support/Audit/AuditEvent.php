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

    /** A device tried to change an order that was already paid (BAN-410). */
    public const SettledOrderWriteRejected = 'order.settled_write_rejected';

    // ----------------------------------------------------------------- people
    /** A manager PIN authorising an action the cashier could not take alone (REG-045). */
    public const EmployeeOverride = 'employee.override';

    // ------------------------------------------------------------- back office
    public const ConfigChanged = 'config.changed';
}
