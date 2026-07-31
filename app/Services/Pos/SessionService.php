<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\CashCountType;
use App\Enums\CashMovementType;
use App\Enums\OrderState;
use App\Enums\SessionState;
use App\Events\Pos\SessionClosed;
use App\Models\Pos\CashMovement;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosSession;
use App\Models\Pos\SessionCashCount;
use App\Services\Pos\Dto\SessionClosingData;
use DomainException;
use Illuminate\Contracts\Config\Repository as Config;
use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Database\ConnectionInterface;
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
        private Dispatcher $events,
        private LoggerInterface $logger,
        private Config $config,
    ) {}

    /**
     * Open a session. With cash control on, the session lands in
     * `opening_control` until the float is confirmed; without it, straight to
     * `opened`.
     *
     * @param  list<array{denomination_value: string|float, quantity: int, pos_bill_id?: int|null}>  $denominations
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
            $existing = PosSession::query()
                ->where('pos_config_id', $config->getKey())
                ->where('is_rescue', false)
                ->where('state', '!=', SessionState::Closed->value)
                ->lockForUpdate()
                ->first();

            if ($existing !== null) {
                throw new DomainException('This register already has an open session.');
            }

            $expected = $this->lastClosingBalance($config);

            /** @var PosSession $session */
            $session = PosSession::query()->create([
                'uuid' => (string) Str::uuid(),
                'pos_config_id' => $config->getKey(),
                'company_id' => $config->company_id,
                'currency_id' => $config->currency_id,
                'name' => $this->nextName($config),
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

            if ($config->has_cash_control) {
                $this->recordMovement($session, CashMovementType::OpeningFloat, $openingFloat, 'Opening float', $employeeId, $userId, null);
            }

            return $session;
        });
    }

    /** Confirm the opening control and start trading. */
    public function confirmOpeningControl(PosSession $session, string $countedFloat, ?int $employeeId = null): PosSession
    {
        if ($session->state !== SessionState::OpeningControl) {
            throw new DomainException('This session is not awaiting an opening control.');
        }

        $session->forceFill([
            'state' => SessionState::Opened->value,
            'cash_balance_opening' => $countedFloat,
            'opened_by_employee_id' => $session->opened_by_employee_id ?? $employeeId,
        ])->save();

        return $session;
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

            return $movement;
        });
    }

    /** Delete a cash movement — manager-gated at the controller. */
    public function deleteCashMovement(CashMovement $movement): void
    {
        $session = $movement->pos_session_id === null
            ? null
            : PosSession::query()->find($movement->pos_session_id);

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
    ): PosSession {
        if ($session->state === SessionState::Closed) {
            throw new DomainException('This session is already closed.');
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

        return $session;
    }

    /** Expected drawer content = opening float + cash sales + cash in/out. */
    public function expectedCash(PosSession $session): string
    {
        $cashSales = (string) ($this->connection->table('pos_payments')
            ->join('payment_methods', 'payment_methods.id', '=', 'pos_payments.payment_method_id')
            ->where('pos_payments.pos_session_id', $session->getKey())
            ->whereNull('pos_payments.deleted_at')
            ->where('payment_methods.is_cash_count', true)
            ->sum('pos_payments.amount') ?? '0');

        $movements = (string) ($this->connection->table('cash_movements')
            ->where('pos_session_id', $session->getKey())
            ->whereNull('deleted_at')
            ->whereIn('movement_type', [CashMovementType::CashIn->value, CashMovementType::CashOut->value])
            ->sum('amount') ?? '0');

        return bcadd(bcadd((string) $session->cash_balance_opening, $cashSales, 4), $movements, 4);
    }

    public function draftOrderCount(PosSession $session): int
    {
        return $this->connection->table('pos_orders')
            ->where('pos_session_id', $session->getKey())
            ->where('state', OrderState::Draft->value)
            ->whereNull('deleted_at')
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

    private function lastClosingBalance(PosConfig $config): string
    {
        $last = PosSession::query()
            ->where('pos_config_id', $config->getKey())
            ->where('state', SessionState::Closed->value)
            ->orderByDesc('closed_at')
            ->first();

        return (string) ($last?->cash_balance_closing_counted ?? '0');
    }

    private function nextName(PosConfig $config): string
    {
        $count = PosSession::query()->where('pos_config_id', $config->getKey())->count() + 1;

        return sprintf('%s/%05d', preg_replace('/[^A-Za-z0-9]/', '', (string) $config->name) ?: 'POS', $count);
    }

    private function abs(string $value): string
    {
        return ltrim($value, '-');
    }
}
