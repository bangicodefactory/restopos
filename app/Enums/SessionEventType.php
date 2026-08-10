<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * A typed step in a session's life (REG-024, spec §4.4).
 *
 * `audit_logs` already records who did what to an *order*, and `cash_movements` records money
 * moving. Neither answers the question a manager actually asks the morning after: what happened to
 * this till yesterday, in order? The opening float was confirmed at 08:12, someone pulled a reading
 * at 14:30, a manager forced the close at 23:58 — those are session facts, and reconstructing them
 * from three other tables and a state column is guesswork.
 *
 * Deliberately a small closed set. An event here is a *lifecycle transition*, not a general log:
 * anything that does not change what the session is, or is not a reading of it, belongs on the
 * audit trail instead.
 */
enum SessionEventType: string
{
    use HasEnumHelpers;

    /** The session was opened; the float is declared but not yet counted. */
    case Opened = 'opened';

    /** A cashier counted the drawer and confirmed the opening float (REG-015). */
    case OpeningControlConfirmed = 'opening_control_confirmed';

    case CashIn = 'cash_in';

    case CashOut = 'cash_out';

    /** A mid-shift reading. Changes nothing, which is exactly why it is worth recording. */
    case XReport = 'x_report';

    case Closed = 'closed';

    /** Closed over unsettled drafts, or over the authorised variance with a manager's approval. */
    case ForceClosed = 'force_closed';

    /** Orders arrived for a session that had already gone; this one was created to catch them. */
    case Rescued = 'rescued';

    public function label(): string
    {
        return match ($this) {
            self::Opened => 'Opened',
            self::OpeningControlConfirmed => 'Opening float confirmed',
            self::CashIn => 'Cash in',
            self::CashOut => 'Cash out',
            self::XReport => 'X-report',
            self::Closed => 'Closed',
            self::ForceClosed => 'Force closed',
            self::Rescued => 'Rescue session created',
        };
    }

    /** Does this event end the session? Two do, and they are mutually exclusive. */
    public function isTerminal(): bool
    {
        return $this === self::Closed || $this === self::ForceClosed;
    }
}
