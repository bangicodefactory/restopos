<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\AuditSeverity;
use App\Enums\CashCountType;
use App\Enums\CashMovementType;
use App\Enums\OrderState;
use App\Enums\SessionEventType;
use App\Enums\SessionState;
use App\Events\Pos\SessionClosed;
use App\Exceptions\Pos\RegisterNotReady;
use App\Models\Identity\Employee;
use App\Models\Pos\CashMovement;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosSession;
use App\Models\Pos\SessionCashCount;
use App\Services\Audit\AuditRecorder;
use App\Services\Pos\Dto\SessionClosingData;
use App\Services\Pos\Dto\SessionXReport;
use App\Support\Audit\AuditEvent;
use DomainException;
use Illuminate\Contracts\Config\Repository as Config;
use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;
use Psr\Log\LoggerInterface;

/**
 * Session lifecycle and cash control (spec 02 REG-001…039, spec 03 §3.6.5).
 *
 * Three rules drive the whole class:
 *
 * 1. **One open session per config** — enforced by the schema, re-checked here
 *    so the caller gets a domain error instead of a constraint violation.
 * 2. **A late order never fails because its session closed.** It is rerouted to
 *    the currently-open session, or into a purpose-built *rescue* session.
 *    Losing a real sale to a bookkeeping constraint is the worst possible
 *    failure mode.
 * 3. **The state transition is the server's.** The client queues the intent;
 *    opening floats, closing variances and manager approvals are decided here.
 */
final readonly class SessionService
{
    public function __construct(
        private ConnectionInterface $connection,
        private SessionSummaryService $summaries,
        private AuditRecorder $audit,
        private Dispatcher $events,
        private LoggerInterface $logger,
        private Config $config,
        private RegisterReadiness $readiness,
        private SessionEventRecorder $sessionEvents,
    ) {}

    /**
     * Open a session. With cash control on, the session lands in
     * `opening_control` until the float is confirmed; without it, straight to
     * `opened`.
     *
     * Refuses outright on a register that cannot trade (REG-002). The check is the *first* thing
     * inside the transaction, so a refused open leaves no session row, no cash count and no audit
     * entry behind — the register is exactly as it was.
     *
     * @param  list<array{denomination_value: string|float, quantity: int, pos_bill_id?: int|null}>  $denominations
     *
     * @throws RegisterNotReady when the register's configuration cannot support a session
     */
    public function open(
        PosConfig $config,
        string $openingFloat = '0',
        ?int $employeeId = null,
        ?int $userId = null,
        ?string $notes = null,
        array $denominations = [],
    ): PosSession {
        return $this->connection->transaction(function () use ($config, $openingFloat, $employeeId, $userId, $notes, $denominations): PosSession {
            $problems = $this->readiness->problems($config);

            if ($problems !== []) {
                throw new RegisterNotReady($problems);
            }

            $existing = PosSession::query()
                ->where('pos_config_id', $config->getKey())
                ->where('is_rescue', false)
                ->where('state', '!=', SessionState::Closed->value)
                ->lockForUpdate()
                ->first();

            if ($existing !== null) {
                throw new DomainException('This register already has an open session.');
            }

            $expected = $this->expectedOpeningFloat($config);

            /** @var PosSession $session */
            $session = PosSession::query()->create([
                'uuid' => (string) Str::uuid(),
                'pos_config_id' => $config->getKey(),
                'company_id' => $config->company_id,
                'currency_id' => $config->currency_id,
                // Numbered only once it starts trading. A session that goes straight to `opened`
                // is trading now; one held in `opening_control` may never be (REG-003).
                'name' => $config->has_cash_control ? null : $this->nextName($config),
                'state' => $config->has_cash_control ? SessionState::OpeningControl->value : SessionState::Opened->value,
                'opened_by_employee_id' => $employeeId,
                'opened_by_user_id' => $userId,
                'opened_at' => now(),
                'business_date' => now()->toDateString(),
                'opening_notes' => $notes,
                'has_cash_control' => (bool) $config->has_cash_control,
                'cash_balance_opening' => $openingFloat,
                'cash_balance_opening_expected' => $expected,
            ]);

            if ($denominations !== []) {
                $this->recordCount($session, CashCountType::Opening, $denominations, $employeeId, $notes);
            }

            // Money declared into the drawer gets a ledger row, whether or not the register counts.
            // Gating this on `has_cash_control` was harmless only while such a register always
            // opened at zero — which stopped being true when the expected float started carrying
            // over (REG-004). Nothing sums `opening_float`, so expected cash was never wrong; the
            // movements list a manager reads simply could not account for the opening balance.
            if ($config->has_cash_control || $this->isNonZeroAmount($openingFloat)) {
                $this->recordMovement($session, CashMovementType::OpeningFloat, $openingFloat, 'Opening float', $employeeId, $userId, null);
            }

            $this->audit->record(
                event: AuditEvent::SessionOpened,
                subject: $session,
                message: 'Session '.$session->label()." opened with a float of {$openingFloat}",
                changes: ['cash_balance_opening' => ['old' => null, 'new' => $openingFloat]],
                config: $config,
                session: $session,
                employeeId: $employeeId,
                userId: $userId,
            );

            $this->sessionEvents->record(
                $session,
                SessionEventType::Opened,
                ['opening_float' => $openingFloat, 'expected' => $expected],
                employeeId: $employeeId,
                userId: $userId,
            );

            return $session;
        });
    }

    /**
     * Confirm the opening control and start trading.
     *
     * **This is where the session number is minted** (REG-003). A register held in `opening_control`
     * has not traded and may never — the cashier walks off, the shift is cancelled, the drawer is
     * short and the open is abandoned — and a number burnt on a session that never existed leaves a
     * gap in the sequence an accountant has to explain.
     *
     * Serialised on the session row: two devices confirming the same opening control would otherwise
     * both read "no name yet", both count the same sessions, and both mint the same number.
     */
    public function confirmOpeningControl(PosSession $session, string $countedFloat, ?int $employeeId = null): PosSession
    {
        return $this->connection->transaction(function () use ($session, $countedFloat, $employeeId): PosSession {
            // Re-read under the lock rather than trusting the instance the caller handed us: it was
            // loaded by route binding, before this transaction, and its state may be stale.
            /** @var PosSession $locked */
            $locked = PosSession::query()->whereKey($session->getKey())->lockForUpdate()->firstOrFail();

            if ($locked->state !== SessionState::OpeningControl) {
                throw new DomainException('This session is not awaiting an opening control.');
            }

            $session->setRawAttributes($locked->getAttributes(), true);

            $expected = (string) $session->cash_balance_opening;

            $session->forceFill([
                'state' => SessionState::Opened->value,
                'name' => $session->name ?? $this->nextName($session->posConfig()->firstOrFail()),
                'cash_balance_opening' => $countedFloat,
                'opened_by_employee_id' => $session->opened_by_employee_id ?? $employeeId,
            ])->save();

            $this->audit->record(
                event: AuditEvent::SessionOpeningControlConfirmed,
                subject: $session,
                // A counted float that disagrees with the declared one is the first thing that can go
                // wrong in a shift, and the last thing anyone remembers by the close.
                severity: bccomp($countedFloat, $expected, 4) === 0 ? AuditSeverity::Info : AuditSeverity::Notice,
                message: 'Opening control confirmed',
                changes: ['cash_balance_opening' => ['old' => $expected, 'new' => $countedFloat]],
                config: $session->pos_config_id,
                session: $session,
                employeeId: $employeeId,
            );

            $this->sessionEvents->record(
                $session,
                SessionEventType::OpeningControlConfirmed,
                ['counted_float' => $countedFloat, 'name' => $session->name],
                employeeId: $employeeId,
            );

            return $session;
        });
    }

    /**
     * Cash in / out. `amount` is signed by the movement type here so callers
     * always pass a positive magnitude.
     */
    public function cashMove(
        PosSession $session,
        CashMovementType $type,
        string $amount,
        ?string $reason = null,
        ?int $employeeId = null,
        ?int $userId = null,
        ?int $deviceId = null,
        ?string $uuid = null,
    ): CashMovement {
        if (! $session->state->canTrade()) {
            throw new DomainException('Cash movements require an open session.');
        }

        // Checked here rather than only at the HTTP boundary, because there are **two** ways in and
        // BAN-507 only closed one. `CashMovementRequest` validates the endpoint; the sync path
        // arrives through the generic `commands[]` envelope, whose payload is typed `array` and
        // nothing more. A movement of `'plenty'` went into a `decimal(16,4)` column and was summed
        // into the expected drawer — silently on SQLite, as an error on a strict database.
        if (! $this->isDecimal($amount)) {
            throw new DomainException('A cash movement needs an amount written as a decimal number.');
        }

        // Money may only be attributed to someone who works here. `employee_id` arrives as a bare
        // integer on both routes in, and nothing checked whose it was — so a movement could be
        // recorded against another company's employee, which is a falsified record before it is
        // anything else. Refused rather than quietly nulled: a push naming a stranger is not a
        // rounding error, and swallowing it would hide that it happened.
        if ($employeeId !== null && ! $this->employsWho($session, $employeeId)) {
            throw new DomainException('That employee does not work for this company.');
        }

        $magnitude = ltrim($amount, '-');
        $signed = $type === CashMovementType::CashOut || $type === CashMovementType::ClosingLift
            ? '-'.$magnitude
            : $magnitude;

        return $this->connection->transaction(function () use ($session, $type, $signed, $reason, $employeeId, $userId, $deviceId, $uuid): CashMovement {
            /** @var CashMovement $movement */
            $movement = CashMovement::query()->updateOrCreate(
                ['uuid' => $uuid ?? (string) Str::uuid()],
                [
                    'pos_session_id' => $session->getKey(),
                    'company_id' => $session->company_id,
                    'movement_type' => $type->value,
                    'amount' => $signed,
                    'reason' => $reason,
                    'employee_id' => $employeeId,
                    'user_id' => $userId,
                    'pos_device_id' => $deviceId,
                    'moved_at' => now(),
                ],
            );

            $this->refreshCashTotals($session);

            // `updateOrCreate` on the uuid means a replayed outbox entry lands here again; log the
            // movement, not the request, or a flaky connection reads as repeated cash-outs.
            if ($movement->wasRecentlyCreated) {
                $this->audit->record(
                    event: AuditEvent::CashMoveCreated,
                    subject: $movement,
                    companyId: (int) $session->company_id,
                    severity: AuditSeverity::Notice,
                    message: trim("{$type->value} {$signed} ".($reason ?? '')),
                    changes: ['amount' => ['old' => null, 'new' => $signed]],
                    config: $session->pos_config_id,
                    session: $session,
                    employeeId: $employeeId,
                    userId: $userId,
                    device: $deviceId,
                );
            }

            // Repeatable by nature: two cash-outs in a shift are two cash-outs, so these append
            // rather than dedupe. The movement carries the money; this carries the shift's order.
            $this->sessionEvents->record(
                $session,
                $type === CashMovementType::CashIn ? SessionEventType::CashIn : SessionEventType::CashOut,
                ['amount' => $signed, 'reason' => $reason],
                employeeId: $employeeId,
                userId: $userId,
                deviceId: $deviceId,
            );

            return $movement;
        });
    }

    /**
     * Delete a cash movement — manager-gated at the controller.
     *
     * The deletion is logged, not the movement: the row itself is about to stop existing, and
     * "money left the drawer and then the record of it was removed" is a materially different fact
     * from either half on its own.
     */
    public function deleteCashMovement(CashMovement $movement): void
    {
        $session = $movement->pos_session_id === null
            ? null
            : PosSession::query()->find($movement->pos_session_id);

        $this->audit->record(
            event: AuditEvent::CashMoveDeleted,
            subject: $movement,
            companyId: (int) $movement->company_id,
            severity: AuditSeverity::Warning,
            message: "Cash movement {$movement->movement_type->value} {$movement->amount} deleted",
            changes: ['amount' => ['old' => (string) $movement->amount, 'new' => null]],
            config: $session?->pos_config_id,
            session: $session,
            employeeId: $movement->employee_id,
            device: $movement->pos_device_id,
        );

        $movement->delete();

        if ($session !== null) {
            $this->refreshCashTotals($session);
        }
    }

    /**
     * Everything the closing popup needs (spec 01-schema §5.4,
     * `sessions/{id}/closing-data`).
     */
    public function closingData(PosSession $session): SessionClosingData
    {
        $config = $session->posConfig()->first();

        $expectedByMethod = $this->summaries->expectedPaymentTotals($session);

        $cashExpected = $this->expectedCash($session);

        return new SessionClosingData(
            sessionId: (int) $session->getKey(),
            openingBalance: (string) $session->cash_balance_opening,
            cashIn: (string) $session->cash_in_total,
            cashOut: (string) $session->cash_out_total,
            expectedCash: $cashExpected,
            paymentTotals: $expectedByMethod,
            orderCount: (int) $session->order_count,
            draftOrderCount: $this->draftOrderCount($session),
            amountAuthorizedDiff: $config?->set_maximum_difference
                ? (string) ($config->amount_authorized_diff ?? '0')
                : (string) $this->config->get('pos.session.default_authorized_difference', 0),
            enforcesMaximumDifference: (bool) ($config?->set_maximum_difference ?? false),
        );
    }

    /**
     * The X-report: this session's trading so far, without ending it (REG-020, REG-022).
     *
     * A Z-report happens once, at close. An X-report is the same figures asked for mid-service — a
     * shift handover, a bank run, a manager wanting to know how the day is going — and asking must
     * not end the day. Nothing here writes to the session; the only side effect is the event row,
     * because "who pulled a reading, and when" is itself part of the shift's story.
     *
     * Every figure comes from {@see SessionSummaryService}'s live aggregations, which are the same
     * queries `freeze()` persists at close. That is what makes "an X-report matches the totals
     * computed at close for the same orders" true by construction rather than by test: neither
     * report has arithmetic of its own to disagree with.
     */
    public function xReport(PosSession $session, ?int $employeeId = null): SessionXReport
    {
        $id = (int) $session->getKey();
        $config = $session->posConfig()->first();

        $salesRows = $this->summaries->salesSummaryRows([$id]);
        $taxRows = $this->summaries->taxSummaryRows([$id]);

        // Refunds are their own rows rather than a negative fold into sales: a service that took
        // 900 and gave back 100 is a different day from one that took 800, and a report that cannot
        // tell them apart is the report nobody trusts.
        $sales = '0';
        $refunds = '0';

        foreach ($salesRows as $row) {
            // The **base**, not `total_amount`: tax is reported on its own line below, and the
            // accounting export means the same thing by "sales" (`session_sales_summaries
            // .base_amount`). Summing the tax-inclusive column and then printing tax beside it
            // would show the VAT twice on the same slip.
            $amount = (string) ($row['base_amount'] ?? '0');

            if ($row['is_refund'] ?? false) {
                $refunds = bcadd($refunds, $amount, 4);

                continue;
            }

            $sales = bcadd($sales, $amount, 4);
        }

        $tax = '0';

        foreach ($taxRows as $row) {
            $tax = bcadd($tax, (string) ($row['tax_amount'] ?? '0'), 4);
        }

        // Scaled once, here, rather than left as whatever bcmath handed back: a shift with no
        // refunds answered `"0"` while every neighbouring field was 4dp, and a client formatting
        // the two the same way has to guess.
        $sales = bcadd($sales, '0', 4);
        $tax = bcadd($tax, '0', 4);
        $refunds = bcadd($refunds, '0', 4);

        // One query, not two: the payload below and the DTO want the same figure, and this runs on
        // a path a cashier is waiting on.
        $expectedCash = $this->expectedCash($session);

        // The figures as they stood at the reading, so the row still means something when somebody
        // reads it back next month against a drawer that went missing at 19:00.
        //
        // Recorded on the *request*, not on a successful print: "somebody pulled a reading at
        // 18:30" stays true when the paper jams, and a till that asks for the figures four times in
        // an hour is the pattern worth seeing whether or not any of it came out.
        $this->sessionEvents->record(
            $session,
            SessionEventType::XReport,
            ['sales' => $sales, 'tax' => $tax, 'refunds' => $refunds, 'expected_cash' => $expectedCash],
            employeeId: $employeeId,
        );

        return new SessionXReport(
            sessionId: $id,
            sessionName: $session->name,
            configName: (string) ($config?->name ?? ''),
            openedAt: $session->opened_at?->toIso8601ZuluString(),
            printedAt: Carbon::now()->toIso8601ZuluString(),
            cashierName: $employeeId === null
                ? null
                : Employee::query()->whereKey($employeeId)->value('name'),
            orderCount: $this->tradedOrderCount($session),
            salesTotal: $sales,
            taxTotal: $tax,
            refundTotal: $refunds,
            openingBalance: (string) $session->cash_balance_opening,
            cashIn: (string) $session->cash_in_total,
            cashOut: (string) $session->cash_out_total,
            expectedCash: $expectedCash,
            salesRows: $salesRows,
            taxRows: $taxRows,
            paymentTotals: $this->summaries->expectedPaymentTotals($session),
        );
    }

    /**
     * Orders that have actually traded, counted live.
     *
     * Not `pos_sessions.order_count`, which means two different things depending on when you read
     * it: {@see SequenceService} increments it for every order that takes a sequence number — a
     * cancelled sale included — and `freeze()` then *overwrites* it at close with the count of
     * paid and done orders. Mid-shift it is therefore a sequence high-water mark, and a reading
     * that used it would quietly disagree with the Z-report it is supposed to match.
     */
    private function tradedOrderCount(PosSession $session): int
    {
        return (int) $this->connection->table('pos_orders')
            ->where('pos_session_id', $session->getKey())
            ->whereIn('state', [OrderState::Paid->value, OrderState::Done->value])
            ->whereNull('deleted_at')
            ->count();
    }

    /**
     * Close the session: count the drawer, compute the difference against
     * expected, refuse an over-threshold variance unless a manager approved it,
     * then freeze the summaries.
     *
     * @param  array<int, string>  $countedByMethod  payment_method_id => counted amount
     * @param  list<array{denomination_value: string|float, quantity: int, pos_bill_id?: int|null}>  $denominations
     */
    public function close(
        PosSession $session,
        ?string $countedCash = null,
        array $countedByMethod = [],
        array $denominations = [],
        ?int $employeeId = null,
        ?int $userId = null,
        ?string $notes = null,
        bool $managerApproved = false,
        bool $force = false,
        ?int $approvedByEmployeeId = null,
        bool $abandon = false,
    ): PosSession {
        if ($session->state === SessionState::Closed) {
            throw new DomainException('This session is already closed.');
        }

        // A session still awaiting its opening control has never traded: it has no sales, no
        // sequence number and an opening float nobody confirmed. Closing it is a different act from
        // closing a shift — it is abandoning an open that was started by mistake — and it has to be
        // asked for, because reaching this by accident produces a Z-report for a day that never
        // happened (REG-017, server audit 4.14).
        if ($session->state === SessionState::OpeningControl && ! $abandon) {
            throw new DomainException(
                'This session has not started trading. Confirm the opening control first, or abandon it explicitly.',
            );
        }

        $drafts = $this->draftOrderCount($session);

        if ($drafts > 0 && ! $force) {
            throw new DomainException("This session still has {$drafts} draft order(s). Settle or cancel them, or force the close.");
        }

        return $this->connection->transaction(function () use (
            $session, $countedCash, $countedByMethod, $denominations, $employeeId, $userId, $notes, $managerApproved, $force, $drafts, $approvedByEmployeeId
        ): PosSession {
            $expectedCash = $this->expectedCash($session);
            $counted = $countedCash ?? $expectedCash;
            $difference = bcsub($counted, $expectedCash, 4);

            $config = $session->posConfig()->first();

            // A variance gate only exists when the register asks for one. With
            // `set_maximum_difference` off, any difference closes: the number is
            // recorded and reported, but the cashier is not held hostage by it.
            $enforced = (bool) ($config?->set_maximum_difference ?? false);
            $threshold = $enforced
                ? (string) ($config->amount_authorized_diff ?? '0')
                : (string) $this->config->get('pos.session.default_authorized_difference', 0);

            $overThreshold = $enforced && bccomp($this->abs($difference), $this->abs($threshold), 4) > 0;

            if ($overThreshold && ! $managerApproved) {
                throw new DomainException(sprintf(
                    'Closing difference %s exceeds the authorised %s. A manager approval is required.',
                    $difference,
                    $threshold,
                ));
            }

            if ($denominations !== []) {
                $this->recordCount($session, CashCountType::Closing, $denominations, $employeeId, $notes);
            }

            $session->forceFill([
                'state' => SessionState::Closed->value,
                'closed_at' => now(),
                'closed_by_employee_id' => $employeeId,
                'closed_by_user_id' => $userId,
                'closing_notes' => $notes,
                'cash_balance_closing_counted' => $counted,
                'cash_balance_closing_expected' => $expectedCash,
                'cash_difference' => $difference,
                'closing_forced' => $force && $drafts > 0,
                'closing_force_reason' => $force && $drafts > 0 ? "{$drafts} draft order(s) left open" : null,
                // Who signed off on the over-variance (REG-016); null on a within-threshold close.
                'over_variance_approved_by_employee_id' => $managerApproved ? $approvedByEmployeeId : null,
            ])->save();

            $totals = $this->summaries->freeze($session, $countedByMethod);

            if (bccomp($difference, '0', 4) !== 0) {
                $this->recordMovement(
                    $session,
                    CashMovementType::Difference,
                    $difference,
                    'Closing difference',
                    $employeeId,
                    $userId,
                    null,
                );
            }

            $this->audit->record(
                event: AuditEvent::SessionClosed,
                subject: $session,
                // A close that balances is routine; one that does not is the number an accountant
                // will ask about, so it must be findable by severity alone.
                severity: bccomp($difference, '0', 4) === 0 ? AuditSeverity::Info : AuditSeverity::Warning,
                message: 'Session '.$session->label()." closed, difference {$difference}",
                changes: [
                    'cash_balance_closing_expected' => ['old' => null, 'new' => $expectedCash],
                    'cash_balance_closing_counted' => ['old' => null, 'new' => $counted],
                    'cash_difference' => ['old' => null, 'new' => $difference],
                ],
                config: $session->pos_config_id,
                session: $session,
                employeeId: $employeeId,
                userId: $userId,
            );

            // Two separate facts, deliberately two separate rows. A manager who signs off variances
            // is a pattern; it only reads as one if each sign-off is its own row to count.
            if ($overThreshold && $managerApproved) {
                $this->audit->record(
                    event: AuditEvent::SessionOverVarianceApproved,
                    subject: $session,
                    severity: AuditSeverity::Critical,
                    message: "Difference {$difference} over the authorised {$threshold} approved",
                    changes: [
                        'cash_difference' => ['old' => null, 'new' => $difference],
                        'threshold' => ['old' => null, 'new' => $threshold],
                    ],
                    config: $session->pos_config_id,
                    session: $session,
                    employeeId: $approvedByEmployeeId,
                    userId: $userId,
                );
            }

            if ($force && $drafts > 0) {
                $this->audit->record(
                    event: AuditEvent::SessionForceClosed,
                    subject: $session,
                    severity: AuditSeverity::Warning,
                    message: "Closed with {$drafts} draft order(s) left open",
                    config: $session->pos_config_id,
                    session: $session,
                    employeeId: $employeeId,
                    userId: $userId,
                );
            }

            // One or the other, never both: a forced close *is* the close, and recording it twice
            // would make every forced shift look like it ended twice.
            $this->sessionEvents->record(
                $session,
                $force || ($overThreshold && $managerApproved) ? SessionEventType::ForceClosed : SessionEventType::Closed,
                array_filter([
                    'counted_cash' => $countedCash,
                    'difference' => $difference,
                    'drafts' => $drafts > 0 ? $drafts : null,
                    'over_variance' => $overThreshold ? $threshold : null,
                    'approved_by_employee_id' => $approvedByEmployeeId,
                ], static fn (mixed $v): bool => $v !== null),
                employeeId: $employeeId,
                userId: $userId,
            );

            $config = $config ?? $session->posConfig()->first();

            if ($config !== null) {
                $this->events->dispatch(new SessionClosed(
                    configToken: (string) $config->access_token,
                    sessionId: (int) $session->getKey(),
                    state: SessionState::Closed->value,
                    cashDifference: $difference,
                    totals: $totals,
                ));
            }

            return $session;
        });
    }

    /**
     * Resolve the session an incoming order belongs to (spec 03 §3.6.5).
     *
     * Preference order: the requested session if it is still open on this
     * config → any open session on the config → a **rescue** session created on
     * the spot. We never reject an order because its session closed.
     *
     * @return array{session: PosSession, rerouted: bool, rescued: bool}
     */
    public function resolveForIngest(PosConfig $config, ?int $requestedSessionId, string $orderUuid): array
    {
        if ($requestedSessionId !== null) {
            /** @var PosSession|null $session */
            $session = PosSession::query()->find($requestedSessionId);

            if ($session !== null
                && (int) $session->pos_config_id === (int) $config->getKey()
                && $session->state->canTrade()
            ) {
                return ['session' => $session, 'rerouted' => false, 'rescued' => false];
            }
        }

        /** @var PosSession|null $open */
        $open = PosSession::query()
            ->where('pos_config_id', $config->getKey())
            ->whereIn('state', [SessionState::Opened->value, SessionState::OpeningControl->value])
            ->orderByDesc('id')
            ->first();

        if ($open !== null) {
            $this->logger->info('pos.sync.session_rerouted', [
                'order' => $orderUuid,
                'from' => $requestedSessionId,
                'to' => $open->getKey(),
            ]);

            return ['session' => $open, 'rerouted' => true, 'rescued' => false];
        }

        return [
            'session' => $this->createRescue($config, "late order {$orderUuid}", $requestedSessionId),
            'rerouted' => true,
            'rescued' => true,
        ];
    }

    /**
     * A rescue session: `is_rescue = true`, excluded from the one-open-session
     * invariant, invisible in the register's picker and flagged red in the
     * back-office until a manager reconciles it.
     */
    public function createRescue(PosConfig $config, string $reason, ?int $rescuedFrom = null): PosSession
    {
        /** @var PosSession $session */
        $session = PosSession::query()->create([
            'uuid' => (string) Str::uuid(),
            'pos_config_id' => $config->getKey(),
            'company_id' => $config->company_id,
            'currency_id' => $config->currency_id,
            'name' => $this->config->get('pos.session.rescue_name_prefix', 'RESCUE').'/'.$this->nextName($config),
            'state' => SessionState::Opened->value,
            'opened_at' => now(),
            'business_date' => now()->toDateString(),
            'opening_notes' => $reason,
            'has_cash_control' => false,
            'is_rescue' => true,
            'rescued_from_session_id' => $rescuedFrom,
        ]);

        $this->logger->warning('pos.sync.rescue_session_created', [
            'config' => $config->getKey(),
            'session' => $session->getKey(),
            'reason' => $reason,
        ]);

        // On the rescue session, not on the one it rescued: that session is closed and its story
        // has ended. The link back is `rescued_from_session_id`, and the payload repeats it so the
        // row reads on its own.
        $this->sessionEvents->record($session, SessionEventType::Rescued, array_filter([
            'reason' => $reason,
            'rescued_from_session_id' => $rescuedFrom,
        ], static fn (mixed $v): bool => $v !== null));

        return $session;
    }

    /** Expected drawer content = opening float + cash sales + cash in/out. */
    public function expectedCash(PosSession $session): string
    {
        // Change always *leaves* the drawer, so a change row counts as negative regardless of the
        // sign it was stored with — a positive-signed change row would otherwise overstate expected
        // cash by twice the change given (REG-204).
        $cashSales = (string) ($this->connection->table('pos_payments')
            ->join('payment_methods', 'payment_methods.id', '=', 'pos_payments.payment_method_id')
            ->where('pos_payments.pos_session_id', $session->getKey())
            ->whereNull('pos_payments.deleted_at')
            ->where('payment_methods.is_cash_count', true)
            ->selectRaw('coalesce(sum(case when pos_payments.is_change then -abs(pos_payments.amount) else pos_payments.amount end), 0) as cash')
            ->value('cash') ?? '0');

        $movements = (string) ($this->connection->table('cash_movements')
            ->where('pos_session_id', $session->getKey())
            ->whereNull('deleted_at')
            ->whereIn('movement_type', [CashMovementType::CashIn->value, CashMovementType::CashOut->value])
            ->sum('amount') ?? '0');

        return bcadd(bcadd((string) $session->cash_balance_opening, $cashSales, 4), $movements, 4);
    }

    /**
     * Drafts that stand between this session and its close.
     *
     * A draft booked for *later* is not one of them. `preset_time` in the future is tomorrow
     * lunchtime's table, taken today and deliberately left open; counting it against tonight's close
     * tells the cashier to "settle or cancel" an order whose customer has not arrived, and forcing
     * the close over it files the sale in the wrong period when it finally lands.
     *
     * Nothing needs to move it: `pos_orders.pos_session_id` is not nullable, and the next push that
     * touches the order is rerouted to whichever session is open by `resolveForIngest`. Leaving it
     * attached to a closed session is therefore harmless — the money follows the reroute, and this
     * count is only ever about what blocks the close (REG-017).
     */
    public function draftOrderCount(PosSession $session): int
    {
        return $this->connection->table('pos_orders')
            ->where('pos_session_id', $session->getKey())
            ->where('state', OrderState::Draft->value)
            ->whereNull('deleted_at')
            ->where(fn ($q) => $q->whereNull('preset_time')->orWhere('preset_time', '<=', now()))
            ->count();
    }

    // ------------------------------------------------------------------ internals

    private function refreshCashTotals(PosSession $session): void
    {
        $in = (string) ($this->connection->table('cash_movements')
            ->where('pos_session_id', $session->getKey())
            ->whereNull('deleted_at')
            ->where('movement_type', CashMovementType::CashIn->value)
            ->sum('amount') ?? '0');

        $out = (string) ($this->connection->table('cash_movements')
            ->where('pos_session_id', $session->getKey())
            ->whereNull('deleted_at')
            ->where('movement_type', CashMovementType::CashOut->value)
            ->sum('amount') ?? '0');

        $session->forceFill([
            'cash_in_total' => $in,
            'cash_out_total' => $out,
        ])->save();
    }

    private function recordMovement(
        PosSession $session,
        CashMovementType $type,
        string $amount,
        string $reason,
        ?int $employeeId,
        ?int $userId,
        ?int $deviceId,
    ): void {
        CashMovement::query()->create([
            'uuid' => (string) Str::uuid(),
            'pos_session_id' => $session->getKey(),
            'company_id' => $session->company_id,
            'movement_type' => $type->value,
            'amount' => $amount,
            'reason' => $reason,
            'employee_id' => $employeeId,
            'user_id' => $userId,
            'pos_device_id' => $deviceId,
            'moved_at' => now(),
        ]);
    }

    /**
     * @param  list<array{denomination_value: string|float, quantity: int, pos_bill_id?: int|null}>  $denominations
     */
    private function recordCount(PosSession $session, CashCountType $type, array $denominations, ?int $employeeId, ?string $notes): void
    {
        $total = '0';

        /** @var SessionCashCount $count */
        $count = SessionCashCount::query()->create([
            'uuid' => (string) Str::uuid(),
            'pos_session_id' => $session->getKey(),
            'count_type' => $type->value,
            'total_counted' => '0',
            'counted_by_employee_id' => $employeeId,
            'counted_at' => now(),
            'notes' => $notes,
        ]);

        foreach ($denominations as $row) {
            $value = (string) $row['denomination_value'];
            $qty = (int) $row['quantity'];
            $subtotal = bcmul($value, (string) $qty, 4);
            $total = bcadd($total, $subtotal, 4);

            $this->connection->table('session_cash_count_lines')->insert([
                'session_cash_count_id' => $count->getKey(),
                'pos_bill_id' => $row['pos_bill_id'] ?? null,
                'denomination_value' => $value,
                'quantity' => $qty,
                'subtotal' => $subtotal,
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }

        $count->forceFill(['total_counted' => $total])->save();
    }

    /**
     * What the drawer should hold at the start of the next shift: whatever was counted into it at
     * the last close (REG-004).
     *
     * Public because the register asks for it *before* a session exists — the open pane shows it so
     * the cashier counts against a number instead of into the void.
     */
    public function expectedOpeningFloat(PosConfig $config): string
    {
        $last = PosSession::query()
            ->where('pos_config_id', $config->getKey())
            ->where('state', SessionState::Closed->value)
            ->orderByDesc('closed_at')
            ->first();

        $counted = (string) ($last?->cash_balance_closing_counted ?? '0');

        // Never advise a float the open would refuse. `counted_cash` only rejects negatives as of
        // BAN-507, so a session closed before that is sitting on one right now — and a register
        // without cash control sends this value back verbatim, so it would be told to expect −50,
        // send −50, and be refused. Every attempt, until someone edited the database.
        //
        // The clamp is the general form of that: an endpoint that tells a client what to send must
        // not name something it will then reject.
        // `cash_balance_closing_counted` is a `decimal:4` cast, so it is always bc-safe here.
        return bccomp($counted, '0', 4) < 0 ? '0' : $counted;
    }

    /**
     * The next session number for this register.
     *
     * Counts **named** sessions only. An opening control that was abandoned never got a name, and
     * skipping it here is the whole point: numbering off the row count would leave a hole in the
     * sequence for a session that never traded.
     */
    private function nextName(PosConfig $config): string
    {
        $count = PosSession::query()
            ->where('pos_config_id', $config->getKey())
            ->whereNotNull('name')
            ->count() + 1;

        return sprintf('%s/%05d', preg_replace('/[^A-Za-z0-9]/', '', (string) $config->name) ?: 'POS', $count);
    }

    private function abs(string $value): string
    {
        return ltrim($value, '-');
    }

    /** Does this employee belong to the company whose drawer is being moved? */
    private function employsWho(PosSession $session, int $employeeId): bool
    {
        return $this->connection->table('employees')
            ->where('id', $employeeId)
            ->where('company_id', $session->company_id)
            ->exists();
    }

    /**
     * An amount bcmath can read.
     *
     * Not belt-and-braces: `bccomp` is stricter than `is_numeric` and throws a ValueError on `1e2`,
     * which `is_numeric` happily accepts. Every amount here arrives from a request, so a value that
     * never reaches bcmath is the difference between a rejected payload and a 500 (BAN-413).
     */
    private function isDecimal(string $amount): bool
    {
        return preg_match('/^[+-]?(\d+(\.\d*)?|\.\d+)$/', $amount) === 1;
    }

    /** A well-formed amount that is not zero. */
    private function isNonZeroAmount(string $amount): bool
    {
        return $this->isDecimal($amount) && bccomp($amount, '0', 4) !== 0;
    }
}
