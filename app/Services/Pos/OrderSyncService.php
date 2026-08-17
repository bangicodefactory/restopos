<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\AuditSeverity;
use App\Enums\CashMovementType;
use App\Enums\OrderSource;
use App\Enums\OrderState;
use App\Enums\PaymentMethodType;
use App\Enums\PaymentStatus;
use App\Enums\PriceType;
use App\Enums\SyncConflictType;
use App\Enums\SyncResolution;
use App\Events\Pos\OrderStateChanged;
use App\Events\Pos\OrderSynced;
use App\Exceptions\Pos\ChangeWithoutCashException;
use App\Models\Audit\AuditLog;
use App\Models\Identity\Customer;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Pos\Payment as OrderPayment;
use App\Models\Pos\PaymentMethod;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Models\Pos\PosPreset;
use App\Models\Pos\PosSession;
use App\Models\Restaurant\OrderCourse;
use App\Services\Audit\AuditRecorder;
use App\Services\Audit\OrderEditRecorder;
use App\Services\Kitchen\PreparationService;
use App\Support\Audit\AuditEvent;
use App\Support\Money\Decimal;
use App\Support\Pos\SettledOrder;
use App\Support\Tax\CashRounding;
use App\Support\Tax\Dto\OrderResult;
use DomainException;
use Illuminate\Contracts\Config\Repository as Config;
use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Str;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * `POST /api/pos/sync` — the ingest path (spec 03 §3.6). The single most
 * important class in the server.
 *
 * Guarantees, in the order they matter:
 *
 * 1. **Idempotent on `uuid`.** The unique index on `pos_orders.uuid` is the real
 *    guard; the `Idempotency-Key` header (recorded in `sync_requests`) only
 *    saves the work of re-doing an already-answered request.
 * 2. **Per-record results.** One poisoned order never blocks the queue behind
 *    it — each order is processed in its own transaction and a failure becomes a
 *    `rejected` result, not a 500.
 * 3. **create→update rewriting, both directions.** A `create` for a uuid we
 *    already hold is an update (retry); an `update` for a uuid we have never
 *    seen is a create (the outbox coalesced a create and an edit). Without the
 *    reverse rewrite that line silently disappears.
 * 4. **A closed session never loses a sale.** Orders are rerouted into the open
 *    session, or into a rescue session.
 * 5. **The server recomputes every monetary field.** The client's numbers are a
 *    proposal, echoed back as a `client_total_mismatch` warning when they
 *    disagree. They are never posted.
 */
final readonly class OrderSyncService
{
    public function __construct(
        private ConnectionInterface $connection,
        private OrderCalculator $calculator,
        private SequenceService $sequences,
        private SessionService $sessions,
        private PreparationService $preparation,
        private RefundService $refunds,
        private LinePriceAuthority $prices,
        private ApprovalAuthority $approvals,
        private OrderEditRecorder $edits,
        private AuditRecorder $audit,
        private Dispatcher $events,
        private LoggerInterface $logger,
        private Config $config,
        private CustomerAccountLedger $accounts,
    ) {}

    /**
     * @param  array{orders?: list<array<string, mixed>>, employee_id?: int|null, client_version?: string|null, client_time?: string|null}  $payload
     * @return array<string, mixed>
     */
    public function sync(PosConfig $config, ?PosDevice $device, array $payload, ?string $idempotencyKey = null): array
    {
        $started = microtime(true);
        $orders = array_values((array) ($payload['orders'] ?? []));
        $commands = array_map(static fn ($c): array => (array) $c, array_values((array) ($payload['commands'] ?? [])));
        $employeeId = (int) ($payload['employee_id'] ?? 0) ?: null;
        $uuids = array_values(array_filter(array_map(
            static fn (array $o): ?string => isset($o['uuid']) ? (string) $o['uuid'] : null,
            $orders,
        )));

        if ($idempotencyKey !== null) {
            $replay = $this->replay($idempotencyKey);

            if ($replay !== null) {
                return $replay;
            }
        }

        $requestUuid = $idempotencyKey ?? (string) Str::uuid();
        $requestId = $this->openRequestLog($config, $device, $requestUuid, $payload, $uuids);

        // Command ordering is load-bearing (BAN-404): `partner.create` must run *before* orders so a
        // just-created customer's real id is available to an order that still references its client
        // placeholder; everything else (cash moves, `prep.sent`) runs *after* orders, because
        // `prep.sent` targets an order that may be in this same batch.
        $partnerCommands = array_values(array_filter($commands, static fn (array $c): bool => ($c['kind'] ?? null) === 'partner.create'));
        $otherCommands = array_values(array_filter($commands, static fn (array $c): bool => ($c['kind'] ?? null) !== 'partner.create'));

        /** @var array<int, int> $customerIdMap client placeholder (negative) id => real customer id */
        $customerIdMap = [];
        $results = [];

        foreach ($partnerCommands as $command) {
            $results[] = $this->processCommand($config, $device, $command, $employeeId, $customerIdMap);
        }

        // Refunds go last, for the same reason `partner.create` goes first: a refund cannot be
        // validated until the order it refunds exists on the server, and both can be in one batch.
        // A till that sells offline and refunds the same order before either has synced pushes them
        // together; without this the refund arrives first as often as not, finds nothing to link to,
        // and is refused (BAN-406).
        $isRefund = static function (array $command): bool {
            foreach ((array) ($command['lines'] ?? []) as $line) {
                if (isset(((array) $line)['refunded_line_uuid'])) {
                    return true;
                }
            }

            return (bool) (((array) ($command['order'] ?? []))['is_refund'] ?? false);
        };

        $sales = array_values(array_filter($orders, static fn (array $c): bool => ! $isRefund($c)));
        $refunds = array_values(array_filter($orders, $isRefund));

        foreach ([...$sales, ...$refunds] as $command) {
            $results[] = $this->processOne($config, $device, $command, $employeeId, $customerIdMap);
        }

        foreach ($otherCommands as $command) {
            $results[] = $this->processCommand($config, $device, $command, $employeeId, $customerIdMap);
        }

        $response = [
            'server_time' => Carbon::now()->toIso8601ZuluString('microsecond'),
            'results' => $results,
        ];

        $this->closeRequestLog($requestId, $response, (int) round((microtime(true) - $started) * 1000));

        return $response;
    }

    // ------------------------------------------------------------ one order

    /**
     * @param  array<string, mixed>  $command
     * @param  array<int, int>  $customerIdMap  client placeholder (negative) id => real customer id
     * @return array<string, mixed>
     */
    private function processOne(PosConfig $config, ?PosDevice $device, array $command, ?int $employeeId, array $customerIdMap = []): array
    {
        $uuid = (string) ($command['uuid'] ?? '');

        if ($uuid === '') {
            return $this->rejected('', 'missing_uuid', 'Every order command must carry a uuid.');
        }

        // Resolve a client-local (negative) customer id to the real id created by a `partner.create`
        // command earlier in this batch. An unresolved placeholder is dropped to null rather than
        // left to violate the foreign key (REG-153).
        if (isset($command['order']) && is_array($command['order'])) {
            $command['order'] = $this->resolvePlaceholderCustomer($config, $command['order'], $customerIdMap);
            $command['order'] = $this->resolveOwnedPreset($config, $command['order']);
        }

        try {
            // Retried around the whole transaction: a tracking-number collision poisons the
            // transaction it happens in, so the attempt has to roll back and re-read (BAN-506).
            return $this->sequences->retryOnTrackingCollision(
                fn (): array => $this->connection->transaction(
                    fn (): array => $this->ingest($config, $device, $uuid, $command, $employeeId),
                ),
            );
        } catch (ChangeWithoutCashException $e) {
            $this->recordConflict($config, $device, SyncConflictType::PayloadMismatch, SyncResolution::Rejected, $uuid, [
                'message' => $e->getMessage(),
                'class' => $e::class,
            ]);

            return $this->rejected($uuid, 'change_without_cash', $e->getMessage());
        } catch (Throwable $e) {
            $this->logger->error('pos.sync.rejected', [
                'order' => $uuid,
                'config' => $config->getKey(),
                'message' => $e->getMessage(),
            ]);

            $this->recordConflict($config, $device, SyncConflictType::PayloadMismatch, SyncResolution::Rejected, $uuid, [
                'message' => $e->getMessage(),
                'class' => $e::class,
            ]);

            return $this->rejected($uuid, 'ingest_failed', $e->getMessage());
        }
    }

    /**
     * Resolve the order's customer, and refuse one that is not this company's.
     *
     * A client-local (negative) placeholder is remapped to the real id created by a `partner.create`
     * earlier in this batch, and an unresolved one is dropped to null rather than left to violate
     * the foreign key (REG-153).
     *
     * A **positive** id used to be trusted outright, which was a cross-tenant write: `customers` is
     * not globally scoped, `BelongsToCompany` is opt-in, and nothing downstream re-checked. A device
     * could name any customer id in the database and the order carried it. Once BAN-434 put a money
     * ledger behind `customer_id` that stopped being a mislabelled ticket and became one company
     * billing another company's regular.
     *
     * Dropped to null rather than rejecting the order, which is the same treatment an unresolved
     * placeholder gets: the sale is real and still has to sync. An on-account tender then fails the
     * `account_needs_customer` check rather than silently charging a stranger, so the money is
     * refused loudly instead of vanishing quietly. A legitimate client cannot reach this — the
     * replica it picks ids from is already company-scoped.
     *
     * @param  array<string, mixed>  $order
     * @param  array<int, int>  $customerIdMap
     * @return array<string, mixed>
     */
    /**
     * Drop a preset that is not this company's (BAN-485, review of #59).
     *
     * `customer_id` has been checked for ownership since REG-153; `pos_preset_id` never was, because
     * for a long time nothing read it back. BAN-485 changed that — the preset's **name** is now
     * denormalised onto `prep_orders.preset_label` and printed in the ticket header — so a crafted
     * `preset_id` puts another tenant's preset name on this venue's kitchen tickets. A probe against
     * this branch printed `RIVAL SECRET` on the pass.
     *
     * Dropped to null rather than rejected, matching how every other unusable id on an order command
     * is handled: refusing the order would lose a real sale over a field the kitchen only uses as a
     * label. Both the create and the update path run through here, which is the reason it lives at
     * this chokepoint rather than next to either one.
     *
     * @param  array<string, mixed>  $order
     * @return array<string, mixed>
     */
    private function resolveOwnedPreset(PosConfig $config, array $order): array
    {
        foreach (['preset_id', 'pos_preset_id'] as $key) {
            if (! isset($order[$key])) {
                continue;
            }

            $owned = PosPreset::query()
                ->whereKey((int) $order[$key])
                ->where('company_id', $config->company_id)
                ->exists();

            if (! $owned) {
                $order[$key] = null;
            }
        }

        return $order;
    }

    /**
     * @param  array<string, mixed>  $order
     * @param  array<int, int>  $customerIdMap
     * @return array<string, mixed>
     */
    private function resolvePlaceholderCustomer(PosConfig $config, array $order, array $customerIdMap): array
    {
        if (! isset($order['customer_id'])) {
            return $order;
        }

        $customerId = (int) $order['customer_id'];

        if ($customerId < 0) {
            $customerId = $customerIdMap[$customerId] ?? null;

            if ($customerId === null) {
                $order['customer_id'] = null;

                return $order;
            }
        }

        $owned = Customer::query()
            ->whereKey($customerId)
            ->where('company_id', $config->company_id)
            ->exists();

        $order['customer_id'] = $owned ? $customerId : null;

        return $order;
    }

    // ---------------------------------------------------------- generic commands

    /**
     * Non-order intents the outbox batches alongside orders (spec 03 §3.6): cash movements, offline
     * partner creation and offline kitchen sends. Each returns a per-record result keyed by the
     * command's own uuid, exactly like an order, so the client can retire the outbox entry.
     *
     * @param  array<string, mixed>  $command
     * @param  array<int, int>  $customerIdMap
     * @return array<string, mixed>
     */
    private function processCommand(PosConfig $config, ?PosDevice $device, array $command, ?int $employeeId, array &$customerIdMap): array
    {
        $uuid = (string) ($command['uuid'] ?? '');

        if ($uuid === '') {
            return $this->rejected('', 'missing_uuid', 'Every command must carry a uuid.');
        }

        $kind = (string) ($command['kind'] ?? '');
        $payload = (array) ($command['payload'] ?? []);

        try {
            return match ($kind) {
                'session.cash_move' => $this->connection->transaction(fn (): array => $this->applyCashMove($config, $device, $uuid, $payload, $employeeId)),
                // A full closure (not an arrow fn) so the placeholder→real id map propagates by
                // reference back to sync(); an arrow fn would capture a copy.
                'partner.create' => $this->connection->transaction(function () use ($config, $uuid, $payload, &$customerIdMap): array {
                    return $this->applyPartnerCreate($config, $uuid, $payload, $customerIdMap);
                }),
                'prep.sent' => $this->connection->transaction(fn (): array => $this->applyPrepSent($config, $uuid, $payload)),
                'audit.batch' => $this->connection->transaction(fn (): array => $this->applyAuditBatch($config, $device, $uuid, $payload, $employeeId)),
                default => $this->rejected($uuid, 'unsupported_command', "Unsupported command kind: {$kind}"),
            };
        } catch (Throwable $e) {
            $this->logger->error('pos.sync.command_rejected', [
                'command' => $uuid,
                'kind' => $kind,
                'config' => $config->getKey(),
                'message' => $e->getMessage(),
            ]);

            return $this->rejected($uuid, 'command_failed', $e->getMessage());
        }
    }

    /**
     * `session.cash_move` — a till cash in/out (REG-010). Idempotent on the movement uuid inside the
     * payload; the envelope uuid is what the client matches the result against.
     *
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    private function applyCashMove(PosConfig $config, ?PosDevice $device, string $uuid, array $payload, ?int $employeeId): array
    {
        $session = isset($payload['session_id'])
            ? PosSession::query()->where('pos_config_id', $config->getKey())->whereKey((int) $payload['session_id'])->first()
            : null;

        if ($session === null) {
            return $this->rejected($uuid, 'unknown_session', 'Cash movement references a session not on this register.');
        }

        $type = CashMovementType::tryFrom((string) ($payload['movement_type'] ?? ''));

        if ($type === null) {
            return $this->rejected($uuid, 'bad_movement_type', 'Unknown cash movement type.');
        }

        $this->sessions->cashMove(
            session: $session,
            type: $type,
            amount: (string) ($payload['amount'] ?? '0'),
            reason: isset($payload['reason']) ? (string) $payload['reason'] : null,
            employeeId: isset($payload['employee_id']) ? (int) $payload['employee_id'] : $employeeId,
            deviceId: $device?->getKey(),
            uuid: isset($payload['uuid']) ? (string) $payload['uuid'] : $uuid,
        );

        return ['uuid' => $uuid, 'status' => 'ok', 'server_rev' => null];
    }

    /**
     * The events a till is allowed to put on the trail, and what each one is worth.
     *
     * A whitelist, not a passthrough. The device bearer token lives on the till — the machine the
     * trail is partly evidence *about* — so a client that could write arbitrary `audit_logs.event`
     * strings could forge a `session.closed` or a `cash.move.deleted` into the record, and the one
     * artefact that is supposed to be trustworthy would be the one anyone with a paired device
     * could edit.
     */
    private const ClientAuditEvents = [
        'cash.drawer.opened' => AuditEvent::CashDrawerOpened,
    ];

    /**
     * `audit.batch` — events the till observed that the server has no other way to learn (BAN-413).
     *
     * The drawer is why this exists. It opens by an ESC/POS pulse sent straight from the browser to
     * the printer, so nothing about it reaches the server on its own: the one money-adjacent action
     * with no row of any kind to show for it, and "the drawer was opened at 23:40 with no sale
     * attached" is near the top of the list of things a manager wants to be able to ask.
     *
     * It rides the sync envelope rather than an endpoint of its own for the reason the outbox exists
     * at all — the interesting drawer opens are not the ones that happen while the network is up.
     *
     * Idempotency is **per event, not per batch**: the outbox coalesces and redelivers, so two
     * deliveries of one batch must not become two openings, and a batch that grew between attempts
     * must not lose its new events. Each event carries its own uuid, which becomes the row's, and
     * `audit_logs.uuid` is unique — the index is the real guard behind the check below.
     *
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    private function applyAuditBatch(PosConfig $config, ?PosDevice $device, string $uuid, array $payload, ?int $employeeId): array
    {
        $events = array_values((array) ($payload['events'] ?? []));
        $written = 0;
        $skipped = 0;

        foreach ($events as $entry) {
            $entry = (array) $entry;
            $eventUuid = (string) ($entry['uuid'] ?? '');
            $name = (string) ($entry['event'] ?? '');

            if ($eventUuid === '' || ! isset(self::ClientAuditEvents[$name])) {
                $skipped++;

                continue;
            }

            if (AuditLog::query()->where('uuid', $eventUuid)->exists()) {
                $skipped++;

                continue;
            }

            $session = isset($entry['session_id'])
                ? PosSession::query()->where('pos_config_id', $config->getKey())->whereKey((int) $entry['session_id'])->first()
                : null;

            // Bounded: `detail` is client-supplied and lands in a `json` column with no length of
            // its own, so an unbounded copy is a paired device's licence to fill the disk. Eight
            // scalar keys is far more than any event here carries.
            /** @var array<string, string|int|bool|null> $detail */
            $detail = array_slice(
                array_filter(
                    (array) ($entry['detail'] ?? []),
                    static fn (mixed $v): bool => is_scalar($v) || $v === null,
                ),
                0,
                8,
                preserve_keys: true,
            );
            $detail = array_map(
                static fn (mixed $v): mixed => is_string($v) ? mb_substr($v, 0, 120) : $v,
                $detail,
            );
            $reason = (string) ($detail['reason'] ?? '');

            $this->audit->record(
                event: self::ClientAuditEvents[$name],
                // Hung off the session when there is one, so a shift reads as a sequence; off the
                // register otherwise, because a drawer can be opened before a session exists.
                subject: $session ?? $config,
                companyId: (int) $config->company_id,
                // A no-sale is the one worth surfacing: a drawer opened with no order behind it.
                severity: $reason === 'no_sale' ? AuditSeverity::Warning : AuditSeverity::Info,
                message: trim("{$name} {$reason}"),
                changes: array_map(
                    static fn (mixed $value): array => ['old' => null, 'new' => $value],
                    array_filter([
                        ...$detail,
                        'order_uuid' => $entry['order_uuid'] ?? null,
                    ], static fn (mixed $v): bool => $v !== null),
                ),
                config: $config,
                session: $session,
                employeeId: isset($entry['employee_id']) ? (int) $entry['employee_id'] : $employeeId,
                device: $device,
                uuid: $eventUuid,
            );

            $written++;
        }

        return ['uuid' => $uuid, 'status' => 'ok', 'server_rev' => null, 'written' => $written, 'skipped' => $skipped];
    }

    /**
     * Put the manager overrides granted on this order onto the trail (REG-045, BAN-413).
     *
     * The client half of this shipped a long time ago: `approval.ts` verifies the PIN, writes an
     * `ApprovalRow` to Dexie and says in its own docblock that the approval "is recorded and
     * synced". It was recorded. `persistence.ts` sent `approvals: []` — a hardcoded empty array —
     * so it was never synced, and the record of who authorised a discount lived on the granting
     * till and nowhere else. Clearing that device's storage, or simply swapping the tablet, erased
     * the one fact the PIN exists to capture.
     *
     * `verified` is carried through rather than flattened: an override granted offline was checked
     * against a cached PIN hash, and a report that cannot tell those apart is one a determined
     * cashier can hide in.
     *
     * @param  array<int, array<string, mixed>>  $approvals
     */
    private function recordApprovals(PosConfig $config, PosSession $session, ?PosDevice $device, Order $order, array $approvals): void
    {
        foreach ($approvals as $approval) {
            $approval = (array) $approval;
            $approvalUuid = (string) ($approval['uuid'] ?? '');
            $ability = (string) ($approval['ability'] ?? '');

            if ($approvalUuid === '' || $ability === '') {
                continue;
            }

            // The same order is pushed many times over — on every edit and again at payment — and
            // carries its approvals each time. Without this the trail would count one override once
            // per push, which reads as a manager overriding the same discount forty times.
            if (AuditLog::query()->where('uuid', $approvalUuid)->exists()) {
                continue;
            }

            $verified = (string) ($approval['verified'] ?? 'offline');

            $this->audit->record(
                event: AuditEvent::EmployeeOverride,
                subject: $order,
                companyId: (int) $order->company_id,
                // An offline grant could not be checked against anything but a cached hash.
                severity: $verified === 'online' ? AuditSeverity::Notice : AuditSeverity::Warning,
                message: "Manager override for {$ability} ({$verified})",
                changes: [
                    'ability' => ['old' => null, 'new' => $ability],
                    'verified' => ['old' => null, 'new' => $verified],
                ],
                config: $config,
                session: $session,
                employeeId: isset($approval['manager_employee_id']) ? (int) $approval['manager_employee_id'] : null,
                device: $device,
                uuid: $approvalUuid,
            );
        }
    }

    /**
     * Put a manager override the device could not justify onto the trail (BAN-430).
     *
     * Severity `Warning` and attributed to the *pushing* employee, not to the manager named in the
     * claim — the whole point is that the named manager did not grant it, so hanging the row on
     * them would repeat the forgery in the audit log. `reason` distinguishes a stale client sending
     * a permission that no longer exists from a till naming somebody who cannot authorise it.
     *
     * @param  array<string, mixed>  $refusal
     */
    private function recordRefusedApproval(
        PosConfig $config,
        PosSession $session,
        ?PosDevice $device,
        Order $order,
        ?int $employeeId,
        array $refusal,
    ): void {
        $ability = (string) ($refusal['ability'] ?? '');
        $reason = (string) ($refusal['reason'] ?? '');

        $this->audit->record(
            event: AuditEvent::EmployeeOverrideRefused,
            subject: $order,
            companyId: (int) $order->company_id,
            severity: AuditSeverity::Warning,
            message: "Manager override for {$ability} refused ({$reason})",
            changes: [
                'ability' => ['old' => null, 'new' => $ability],
                'reason' => ['old' => null, 'new' => $reason],
                'claimed_approver' => ['old' => null, 'new' => $refusal['manager_employee_id'] ?? null],
            ],
            config: $config,
            session: $session,
            employeeId: $employeeId,
            device: $device,
        );
    }

    /**
     * `partner.create` — a customer created offline (REG-153). Idempotent on the partner uuid, and it
     * records the client's negative placeholder id → the real id so an order in this same batch can
     * be reconciled before it is written.
     *
     * @param  array<string, mixed>  $payload
     * @param  array<int, int>  $customerIdMap
     * @return array<string, mixed>
     */
    private function applyPartnerCreate(PosConfig $config, string $uuid, array $payload, array &$customerIdMap): array
    {
        $partnerUuid = (string) ($payload['uuid'] ?? '');

        if ($partnerUuid === '') {
            return $this->rejected($uuid, 'missing_partner_uuid', 'partner.create requires a uuid.');
        }

        if (trim((string) ($payload['name'] ?? '')) === '') {
            return $this->rejected($uuid, 'missing_partner_name', 'A customer needs a name.');
        }

        $writable = ['name', 'email', 'phone', 'mobile', 'vat', 'street', 'street2', 'city', 'zip', 'state_id', 'country_id', 'barcode', 'pricelist_id', 'fiscal_position_id', 'note'];

        /** @var Customer $customer */
        $customer = Customer::query()->updateOrCreate(
            ['uuid' => $partnerUuid],
            [...array_intersect_key($payload, array_flip($writable)), 'company_id' => $config->company_id, 'active' => true],
        );

        if (isset($payload['id']) && (int) $payload['id'] < 0) {
            $customerIdMap[(int) $payload['id']] = (int) $customer->getKey();
        }

        // Return the real id keyed by the partner uuid so the client can retire its negative
        // placeholder locally (the cross-batch half of REG-153; see follow-up).
        return ['uuid' => $uuid, 'status' => 'ok', 'server_rev' => null, 'partner' => ['id' => (int) $customer->getKey(), 'uuid' => $partnerUuid]];
    }

    /**
     * `prep.sent` — a kitchen send performed offline (KDS-062). The tickets already printed on the
     * device; the server just advances the prep snapshot to "everything sent".
     *
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    private function applyPrepSent(PosConfig $config, string $uuid, array $payload): array
    {
        $orderUuid = (string) ($payload['order_uuid'] ?? '');

        // Same visibility rule as the order path (BAN-492), not a narrower one. Scoping this to
        // `pos_config_id` alone meant a waiter who picked up a trusted peer's order on this till
        // could add to it but not fire it to the kitchen — the two paths disagreeing about whose
        // order this is. A non-writable order reports as unknown rather than as forbidden: whose
        // it really is stays none of the caller's business.
        $order = $orderUuid === ''
            ? null
            : Order::query()->where('uuid', $orderUuid)->first();

        if ($order !== null && ! $this->isWritableBy($config, $order)) {
            $order = null;
        }

        if ($order === null) {
            // Orders are ingested before this command runs, so one in the same batch is already
            // here; a genuinely missing order never synced. Quarantine (rejected) rather than spin
            // — the client surfaces it instead of retrying forever.
            return $this->rejected($uuid, 'unknown_order', 'prep.sent references an order not on this register.');
        }

        // Idempotent on retry: if the order was already marked sent and nothing new is unsent, do
        // not bump the snapshot again. The first send always marks (last_prep_sent_at is null then),
        // so a genuine re-fire that added items (unsent_change_count > 0) still advances.
        if ($order->last_prep_sent_at !== null && (int) $order->unsent_change_count === 0) {
            return ['uuid' => $uuid, 'status' => 'ok', 'server_rev' => null];
        }

        // A course fire carries its `course_index`; snapshot only that course so the others stay
        // fireable (issue #10). A whole-order send has no course_index and snapshots everything.
        $courseIndex = isset($payload['course_index']) && $payload['course_index'] !== null
            ? (int) $payload['course_index']
            : null;

        $version = $courseIndex !== null
            ? $this->preparation->markCourseSent($order, $courseIndex)
            : $this->preparation->markAllSent($order);

        return ['uuid' => $uuid, 'status' => 'ok', 'server_rev' => null, 'snapshot_version' => $version];
    }

    /**
     * @param  array<string, mixed>  $command
     * @return array<string, mixed>
     */
    private function ingest(PosConfig $config, ?PosDevice $device, string $uuid, array $command, ?int $employeeId): array
    {
        /** @var array<string, mixed> $attributes */
        $attributes = (array) ($command['order'] ?? []);
        $op = (string) ($command['op'] ?? 'upsert');
        $warnings = [];

        // 1 — session resolution. A closed session is rerouted, never rejected.
        // The register sends `pos_session_id` (the column name it stores locally); accept the
        // legacy `session_id` too so older outbox payloads keep resolving.
        $requestedSessionId = match (true) {
            isset($attributes['pos_session_id']) => (int) $attributes['pos_session_id'],
            isset($attributes['session_id']) => (int) $attributes['session_id'],
            default => null,
        };

        $resolution = $this->sessions->resolveForIngest($config, $requestedSessionId, $uuid);
        $session = $resolution['session'];

        if ($resolution['rerouted']) {
            $warnings[] = [
                'code' => $resolution['rescued'] ? 'session_rescued' : 'session_rerouted',
                'requested_session_id' => $requestedSessionId,
                'session_id' => (int) $session->getKey(),
            ];

            $this->recordConflict($config, $device, SyncConflictType::ClosedSession, SyncResolution::Rerouted, $uuid, [
                'requested_session_id' => $requestedSessionId,
                'session_id' => (int) $session->getKey(),
                'is_rescue' => (bool) $session->is_rescue,
            ]);
        }

        // 2 — locate or create, under a row lock. The unique index on `uuid`
        //     is what actually makes this idempotent.
        /** @var Order|null $order */
        $order = Order::query()->where('uuid', $uuid)->lockForUpdate()->first();

        // …and check the caller may write to what it found (BAN-492, spec §0.5). Without this, any
        // paired device could mutate any draft order in the database — in any venue, any tenant —
        // by pushing a uuid it had merely observed: add lines, attach payments, move the table,
        // cancel it. The read paths already scope; this one did not.
        //
        // Looked up globally and *then* authorised, rather than scoping the query: a scoped lookup
        // returns null for someone else's order, which falls through to the create branch and dies
        // on the unique index — an `ingest_failed` that says nothing. The caller gets a defined
        // answer instead, and the attempt is recorded.
        if ($order !== null && ! $this->isWritableBy($config, $order)) {
            $this->recordConflict($config, $device, SyncConflictType::UuidCollision, SyncResolution::Rejected, $uuid, [
                'order_config' => (int) $order->pos_config_id,
                'device_config' => (int) $config->getKey(),
            ]);

            return $this->rejected($uuid, 'order_not_writable', 'That order belongs to another register.');
        }

        $isNew = $order === null;
        $previousState = $order === null ? null : $this->stateValue($order->state);

        if ($order === null) {
            $order = $this->createOrder($config, $device, $session, $uuid, $attributes, $employeeId);
        } else {
            // 3 — supersession: the server already settled this order, so a
            //     stale draft push from a second device must not undo it.
            $incomingState = (string) ($attributes['state'] ?? OrderState::Draft->value);

            if (in_array($previousState, [OrderState::Paid->value, OrderState::Done->value], true)
                && $incomingState === OrderState::Draft->value
            ) {
                $this->recordConflict($config, $device, SyncConflictType::StaleWrite, SyncResolution::ServerWins, $uuid, [
                    'server_state' => $previousState,
                    'client_state' => $incomingState,
                ]);

                return [
                    'uuid' => $uuid,
                    'status' => 'superseded',
                    'server_rev' => $this->rev($order),
                    'order' => $this->orderSummary($order),
                    'warnings' => [['code' => 'already_settled', 'server_state' => $previousState]],
                ];
            }

            // 3b — and no other move off a settled state either. Narrowing the writable field list
            //      did nothing for `state`, which `updateOrder` sets outside it: a push claiming
            //      `cancelled` wrote straight through and took a paid order out of every report
            //      while the money stayed in the drawer (BAN-410). Voiding a settled sale is a
            //      refund — a new order — not a state change on this one.
            if (SettledOrder::isSettled($previousState)
                && ! SettledOrder::allowsTransition($previousState, $incomingState)
            ) {
                return $this->refuseSettledWrite($config, $order, $device, $employeeId, 'order', 'state', $uuid, [
                    'from' => $previousState,
                    'to' => $incomingState,
                ]);
            }

            $this->updateOrder($order, $session, $attributes, $employeeId);
        }

        if ($op === 'delete_draft') {
            return $this->deleteDraft($config, $device, $order, $uuid);
        }

        // 4 — child commands, with create↔update rewriting.
        // **Before** this push, not after. `createOrder` and `updateOrder` have already run, so by
        // now an order being paid *by this very command* reads as settled — and its own lines and
        // payments, which arrive in the same command, would be refused as post-settlement edits.
        // That is the whole normal payment flow. The question is only ever "was it already settled
        // when this arrived", and for a brand-new order the answer is no (BAN-410).
        $wasSettled = $previousState !== null && SettledOrder::isSettled($previousState);

        $lineCommands = (array) ($command['lines'] ?? []);

        // Spec 01 §1807 — a refund references exactly one original order. Checked across the batch
        // rather than line by line, because the violation only exists when the lines are seen
        // together: each one on its own is a perfectly ordinary refund. A mixed refund would post
        // credits against an order the customer never bought from.
        $refundPlan = $this->refundPreflight($config, $order, $device, $employeeId, $uuid, $lineCommands);

        if ($refundPlan['rejection'] !== null) {
            return $refundPlan['rejection'];
        }

        // What a manager actually authorised on this push, checked rather than believed (REG-045,
        // BAN-430). Decided before the price plan because the plan is one of the things an approval
        // unlocks: an over-limit discount stands or falls on whether a real manager granted it.
        $grant = $this->approvals->validate($config, (array) ($command['approvals'] ?? []), $order);

        // Who prices each line (XCT-107) — decided once for the whole push, next to the refund
        // preflight it mirrors, because a combo cannot be priced one row at a time.
        $pricePlan = $this->prices->plan($config, $order, $lineCommands, $employeeId, $refundPlan['links'], $grant);

        $lineResults = $this->applyLineCommands($config, $order, $lineCommands, $employeeId, $device, $wasSettled, $refundPlan['links'], $pricePlan);

        // Re-read after the write, not only before it. The preflight decides on a snapshot taken
        // under a row lock, which is the right mechanism and holds on Postgres and MySQL — but it
        // leaves a gap the moment refund lines reach the table by any route that did not go through
        // it, and a forced race proved the gap is reachable. This is the invariant itself rather
        // than a check that leads to it: after everything is written, no line may have been given
        // back more than it sold. Throwing here rolls the whole order back, because a refund that
        // half-applied is worse than one that did not apply at all.
        // Derived once for the whole push rather than per line as each one lands.
        $this->refunds->refreshMany(array_values($refundPlan['links']));

        $breach = $this->refunds->firstOverRefunded(array_values($refundPlan['links']));

        if ($breach !== null) {
            throw new DomainException("Refund would exceed the quantity sold on line {$breach}.");
        }
        $courseResults = $this->applyCourseCommands($config, $order, (array) ($command['courses'] ?? []), $employeeId, $device, $wasSettled);
        $paymentResults = $this->applyPaymentCommands($config, $order, $session, $device, (array) ($command['payments'] ?? []), $employeeId, $wasSettled);

        if ($op === 'cancel' && $previousState !== null && SettledOrder::isSettled($previousState)) {
            return $this->refuseSettledWrite($config, $order, $device, $employeeId, 'order', 'cancel', $uuid, [
                'from' => $previousState,
            ]);
        }

        if ($op === 'cancel') {
            $order->forceFill([
                'state' => OrderState::Cancelled->value,
                'cancelled_at' => now(),
                'cancel_reason' => (string) ($attributes['cancel_reason'] ?? 'Cancelled on device'),
            ])->save();

            // Recorded on both trails, and on purpose. The edit log is where a manager reads a
            // shift; `audit_logs` is where an auditor reads a company, and it is not gated on
            // `order_edit_tracking` — a venue that turns edit tracking off still has cancelled
            // tickets recorded, because a cancel after the food left the pass is not an edit.
            $this->edits->orderCancelled($config, $order, $employeeId, $device);

            $this->audit->record(
                event: AuditEvent::OrderCancelled,
                subject: $order,
                severity: AuditSeverity::Notice,
                message: (string) ($attributes['cancel_reason'] ?? 'Cancelled on device'),
                changes: ['state' => ['old' => $previousState, 'new' => OrderState::Cancelled->value]],
                config: $config,
                session: $session,
                employeeId: $employeeId,
                device: $device,
            );

            // A cancelled refund no longer counts against the cap, so every original it credited
            // has to be re-derived. Missed at first, and the effect is worse than it sounds: the cap
            // recomputes correctly, but the column the ticket screen reads stays stale, so the
            // cashier is shown 0 refundable on money the guard would happily give back.
            $this->refunds->refreshOriginalsCreditedBy((int) $order->getKey());

            $this->withdrawFromKitchen($config, $device, $order);
        }

        $this->recordApprovals($config, $session, $device, $order, $grant->accepted());

        // An override the device claimed and could not justify. Reported and recorded rather than
        // dropped: a till asking for a permission its manager does not have is the single most
        // interesting thing this mechanism can see.
        foreach ($grant->refusals() as $refusal) {
            $warnings[] = $refusal;

            $this->recordRefusedApproval($config, $session, $device, $order, $employeeId, $refusal);

            $this->recordConflict($config, $device, SyncConflictType::PayloadMismatch, SyncResolution::ServerWins, $uuid, $refusal);
        }

        // 5 — recompute every monetary field. This is the authoritative pass.
        $computed = $this->recompute($config, $order);

        // A manual price the pushing employee was not entitled to set. Reported rather than
        // honoured, and rather than refused: the sale goes through at the catalogue price, so the
        // money is right and the attempt is on the record (XCT-107).
        foreach ($pricePlan->refusals() as $warning) {
            $warnings[] = $warning;

            $this->recordConflict($config, $device, SyncConflictType::PayloadMismatch, SyncResolution::ServerWins, $uuid, $warning);
        }

        foreach ($this->mismatchWarnings($attributes, $order) as $warning) {
            $warnings[] = $warning;

            $this->recordConflict($config, $device, SyncConflictType::PayloadMismatch, SyncResolution::ServerWins, $uuid, $warning);
        }

        // 5b — the money the repricing above left uncollected on a sale that is already over.
        $writeOff = $this->absorbStalePriceShortfall($config, $order, $pricePlan, $session, $device, $employeeId);

        if ($writeOff !== null) {
            $warnings[] = $writeOff;

            $this->recordConflict($config, $device, SyncConflictType::PayloadMismatch, SyncResolution::ServerWins, $uuid, $writeOff);
        }

        // 6 — sequence + name, gapless per session, assigned once.
        if ($order->sequence_number === null && $this->stateValue($order->state) !== OrderState::Draft->value) {
            $sequence = $this->sequences->nextSessionSequence($session);
            $order->forceFill([
                'sequence_number' => $sequence,
                'name' => $this->sequences->orderName($config, $sequence),
            ]);
        }

        $order->forceFill(['synced_at' => now()])->save();

        // 7 — the customer's tab (REG-208). After the state is final, not inside the payment loop:
        // the register may push payments in one batch and the state change that settles the order
        // in the next, and a hook on the payment command would never fire for the second. Idempotent
        // on `pos_payment_id`, which matters because this is the retry path.
        $this->accounts->syncOrder($order);

        $this->broadcast($config, $device, $order, $previousState, $isNew);

        return [
            'uuid' => $uuid,
            'status' => 'ok',
            'server_rev' => $this->rev($order),
            'order' => $this->orderSummary($order),
            'lines' => $lineResults,
            'payments' => $paymentResults,
            'courses' => $courseResults,
            'warnings' => $warnings,
            'totals' => $computed->totals->toArray(),
        ];
    }

    // ------------------------------------------------------------ order rows

    /**
     * @param  array<string, mixed>  $attributes
     */
    private function createOrder(
        PosConfig $config,
        ?PosDevice $device,
        PosSession $session,
        string $uuid,
        array $attributes,
        ?int $employeeId,
    ): Order {
        $reference = (string) ($attributes['reference'] ?? $attributes['receipt_number'] ?? '');

        if ($reference !== '') {
            $reference = $this->sequences->deduplicateReference($config, $reference);
        }

        /** @var Order $order */
        $order = Order::query()->create([
            'uuid' => $uuid,
            'pos_session_id' => $session->getKey(),
            'pos_config_id' => $config->getKey(),
            'company_id' => $config->company_id,
            'pos_device_id' => $device?->getKey(),
            'currency_id' => $config->currency_id,
            'receipt_number' => $reference !== '' ? $reference : null,
            // The client's number is a preference, not a fact: it comes from that till's own local
            // counter, minted offline. A till paired into a session that already holds `001`
            // proposes `001`, and since BAN-470 added the unique index that rejected the order and
            // lost the sale — on the second till's very first order (BAN-506).
            'tracking_number' => $this->sequences->availableTrackingNumber(
                $session,
                $attributes['tracking_number'] ?? null,
            ),
            'ticket_code' => $attributes['ticket_code'] ?? $this->sequences->receiptToken(),
            // Server-minted, never the client's (BAN-496). This token is the whole authority over an
            // order for an anonymous caller — it names the public broadcast channel
            // `pos.order.{token}` and is the credential the status and payment endpoints check — so
            // a client that could choose it could pre-register a token, or set a victim's. The ack
            // carries the real one back; `updateOrder`'s allow-list keeps it unwritable thereafter.
            'access_token' => (string) Str::uuid(),
            'source' => (string) ($attributes['source'] ?? OrderSource::Pos->value),
            'state' => (string) ($attributes['state'] ?? OrderState::Draft->value),
            'ordered_at' => $attributes['ordered_at'] ?? now(),
            'client_created_at' => $attributes['client_created_at'] ?? null,
            'customer_id' => $attributes['customer_id'] ?? null,
            'employee_id' => $attributes['employee_id'] ?? $employeeId,
            'pricelist_id' => $attributes['pricelist_id'] ?? $config->pricelist_id,
            'fiscal_position_id' => $attributes['fiscal_position_id'] ?? $config->default_fiscal_position_id,
            'pos_preset_id' => $attributes['preset_id'] ?? $attributes['pos_preset_id'] ?? null,
            'preset_time' => $attributes['preset_time'] ?? null,
            'restaurant_table_id' => $attributes['table_id'] ?? $attributes['restaurant_table_id'] ?? null,
            'guest_count' => (int) ($attributes['guest_count'] ?? 0),
            'floating_order_name' => $attributes['floating_order_name'] ?? null,
            'general_customer_note' => $attributes['general_customer_note'] ?? null,
            'internal_note' => $attributes['internal_note'] ?? null,
            'to_invoice' => (bool) ($attributes['to_invoice'] ?? false),
            'is_refund' => (bool) ($attributes['is_refund'] ?? false),
            'refunded_order_id' => $this->resolveRefundedOrderId($config, $attributes),
            'is_tipped' => (bool) ($attributes['is_tipped'] ?? false),
            'tip_amount' => $attributes['tip_amount'] ?? '0',
            'customer_email' => $attributes['customer_email'] ?? null,
            'customer_phone' => $attributes['customer_phone'] ?? null,
        ]);

        $this->applyStateTimestamps($order, (string) ($attributes['state'] ?? OrderState::Draft->value));

        return $order;
    }

    /**
     * Link a refund to the order it reverses. Offline-first, the client only knows the original by
     * its uuid (`refunded_order_uuid`); a fully synced client may already hold the id. Resolve the
     * uuid within the company so the `refunded_order_id` foreign key is set on ingest.
     *
     * Batch ordering: commands are ingested in array order and each is persisted before the next,
     * so an original that precedes its refund in the same push resolves here. The one gap is a
     * refund pushed *ahead* of a not-yet-synced original — it links to null (rare: the original is
     * settled and synced before it can be refunded).
     *
     * @param  array<string, mixed>  $attributes
     */
    private function resolveRefundedOrderId(PosConfig $config, array $attributes): ?int
    {
        if (isset($attributes['refunded_order_id'])) {
            return (int) $attributes['refunded_order_id'];
        }

        $uuid = $attributes['refunded_order_uuid'] ?? null;

        if (! is_string($uuid) || $uuid === '') {
            return null;
        }

        $id = Order::query()
            ->where('company_id', $config->company_id)
            ->where('uuid', $uuid)
            ->value('id');

        return $id === null ? null : (int) $id;
    }

    /** @param array<string, mixed> $attributes */
    private function updateOrder(Order $order, PosSession $session, array $attributes, ?int $employeeId): void
    {
        $writable = [
            'customer_id', 'employee_id', 'pricelist_id', 'fiscal_position_id', 'preset_time',
            'guest_count', 'floating_order_name', 'general_customer_note', 'internal_note',
            'to_invoice', 'customer_email', 'customer_phone',
            // A table transfer, a tip, and an explicit "no tip" (is_tipped=false, tip_amount=0)
            // must all survive an update; the client sends the column names directly.
            'restaurant_table_id', 'is_tipped', 'tip_amount',
            // How many times the receipt has been printed. Absent from this list entirely until
            // BAN-514, so it was dropped on every update — not just settled ones — and the column
            // the back office reads never left 0.
            'print_count',
        ];

        // `tracking_number` is deliberately NOT writable, for the same reason `access_token` is not
        // (BAN-496): the server assigns it, so letting a client write it back would undo that.
        //
        // Concretely — the bug this closes. A till proposes `001`, the server finds it taken and
        // assigns `002`, and the till syncs the same order again a moment later with its original
        // `001` still attached. The update wrote it straight through, colliding with whoever holds
        // `001`, and the order was rejected. Fixing only the create path left this open, and it is
        // the path a register uses most: every draft is pushed again when it is paid (BAN-506).

        // Once the order is settled the writable set narrows to what genuinely still happens after
        // payment: a tip, the invoice flag, and the contact details a receipt is sent to. Everything
        // else is *dropped rather than rejected* — a stale `restaurant_table_id` riding along on a
        // tip push must not cost the tip (BAN-410).
        $settled = SettledOrder::isSettled($this->stateValue($order->state));

        if ($settled) {
            $writable = array_values(array_intersect($writable, SettledOrder::WritableFields));
        }

        $update = ['pos_session_id' => $session->getKey()];

        foreach ($writable as $field) {
            if (array_key_exists($field, $attributes)) {
                $update[$field] = $attributes[$field];
            }
        }

        // A reprint count only ever goes up. The register re-sends the whole order on every push,
        // so a queued copy from before the reprint arrives *after* it routinely — and a plain write
        // would let that stale copy erase the reprint it does not know about. Taking the greater of
        // the two makes the column safe to trust and the write order-independent.
        if (isset($update['print_count'])) {
            $update['print_count'] = max((int) $order->print_count, (int) $update['print_count']);
        }

        if (! $settled) {
            foreach ([['table_id', 'restaurant_table_id'], ['preset_id', 'pos_preset_id']] as [$client, $column]) {
                if (array_key_exists($client, $attributes)) {
                    $update[$column] = $attributes[$client];
                }
            }
        }

        if (! $settled && $employeeId !== null && ! isset($update['employee_id'])) {
            $update['employee_id'] = $order->employee_id ?? $employeeId;
        }

        if (isset($attributes['state'])) {
            $update['state'] = (string) $attributes['state'];
        }

        $order->forceFill($update)->save();

        if (isset($attributes['state'])) {
            $this->applyStateTimestamps($order, (string) $attributes['state']);
        }
    }

    private function applyStateTimestamps(Order $order, string $state): void
    {
        $patch = match ($state) {
            OrderState::Paid->value => ['paid_at' => $order->paid_at ?? now()],
            OrderState::Done->value => ['paid_at' => $order->paid_at ?? now(), 'closed_at' => $order->closed_at ?? now()],
            OrderState::Cancelled->value => ['cancelled_at' => $order->cancelled_at ?? now()],
            default => [],
        };

        if ($patch !== []) {
            $order->forceFill($patch)->save();
        }
    }

    /**
     * Tell the kitchen to stop cooking an order that is no longer a sale (REG-295).
     *
     * Cancelling and deleting both used to touch `pos_orders` alone, so a fired order vanished from
     * the till while the pass kept the ticket and kept plating it. The failure is invisible from
     * the register — which is exactly why it survived this long.
     *
     * Failures are logged, not raised: the sale is already cancelled by the time this runs, and
     * throwing here would roll that back and hand the till a sync error for an order it has
     * correctly finished with. A kitchen ticket that outlives its order is a smaller problem than a
     * cancellation the till cannot complete.
     */
    private function withdrawFromKitchen(PosConfig $config, ?PosDevice $device, Order $order): void
    {
        try {
            $this->preparation->cancelAll($order, $config, $device?->getKey() === null ? null : (int) $device->getKey());
        } catch (Throwable $e) {
            $this->logger->warning('kitchen withdrawal failed', [
                'order_uuid' => (string) $order->uuid,
                'exception' => $e->getMessage(),
            ]);
        }
    }

    /** @return array<string, mixed> */
    private function deleteDraft(PosConfig $config, ?PosDevice $device, Order $order, string $uuid): array
    {
        if ($this->stateValue($order->state) !== OrderState::Draft->value) {
            return [
                'uuid' => $uuid,
                'status' => 'superseded',
                'server_rev' => $this->rev($order),
                'order' => $this->orderSummary($order),
                'warnings' => [['code' => 'not_a_draft']],
            ];
        }

        // Before the soft delete: `cancelAll` reads the order's snapshot and fans out to the
        // displays, and a deleted order is not something the kitchen path should have to reason
        // about. A draft can absolutely have been fired — that is what "send to kitchen, then the
        // table walks out" looks like (REG-295).
        $this->withdrawFromKitchen($config, $device, $order);

        $order->delete();

        $this->events->dispatch(new OrderStateChanged(
            configToken: (string) $config->access_token,
            orderUuid: $uuid,
            orderId: (int) $order->getKey(),
            fromState: OrderState::Draft->value,
            toState: 'deleted',
            orderAccessToken: (string) $order->access_token,
            trackingNumber: $order->tracking_number,
            emittedByDeviceUuid: $device?->uuid,
        ));

        return ['uuid' => $uuid, 'status' => 'ok', 'server_rev' => $this->rev($order), 'deleted' => true];
    }

    // ------------------------------------------------------------- children

    /**
     * ORM-command application with the double rewrite (spec §3.6.3).
     *
     * @param  array<int, array<string, mixed>>  $commands
     * @return list<array<string, mixed>>
     */
    private function applyLineCommands(
        PosConfig $config,
        Order $order,
        array $commands,
        ?int $employeeId = null,
        ?PosDevice $device = null,
        bool $settled = false,
        array $refundLinks = [],
        ?PricePlan $plan = null,
    ): array {
        // Not defaulted to an empty plan. An empty one means "the client's price stands for every
        // line", so a caller that forgot to build one would silently hand price authority back to
        // the till — the exact thing this parameter exists to take away (XCT-107).
        $plan ??= $this->prices->plan($config, $order, $commands, $employeeId, $refundLinks);
        /** @var array<string, int> $existing uuid => id */
        $existing = OrderLine::query()
            ->where('pos_order_id', $order->getKey())
            ->pluck('id', 'uuid')
            ->map(static fn (mixed $v): int => (int) $v)
            ->all();

        // A high-water mark, not a count (BAN-442). `count($existing) + 1` reused a number the
        // moment any line was deleted: delete the second of three, add one, and the new line is
        // number 3 beside the existing number 3. Nothing catches it — the index on
        // (`pos_order_id`, `line_number`) is not unique — so the duplicate reaches the receipt and
        // the kitchen ticket, where two different products claim the same line.
        //
        // Trashed rows count: a soft-deleted line still occupies its number, and reissuing it makes
        // the audit trail read as though the line had been edited rather than replaced.
        //
        // Allocated once per batch and incremented locally. The order row is locked for the whole
        // ingest, so nothing else can be numbering this order at the same time.
        $nextLineNumber = 1 + (int) OrderLine::withTrashed()
            ->where('pos_order_id', $order->getKey())
            ->max('line_number');

        $results = [];

        foreach ($commands as $command) {
            $uuid = (string) ($command['uuid'] ?? '');

            if ($uuid === '') {
                continue;
            }

            $op = (string) ($command['op'] ?? 'create');

            // A create for a uuid we already hold is an update (retry), and an
            // update for a uuid we have never seen is a create (coalesced
            // outbox entry). Both directions are load-bearing.
            if ($op === 'create' && isset($existing[$uuid])) {
                $op = 'update';
            } elseif ($op === 'update' && ! isset($existing[$uuid])) {
                $op = 'create';
            }

            if ($settled) {
                $verdict = $this->settledLineVerdict($config, $order, $op, $command, $existing[$uuid] ?? null);

                if ($verdict === SettledOrder::Reject) {
                    $results[] = $this->refuseSettledWrite($config, $order, $device, $employeeId, 'line', $op, $uuid, [
                        'qty' => $command['qty'] ?? $command['quantity'] ?? null,
                        'price_unit' => $command['price_unit'] ?? null,
                    ]);

                    continue;
                }

                if ($verdict === SettledOrder::Noop) {
                    // A resend, not an edit. Answered as applied so the outbox retires the entry —
                    // it *is* applied, there was simply nothing to do.
                    $results[] = ['uuid' => $uuid, 'id' => $existing[$uuid] ?? null, 'status' => 'ok', 'unchanged' => true];

                    continue;
                }
            }

            $results[] = match ($op) {
                'delete' => $this->deleteLine($config, $order, $existing[$uuid] ?? null, $uuid, $employeeId, $device),
                'update' => $this->updateLine($config, $order, $existing[$uuid], $command, $uuid, $employeeId, $device, $refundLinks[$uuid] ?? null, $plan),
                default => $this->createLine($config, $order, $command, $uuid, $existing, $employeeId, $device, $refundLinks[$uuid] ?? null, $plan, $nextLineNumber),
            };
        }

        return $results;
    }

    /**
     * May this line command touch an order that is already settled? (BAN-410)
     *
     * Three answers, and the middle one is the reason this is not a one-line check. `Noop` covers
     * the resend: the register pushes a settled order's whole graph again on every reprint, and
     * refusing those would tell a cashier a completed sale failed to sync. Only a command that
     * would actually move something is refused.
     *
     * @param  array<string, mixed>  $command
     */
    private function settledLineVerdict(PosConfig $config, Order $order, string $op, array $command, ?int $lineId): string
    {
        // Whether this register tips after payment at all. A counter that tips into the change cup
        // and a restaurant that adds it to the card slip are different venues, and only the second
        // needs a door in this guard.
        $tipsAllowed = SettledOrder::acceptsTipAfterPayment(
            (bool) $config->enable_tips,
            (bool) $config->tip_after_payment,
        );

        if ($op === 'delete') {
            if ($lineId === null) {
                return SettledOrder::Noop;   // already gone; the outbox is repeating itself
            }

            // A tip may be taken back off, which is the same gesture as applying one.
            return $tipsAllowed && $this->isTipLine($config, $lineId) ? SettledOrder::Allow : SettledOrder::Reject;
        }

        if ($op === 'create' || $lineId === null) {
            $variantId = (int) ($command['variant_id'] ?? $command['product_variant_id'] ?? 0);

            if (! $tipsAllowed || ! $this->isTipVariant($config, $variantId)) {
                return SettledOrder::Reject;
            }

            return $this->tipAdds($config, $order, $command, null) ? SettledOrder::Allow : SettledOrder::Reject;
        }

        if ($this->lineCommandChangesNothing($lineId, $command)) {
            return SettledOrder::Noop;
        }

        if (! $tipsAllowed || ! $this->isTipLine($config, $lineId)) {
            return SettledOrder::Reject;
        }

        return $this->tipAdds($config, $order, $command, $lineId) ? SettledOrder::Allow : SettledOrder::Reject;
    }

    /**
     * Is this variant the register's tip product?
     *
     * `tip_product_id` when the config names one, and only then falls back to `special_kind`. The
     * fallback alone let *any* product flagged as a tip in the catalogue be appended to a settled
     * order — a venue with several is a venue where the guard picks the wrong one.
     */
    private function isTipVariant(PosConfig $config, int $variantId): bool
    {
        $meta = $this->variantMeta($variantId);

        if ($meta === null) {
            return false;
        }

        if ($config->tip_product_id !== null) {
            return (int) $meta['product_id'] === (int) $config->tip_product_id;
        }

        return SettledOrder::isTipKind($meta['special_kind'] ?? null);
    }

    /**
     * Does this tip command leave the line worth something, rather than taking value away?
     *
     * The tip exemption is a hole without this. A device can send a tip line priced at −20.00 and
     * knock €20 off an order that is already paid, printed and reconciled — the very fraud the
     * guard around it exists to stop, walking in through the door held open for tipping.
     *
     * Fields the command omits fall back to what the line already holds, so a partial update cannot
     * dodge the check by simply not mentioning the value it is changing.
     *
     * @param  array<string, mixed>  $command
     */
    private function tipAdds(PosConfig $config, Order $order, array $command, ?int $lineId): bool
    {
        $line = $lineId === null ? null : OrderLine::query()->find($lineId);

        // `$stored` is whatever the driver hands back — SQLite returns a native int for a decimal
        // column where Postgres returns a string — so it is taken as mixed and cast here.
        $pick = static function (array $keys, mixed $stored, string $default) use ($command): string {
            foreach ($keys as $key) {
                if (array_key_exists($key, $command) && $command[$key] !== null) {
                    return (string) $command[$key];
                }
            }

            return $stored === null ? $default : (string) $stored;
        };

        $quantity = $pick(['qty', 'quantity'], $line?->getRawOriginal('quantity'), '1');
        $priceUnit = $pick(['price_unit'], $line?->getRawOriginal('price_unit'), '0');
        $discount = $pick(['discount', 'discount_percent'], $line?->getRawOriginal('discount_percent'), '0');

        if (! SettledOrder::tipIsAdditive($quantity, $priceUnit, $discount)) {
            return false;
        }

        $proposed = bcmul(
            $quantity,
            bcmul($priceUnit, bcsub('1', bcdiv($discount, '100', 8), 8), 6),
            4,
        );

        return SettledOrder::tipWithinCeiling(
            bcadd($proposed, $this->tipTotal($config, $order, $lineId), 4),
            $this->soldTotal($config, $order),
        );
    }

    /**
     * What this order's other tip lines already come to, excluding the one being written.
     *
     * Excluded so an edit is measured as a replacement rather than an addition — otherwise raising
     * a tip from €3 to €4 would be scored as €7 and refused for the wrong reason.
     */
    private function tipTotal(PosConfig $config, Order $order, ?int $excludingLineId): string
    {
        $total = '0';

        /** @var list<OrderLine> $lines */
        $lines = OrderLine::query()->where('pos_order_id', $order->getKey())->get()->all();

        foreach ($lines as $line) {
            if ((int) $line->getKey() === $excludingLineId || ! $this->isTipLine($config, (int) $line->getKey())) {
                continue;
            }

            $total = bcadd($total, (string) $line->price_subtotal_incl, 4);
        }

        return $total;
    }

    /** What was actually sold on this order — everything that is not a tip. */
    private function soldTotal(PosConfig $config, Order $order): string
    {
        $total = '0';

        /** @var list<OrderLine> $lines */
        $lines = OrderLine::query()->where('pos_order_id', $order->getKey())->get()->all();

        foreach ($lines as $line) {
            if ($this->isTipLine($config, (int) $line->getKey())) {
                continue;
            }

            $total = bcadd($total, (string) $line->price_subtotal_incl, 4);
        }

        return $total;
    }

    /**
     * Would applying this command leave the line exactly as it is?
     *
     * Compared field by field against what the column holds, numerically — the register sends `'2'`
     * where the `decimal:3` column reads back `'2.000'`, and a string comparison would call every
     * reprint an edit. The attribute selections are compared too, because `lineCommand` sends them
     * on every push and they are a real edit when they differ.
     *
     * @param  array<string, mixed>  $command
     */
    private function lineCommandChangesNothing(int $lineId, array $command): bool
    {
        /** @var OrderLine|null $line */
        $line = OrderLine::query()->find($lineId);

        if ($line === null) {
            return false;
        }

        $map = [
            'qty' => 'quantity', 'quantity' => 'quantity',
            'price_unit' => 'price_unit', 'price_extra' => 'price_extra',
            'discount' => 'discount_percent', 'discount_percent' => 'discount_percent',
            'customer_note' => 'customer_note', 'full_product_name' => 'full_product_name',
            'skip_preparation' => 'skip_preparation',
        ];

        $before = [];
        $after = [];

        foreach ($map as $from => $column) {
            if (! array_key_exists($from, $command)) {
                continue;
            }

            $before[$column] = $line->getRawOriginal($column);
            $after[$column] = $command[$from];
        }

        if (AuditRecorder::diff($before, $after) !== []) {
            return false;
        }

        if (array_key_exists('note', $command) || array_key_exists('internal_note', $command)) {
            $note = $this->normaliseNote($command['note'] ?? $command['internal_note']);

            if (json_encode($note) !== json_encode($this->normaliseNote($line->internal_note))) {
                return false;
            }
        }

        if (array_key_exists('attribute_line_value_ids', $command)) {
            $sent = array_values(array_unique(array_map('intval', (array) $command['attribute_line_value_ids'])));
            sort($sent);

            $held = $this->connection->table('pos_order_line_attribute_value')
                ->where('pos_order_line_id', $lineId)
                ->pluck('product_attribute_line_value_id')
                ->map(static fn (mixed $id): int => (int) $id)
                ->all();
            sort($held);

            if ($sent !== $held) {
                return false;
            }
        }

        return true;
    }

    private function isTipLine(PosConfig $config, int $lineId): bool
    {
        $row = $this->connection->table('pos_order_lines')
            ->join('products', 'products.id', '=', 'pos_order_lines.product_id')
            ->where('pos_order_lines.id', $lineId)
            ->select(['pos_order_lines.product_id', 'products.special_kind'])
            ->first();

        if ($row === null) {
            return false;
        }

        if ($config->tip_product_id !== null) {
            return (int) $row->product_id === (int) $config->tip_product_id;
        }

        return SettledOrder::isTipKind((string) $row->special_kind);
    }

    /**
     * Refuse a write to a settled order, and put the attempt on the record.
     *
     * The audit row is the point as much as the refusal is. A device that keeps trying to restate a
     * payment after the receipt printed is the signal; a rejection the client swallows silently is
     * not evidence of anything.
     *
     * @param  array<string, mixed>  $attempted
     * @return array<string, mixed>
     */
    private function refuseSettledWrite(
        PosConfig $config,
        Order $order,
        ?PosDevice $device,
        ?int $employeeId,
        string $kind,
        string $op,
        string $uuid,
        array $attempted = [],
    ): array {
        $this->recordConflict($config, $device, SyncConflictType::StaleWrite, SyncResolution::Rejected, $order->uuid, [
            'reason' => 'order_settled',
            'target' => $kind,
            'target_uuid' => $uuid,
            'op' => $op,
        ]);

        $this->audit->record(
            event: AuditEvent::SettledOrderWriteRejected,
            subject: $order,
            companyId: (int) $order->company_id,
            severity: AuditSeverity::Critical,
            message: "Refused a {$op} on a {$kind} of settled order {$order->name}",
            changes: array_map(
                static fn (mixed $value): array => ['old' => null, 'new' => $value],
                array_filter([...$attempted, 'target_uuid' => $uuid, 'op' => $op], static fn (mixed $v): bool => $v !== null),
            ),
            config: $config,
            session: $order->pos_session_id,
            employeeId: $employeeId,
            device: $device,
        );

        return [
            'uuid' => $uuid,
            'status' => 'rejected',
            'code' => 'order_settled',
            'message' => 'That order is already settled.',
        ];
    }

    /**
     * @param  array<string, mixed>  $command
     * @param  array<string, int>  $existing
     * @return array<string, mixed>
     */
    private function createLine(
        PosConfig $config,
        Order $order,
        array $command,
        string $uuid,
        array &$existing,
        ?int $employeeId,
        ?PosDevice $device,
        ?int $refundedLineId,
        PricePlan $plan,
        int &$nextLineNumber,
    ): array {
        $variantId = (int) ($command['variant_id'] ?? $command['product_variant_id'] ?? 0);
        $variant = $this->variantMeta($variantId);

        if ($variant === null) {
            return ['uuid' => $uuid, 'status' => 'rejected', 'code' => 'unknown_variant', 'variant_id' => $variantId];
        }

        $taxIds = $this->calculator->taxIdsForVariant($variantId, $variant['product_id']);

        /** @var OrderLine $line */
        $line = OrderLine::query()->create([
            'uuid' => $uuid,
            'pos_order_id' => $order->getKey(),
            'company_id' => $order->company_id,
            'line_number' => $nextLineNumber++,
            'product_variant_id' => $variantId,
            'product_id' => $variant['product_id'],
            'pos_category_id' => $variant['pos_category_id'],
            'full_product_name' => (string) ($command['full_product_name'] ?? $variant['display_name']),
            'uom_id' => $variant['uom_id'],
            'quantity' => (string) ($command['qty'] ?? $command['quantity'] ?? '1'),
            // The server's price where it has one; the client's only where it does not (XCT-107).
            'price_unit' => $plan->priceFor($uuid) ?? (string) ($command['price_unit'] ?? $variant['list_price']),
            'price_extra' => $plan->extraFor($uuid) ?? (string) ($command['price_extra'] ?? '0'),
            'price_type' => (string) ($command['price_type'] ?? PriceType::Original->value),
            'discount_percent' => $plan->discountFor($uuid)
                ?? (string) ($command['discount'] ?? $command['discount_percent'] ?? '0'),
            'discount_notice' => $command['discount_notice'] ?? null,
            'tax_signature' => $this->taxSignature($taxIds),
            'unit_cost' => (string) $variant['standard_price'],
            'customer_note' => $command['customer_note'] ?? null,
            'internal_note' => $this->normaliseNote($command['note'] ?? $command['internal_note'] ?? null),
            'combo_parent_line_id' => $this->lineIdFor($command['combo_parent_uuid'] ?? null, $existing, $order),
            'combo_id' => $command['combo_id'] ?? null,
            'combo_item_id' => $command['combo_item_id'] ?? null,
            'restaurant_course_id' => $this->courseIdFor($order, $command['course_uuid'] ?? null),
            // Resolved through the *original* order, not by bare uuid. This was silently null on
            // every refund ever taken: the helper it used returns null unless handed an order, and
            // it was called without one — so the link the cap counts against did not exist.
            'refunded_order_line_id' => $refundedLineId,
            'skip_preparation' => (bool) ($command['skip_preparation'] ?? false),
        ]);

        $existing[$uuid] = (int) $line->getKey();

        $this->syncLineAttributes((int) $line->getKey(), (int) $variant['product_id'], $command);

        if ($refundedLineId !== null) {
            $this->recordRefund($config, $order, $line, $device, $employeeId);
        }

        $this->edits->lineAdded($config, $order, $line, $employeeId, $device);

        return ['uuid' => $uuid, 'id' => (int) $line->getKey(), 'status' => 'ok'];
    }

    /**
     * Validate every refund line on this order **before any of it is written**, and return the
     * links the write pass will use.
     *
     * Order-level, not line-level, and that is the whole point. A per-line rejection is invisible:
     * the client reads `results[].status` for the *order*, applies the ack, marks it synced and
     * retires the outbox entry — so a refused refund line vanishes with the cashier told nothing
     * and the order recorded as fully accepted. Refusing the order instead quarantines the entry
     * and surfaces it to a manager. A refund that is visibly stuck beats one that is silently gone.
     *
     * The running tally is what makes two refund lines against the *same* original line in one push
     * add up rather than each being measured against the same starting point.
     *
     * @param  array<int, array<string, mixed>>  $lineCommands
     * @return array{rejection: array<string, mixed>|null, links: array<string, int>}
     */
    private function refundPreflight(
        PosConfig $config,
        Order $order,
        ?PosDevice $device,
        ?int $employeeId,
        string $uuid,
        array $lineCommands,
    ): array {
        $links = [];
        $claimed = [];   // original line id => quantity claimed so far in this push

        // Every fact this loop needs, fetched once for the whole push. The lock is taken here, over
        // all the originals at once — the serialisation is unchanged, only the number of statements.
        $context = $this->refunds->preflightContext($order, $lineCommands);

        // Spec 01 §1807 — a refund references exactly one original order. Only visible when the
        // lines are looked at together: each one alone is a perfectly ordinary refund.
        $originalOrders = $this->refunds->originalOrderIds($lineCommands);

        if (count($originalOrders) > 1) {
            return [
                'rejection' => $this->refuseRefund($config, $order, $device, $employeeId, $uuid, [
                    'code' => 'refund_spans_orders',
                    'message' => 'A refund may reference only one original order.',
                ], []),
                'links' => [],
            ];
        }

        foreach ($lineCommands as $command) {
            $command = (array) $command;
            $lineUuid = (string) ($command['uuid'] ?? '');
            $quantity = $command['qty'] ?? $command['quantity'] ?? null;

            if ($lineUuid === '' || ! $this->refunds->isRefundLine($quantity)) {
                continue;
            }

            // An update to a refund line already on the server keeps its own link.
            $existing = $context['existing'][$lineUuid] ?? null;

            $originalLineId = $existing?->refunded_order_line_id === null
                ? ($context['targets'][(string) ($command['refunded_line_uuid'] ?? '')] ?? null)
                : (int) $existing->refunded_order_line_id;

            if ($originalLineId === null) {
                // Required, not optional. Without the link the cap has nothing to count against, so
                // omitting the field would be a way to refund without limit.
                return [
                    'rejection' => $this->refuseRefund($config, $order, $device, $employeeId, $lineUuid, [
                        'code' => 'refund_unlinked',
                        'message' => 'A refund line must reference a line on the original order.',
                    ], $command),
                    'links' => [],
                ];
            }

            if (! isset($context['sold'][$originalLineId])) {
                return [
                    'rejection' => $this->refuseRefund($config, $order, $device, $employeeId, $lineUuid, [
                        'code' => 'refund_unlinked',
                        'message' => 'The line being refunded no longer exists.',
                    ], $command),
                    'links' => [],
                ];
            }

            // What everyone has given back, less what this order itself already contributes, so an
            // edit is measured as a replacement rather than as an addition on top of itself.
            $alreadyRefunded = bcsub(
                $context['refunded'][$originalLineId] ?? '0',
                $context['ownContribution'][$originalLineId] ?? '0',
                6,
            );

            $remaining = bcsub($context['sold'][$originalLineId], $alreadyRefunded, 6);
            $remaining = bccomp($remaining, '0', 6) < 0 ? '0' : $remaining;
            $requested = bcmul((string) $quantity, '-1', 6);
            $claimed[$originalLineId] = bcadd($claimed[$originalLineId] ?? '0', $requested, 6);

            if (bccomp($claimed[$originalLineId], $remaining, 6) > 0) {
                return [
                    'rejection' => $this->refuseRefund($config, $order, $device, $employeeId, $lineUuid, [
                        'code' => 'refund_exceeds_sold',
                        'message' => "Only {$remaining} of that line remains refundable.",
                    ], $command),
                    'links' => [],
                ];
            }

            $links[$lineUuid] = $originalLineId;
        }

        return ['rejection' => null, 'links' => $links];
    }

    /**
     * Record a refused refund on the trail, and shape the order-level rejection.
     *
     * @param  array{code: string, message: string}  $verdict
     * @param  array<string, mixed>  $command
     * @return array<string, mixed>
     */
    private function refuseRefund(
        PosConfig $config,
        Order $order,
        ?PosDevice $device,
        ?int $employeeId,
        string $uuid,
        array $verdict,
        array $command,
    ): array {
        $this->recordConflict($config, $device, SyncConflictType::PayloadMismatch, SyncResolution::Rejected, $order->uuid, [
            'reason' => $verdict['code'],
            'line_uuid' => $uuid,
        ]);

        $this->audit->record(
            event: AuditEvent::RefundRefused,
            subject: $order,
            companyId: (int) $order->company_id,
            severity: AuditSeverity::Critical,
            message: $verdict['message'],
            changes: array_map(
                static fn (mixed $value): array => ['old' => null, 'new' => $value],
                array_filter([
                    'code' => $verdict['code'],
                    'line_uuid' => $uuid,
                    'refunded_line_uuid' => $command['refunded_line_uuid'] ?? null,
                    'quantity' => $command['qty'] ?? $command['quantity'] ?? null,
                ], static fn (mixed $v): bool => $v !== null),
            ),
            config: $config,
            session: $order->pos_session_id,
            employeeId: $employeeId,
            device: $device,
        );

        return $this->rejected((string) $order->uuid, $verdict['code'], $verdict['message']);
    }

    /** Record an accepted refund. Money leaving the drawer is worth a row of its own. */
    private function recordRefund(PosConfig $config, Order $order, OrderLine $line, ?PosDevice $device, ?int $employeeId): void
    {
        $this->audit->record(
            event: AuditEvent::RefundAccepted,
            subject: $order,
            companyId: (int) $order->company_id,
            severity: AuditSeverity::Notice,
            message: "Refunded {$line->quantity} × {$line->full_product_name}",
            changes: [
                'quantity' => ['old' => null, 'new' => (string) $line->quantity],
                'refunded_order_line_id' => ['old' => null, 'new' => (int) $line->refunded_order_line_id],
            ],
            config: $config,
            session: $order->pos_session_id,
            employeeId: $employeeId,
            device: $device,
        );
    }

    /**
     * @param  array<string, mixed>  $command
     * @return array<string, mixed>
     */
    private function updateLine(
        PosConfig $config,
        Order $order,
        int $id,
        array $command,
        string $uuid,
        ?int $employeeId,
        ?PosDevice $device,
        ?int $refundedLineId,
        PricePlan $plan,
    ): array {
        /** @var OrderLine|null $line */
        $line = OrderLine::query()->find($id);

        if ($line === null) {
            return ['uuid' => $uuid, 'status' => 'rejected', 'code' => 'line_vanished'];
        }

        // Snapshot before `forceFill`, or there is nothing left to compare against. Read through
        // `getRawOriginal` rather than the casts so the values are the strings the column holds —
        // the decimal cast formats to a fixed scale, and comparing a formatted value against the
        // client's raw one is how a resend starts looking like an edit.
        $before = [
            'quantity' => $line->getRawOriginal('quantity'),
            'price_unit' => $line->getRawOriginal('price_unit'),
            'price_extra' => $line->getRawOriginal('price_extra'),
            'discount_percent' => $line->getRawOriginal('discount_percent'),
            'customer_note' => $line->getRawOriginal('customer_note'),
        ];

        $map = [
            'qty' => 'quantity',
            'quantity' => 'quantity',
            'price_unit' => 'price_unit',
            'price_extra' => 'price_extra',
            'price_type' => 'price_type',
            'discount' => 'discount_percent',
            'discount_percent' => 'discount_percent',
            'customer_note' => 'customer_note',
            'full_product_name' => 'full_product_name',
            'skip_preparation' => 'skip_preparation',
        ];

        $update = [];

        foreach ($map as $from => $to) {
            if (array_key_exists($from, $command)) {
                $update[$to] = $command[$from];
            }
        }

        // Same authority as on create: where the server has a price of its own, it wins, whether the
        // client sent one or not. An update that quietly repriced a line would otherwise be the way
        // round the check on create (XCT-107).
        $serverPrice = $plan->priceFor($uuid);
        $serverExtra = $plan->extraFor($uuid);

        if ($serverPrice !== null) {
            $update['price_unit'] = $serverPrice;
        }

        if ($serverExtra !== null) {
            $update['price_extra'] = $serverExtra;
        }

        // Same on update as on create. Without this an unauthorised discount simply arrives as an
        // edit instead of a create, which is the route the register uses most (BAN-430).
        $serverDiscount = $plan->discountFor($uuid);

        if ($serverDiscount !== null) {
            $update['discount_percent'] = $serverDiscount;
        }

        // The link is server-owned: a client may edit a refund's quantity (the preflight has already
        // capped it) but never what it points at.
        if ($refundedLineId !== null && $line->refunded_order_line_id === null) {
            $update['refunded_order_line_id'] = $refundedLineId;
        }

        // `is_edited` used to be set on every update command, which meant every line on every order
        // — the register re-pushes a draft on each change and again at payment, so an untouched line
        // was flagged as edited within seconds of being rung up. The flag is what a back-office
        // "which orders were edited" view filters on (BOF-139); one that matches everything answers
        // nothing. Set it only when a tracked field actually moved.
        $changed = AuditRecorder::diff($before, array_intersect_key($update, $before));

        if ($changed !== []) {
            $update['is_edited'] = true;
        }

        if (array_key_exists('note', $command) || array_key_exists('internal_note', $command)) {
            $update['internal_note'] = $this->normaliseNote($command['note'] ?? $command['internal_note']);
        }

        if (array_key_exists('course_uuid', $command)) {
            $update['restaurant_course_id'] = $this->courseIdFor(
                Order::query()->find($line->pos_order_id),
                $command['course_uuid'],
            );
        }

        $line->forceFill($update)->save();

        if ($line->refunded_order_line_id !== null) {
            // A draft refund can be edited, so the cap has to hold here too — otherwise a device
            // creates a refund of one unit, has it accepted, and then edits it to ten.
            $this->refunds->refreshRefundedQuantity((int) $line->refunded_order_line_id);
        }

        // A resent line carries its options; re-sync them (replace-on-write) so an edit that
        // adds or clears an option is reflected. A note-only update omits the keys and no-ops.
        $this->syncLineAttributes((int) $line->getKey(), (int) $line->product_id, $command);

        if ($changed !== []) {
            $this->edits->lineChanged($config, $order, $line, $before, $update, $employeeId, $device);

            $order->forceFill(['is_edited' => true])->save();
        }

        return ['uuid' => $uuid, 'id' => (int) $line->getKey(), 'status' => 'ok'];
    }

    /**
     * Persist the variant options chosen on a line (REG-073): the `no_variant` attribute values
     * into the `pos_order_line_attribute_value` pivot (freezing each option's `price_extra`), and
     * any custom ("Happy Birthday") text into `pos_order_line_custom_attribute_values`. Both are
     * replace-on-write so a resent line is idempotent.
     *
     * Ids are validated against the *line's own product* — an option that belongs to another
     * product (or another tenant's catalogue) is dropped rather than persisted, which both keeps the
     * restrict-on-delete FK from 500-ing the batch and stops a crafted id leaking a foreign option
     * name onto this ticket.
     *
     * @param  array<string, mixed>  $command
     */
    private function syncLineAttributes(int $lineId, int $productId, array $command): void
    {
        if (array_key_exists('attribute_line_value_ids', $command)) {
            $ids = array_values(array_unique(array_map('intval', (array) $command['attribute_line_value_ids'])));

            /** @var Collection<int, string> $priceById */
            $priceById = $this->connection->table('product_attribute_line_values')
                ->where('product_id', $productId)
                ->whereIn('id', $ids === [] ? [0] : $ids)
                ->pluck('price_extra', 'id');

            $this->connection->table('pos_order_line_attribute_value')
                ->where('pos_order_line_id', $lineId)->delete();

            $rows = [];
            foreach ($ids as $id) {
                if (! $priceById->has($id)) {
                    continue;
                }
                $rows[] = [
                    'pos_order_line_id' => $lineId,
                    'product_attribute_line_value_id' => $id,
                    'price_extra' => (string) $priceById->get($id),
                ];
            }
            if ($rows !== []) {
                $this->connection->table('pos_order_line_attribute_value')->insert($rows);
            }
        }

        if (array_key_exists('custom_attribute_values', $command)) {
            $custom = (array) $command['custom_attribute_values'];

            $valueIds = array_values(array_unique(array_map(
                static fn ($c): int => (int) (((array) $c)['value_id'] ?? 0),
                $custom,
            )));
            $known = array_flip($this->connection->table('product_attribute_line_values')
                ->where('product_id', $productId)
                ->whereIn('id', $valueIds === [] ? [0] : $valueIds)->pluck('id')->all());

            $this->connection->table('pos_order_line_custom_attribute_values')
                ->where('pos_order_line_id', $lineId)->delete();

            $rows = [];
            foreach ($custom as $entry) {
                $entry = (array) $entry;
                $valueId = (int) ($entry['value_id'] ?? 0);
                $text = trim((string) ($entry['custom_value'] ?? ''));
                if ($text === '' || ! isset($known[$valueId])) {
                    continue;
                }
                $rows[] = [
                    'uuid' => (string) ($entry['uuid'] ?? Str::uuid()),
                    'pos_order_line_id' => $lineId,
                    'product_attribute_line_value_id' => $valueId,
                    'custom_value' => mb_substr($text, 0, 255),
                    'created_at' => now(),
                    'updated_at' => now(),
                ];
            }
            if ($rows !== []) {
                $this->connection->table('pos_order_line_custom_attribute_values')->insert($rows);
            }
        }
    }

    /** @return array<string, mixed> */
    private function deleteLine(
        PosConfig $config,
        Order $order,
        ?int $id,
        string $uuid,
        ?int $employeeId = null,
        ?PosDevice $device = null,
    ): array {
        if ($id === null) {
            return ['uuid' => $uuid, 'status' => 'ok', 'deleted' => true, 'code' => 'already_absent'];
        }

        // Loaded, not just deleted by key. What the line *was* is the whole content of the log row —
        // which product, how many, what it was worth — and a moment after the delete there is
        // nowhere left to read it from.
        /** @var OrderLine|null $line */
        $line = OrderLine::query()->find($id);

        if ($line !== null) {
            $this->edits->lineRemoved($config, $order, $line, $employeeId, $device);
        }

        // Read before the delete for the same reason.
        $creditedLineId = $line?->refunded_order_line_id === null ? null : (int) $line->refunded_order_line_id;

        OrderLine::query()->whereKey($id)->delete();

        if ($creditedLineId !== null) {
            // The refund is gone, so the quantity it held is refundable again — and the till has to
            // be told, or it shows 0 remaining and the cashier cannot attempt what the cap allows.
            $this->refunds->refreshRefundedQuantity($creditedLineId);
        }

        // `has_deleted_line` survives the line it describes; it is what a back-office list filters
        // on to find the orders worth opening (REG-123).
        $order->forceFill(['has_deleted_line' => true, 'is_edited' => true])->save();

        return ['uuid' => $uuid, 'id' => $id, 'status' => 'ok', 'deleted' => true];
    }

    /**
     * @param  array<int, array<string, mixed>>  $commands
     * @return list<array<string, mixed>>
     */
    private function applyCourseCommands(
        PosConfig $config,
        Order $order,
        array $commands,
        ?int $employeeId = null,
        ?PosDevice $device = null,
        bool $settled = false,
    ): array {
        /** @var array<string, int> $existing */
        $existing = OrderCourse::query()
            ->where('pos_order_id', $order->getKey())
            ->pluck('id', 'uuid')
            ->map(static fn (mixed $v): int => (int) $v)
            ->all();

        $results = [];

        foreach ($commands as $command) {
            $uuid = (string) ($command['uuid'] ?? '');

            if ($uuid === '') {
                continue;
            }

            // A course uuid that already belongs to another order is never this order's to write
            // (BAN-492) — see belongsToAnotherOrder.
            if (! isset($existing[$uuid]) && $this->belongsToAnotherOrder('restaurant_order_courses', $uuid, $order)) {
                $results[] = ['uuid' => $uuid, 'status' => 'rejected', 'code' => 'course_not_writable'];

                continue;
            }

            $op = (string) ($command['op'] ?? 'create');

            // Courses carry no money, which is exactly why they were the easy thing to leave out —
            // and why leaving them out is wrong. A course is what the kitchen ticket is grouped by;
            // rewriting one after the order is paid changes the record of what was sent and when,
            // for an order nobody should still be editing. The rule is the same as for lines: a
            // resend passes, a change does not.
            if ($settled) {
                $verdict = $this->settledCourseVerdict($op, $command, $existing[$uuid] ?? null);

                if ($verdict === SettledOrder::Reject) {
                    $results[] = $this->refuseSettledWrite($config, $order, $device, $employeeId, 'course', $op, $uuid, [
                        'name' => $command['name'] ?? null,
                    ]);

                    continue;
                }

                if ($verdict === SettledOrder::Noop) {
                    $results[] = ['uuid' => $uuid, 'id' => $existing[$uuid] ?? null, 'status' => 'ok', 'unchanged' => true];

                    continue;
                }
            }

            if ($op === 'delete') {
                if (isset($existing[$uuid])) {
                    OrderCourse::query()->whereKey($existing[$uuid])->delete();
                }
                $results[] = ['uuid' => $uuid, 'status' => 'ok', 'deleted' => true];

                continue;
            }

            $fired = (bool) ($command['fired'] ?? false);

            $attributes = [
                'pos_order_id' => $order->getKey(),
                'course_index' => (int) ($command['index'] ?? $command['course_index'] ?? 1),
                'name' => $command['name'] ?? null,
                'fired' => $fired,
            ];

            if ($fired) {
                $attributes['fired_at'] = $command['fired_at'] ?? now();
            }

            /** @var OrderCourse $course */
            $course = OrderCourse::query()->updateOrCreate(['uuid' => $uuid], $attributes);
            $existing[$uuid] = (int) $course->getKey();

            $results[] = ['uuid' => $uuid, 'id' => (int) $course->getKey(), 'status' => 'ok'];
        }

        return $results;
    }

    /**
     * Payments are the one place where "the client proposes" is not enough: the
     * accounting payment exists only when the server says so (spec §3.7).
     *
     * @param  array<int, array<string, mixed>>  $commands
     * @return list<array<string, mixed>>
     */
    private function applyPaymentCommands(
        PosConfig $config,
        Order $order,
        PosSession $session,
        ?PosDevice $device,
        array $commands,
        ?int $employeeId = null,
        bool $settled = false,
    ): array {
        /** @var array<string, int> $existing */
        $existing = OrderPayment::query()
            ->where('pos_order_id', $order->getKey())
            ->pluck('id', 'uuid')
            ->map(static fn (mixed $v): int => (int) $v)
            ->all();

        // Only when there is something to judge. Read once per order that actually carries payment
        // commands rather than once per order in the batch — a 50-order push of line edits should
        // not pay 50 times for a table with a handful of rows in it.
        $accountMethods = $commands === [] ? [] : $this->accountMethodIds();
        $results = [];

        foreach ($commands as $command) {
            $uuid = (string) ($command['uuid'] ?? '');

            if ($uuid === '') {
                continue;
            }

            // A payment uuid that already belongs to another order is never this order's to write
            // (BAN-492). This is the money one: without it, the row is re-parented here and its
            // amount overwritten, leaving a settled order elsewhere unpaid.
            if (! isset($existing[$uuid]) && $this->belongsToAnotherOrder('pos_payments', $uuid, $order)) {
                $results[] = ['uuid' => $uuid, 'status' => 'rejected', 'code' => 'payment_not_writable'];

                continue;
            }

            $op = (string) ($command['op'] ?? 'create');

            // No payment on a settled order moves. This is the one the fraud is actually built on:
            // ring up €40 cash, print the receipt, then quietly restate it as €30. The order still
            // balances and the session still reconciles against what was declared, so nothing else
            // in the system has any reason to notice (BAN-410).
            if ($settled) {
                $verdict = $this->settledPaymentVerdict($op, $command, $existing[$uuid] ?? null);

                if ($verdict === SettledOrder::Reject) {
                    $results[] = $this->refuseSettledWrite($config, $order, $device, $employeeId, 'payment', $op, $uuid, [
                        'amount' => $command['amount'] ?? null,
                    ]);

                    continue;
                }

                if ($verdict === SettledOrder::Noop) {
                    $results[] = ['uuid' => $uuid, 'id' => $existing[$uuid] ?? null, 'status' => 'ok', 'unchanged' => true];

                    continue;
                }
            }

            if ($op === 'delete') {
                if (isset($existing[$uuid])) {
                    /** @var OrderPayment|null $doomed */
                    $doomed = OrderPayment::query()->find($existing[$uuid]);

                    if ($doomed !== null) {
                        $this->recordPaymentChange($config, $order, $session, $device, $employeeId, $doomed, null);
                    }

                    OrderPayment::query()->whereKey($existing[$uuid])->delete();
                }
                $results[] = ['uuid' => $uuid, 'status' => 'ok', 'deleted' => true];

                continue;
            }

            // The register sends card details flat on the payment command; a richer integration may
            // send a nested `terminal` object. Accept both — nested wins on any overlapping key.
            $terminal = array_merge(
                array_filter([
                    'card_brand' => $command['card_brand'] ?? null,
                    'card_type' => $command['card_type'] ?? null,
                    'card_last4' => $command['card_last4'] ?? null,
                    'cardholder_name' => $command['cardholder_name'] ?? null,
                    'auth_code' => $command['auth_code'] ?? null,
                    'transaction_reference' => $command['transaction_reference'] ?? null,
                    'entry_mode' => $command['entry_mode'] ?? null,
                ], static fn ($v): bool => $v !== null),
                (array) ($command['terminal'] ?? []),
            );
            $amount = (string) ($command['amount'] ?? '0');

            // Change is a negative payment the server owns and re-derives (see reconcileChange). A
            // client that asserts `is_change` with a positive amount would inflate the drawer by the
            // change it claims to have given, so it is rejected rather than booked (REG-204).
            if ((bool) ($command['is_change'] ?? false) && bccomp($amount, '0', 4) > 0) {
                $results[] = ['uuid' => $uuid, 'status' => 'rejected', 'code' => 'change_wrong_sign'];

                continue;
            }

            // REG-208 — an on-account tender with nobody to bill is money that vanishes: the order
            // settles, no drawer took it, and no tab carries it. The register blocks this too, but
            // the server is the one that has to be right, and `customer_id` here is the order's, so
            // a client cannot smuggle one in on the payment alone.
            if ($order->customer_id === null && ($accountMethods[(int) ($command['payment_method_id'] ?? 0)] ?? false)) {
                $results[] = ['uuid' => $uuid, 'status' => 'rejected', 'code' => 'account_needs_customer'];

                continue;
            }

            /** @var OrderPayment|null $wasPaid */
            $wasPaid = isset($existing[$uuid]) ? OrderPayment::query()->find($existing[$uuid]) : null;

            /** @var OrderPayment $payment */
            $payment = OrderPayment::query()->updateOrCreate(['uuid' => $uuid], [
                'pos_order_id' => $order->getKey(),
                'pos_session_id' => $session->getKey(),
                'payment_method_id' => (int) ($command['payment_method_id'] ?? 0),
                'company_id' => $order->company_id,
                'currency_id' => $order->currency_id,
                'amount' => $amount,
                'amount_company_currency' => $amount,
                'is_change' => (bool) ($command['is_change'] ?? false),
                'is_refund' => (bool) ($command['is_refund'] ?? false),
                'label' => $command['label'] ?? null,
                'paid_at' => $command['paid_at'] ?? now(),
                'customer_id' => $order->customer_id,
                'employee_id' => $order->employee_id,
                'pos_device_id' => $device?->getKey(),
                'payment_status' => (string) ($command['payment_status'] ?? PaymentStatus::Done->value),
                'card_brand' => $terminal['card_brand'] ?? null,
                'card_type' => $terminal['card_type'] ?? null,
                'card_last4' => $terminal['card_last4'] ?? null,
                'cardholder_name' => $terminal['cardholder_name'] ?? null,
                'auth_code' => $terminal['auth_code'] ?? null,
                'transaction_reference' => $terminal['transaction_reference'] ?? null,
                'entry_mode' => $terminal['entry_mode'] ?? null,
                'terminal_payload' => $terminal === [] ? null : $terminal,
            ]);

            $existing[$uuid] = (int) $payment->getKey();

            $this->recordPaymentChange($config, $order, $session, $device, $employeeId, $wasPaid, $payment);

            $results[] = ['uuid' => $uuid, 'id' => (int) $payment->getKey(), 'status' => 'ok'];
        }

        return $results;
    }

    /**
     * Ids of every on-account method (REG-208).
     *
     * Read once per batch into a set rather than per command: the service is `readonly`, so there
     * is nowhere to memoise it, and the caller loops over payments.
     *
     * @return array<int, bool>
     */
    private function accountMethodIds(): array
    {
        return PaymentMethod::query()
            ->where('method_type', PaymentMethodType::CustomerAccount->value)
            ->pluck('id')
            ->mapWithKeys(static fn (mixed $id): array => [(int) $id => true])
            ->all();
    }

    /**
     * May this course command touch a settled order? (BAN-410)
     *
     * @param  array<string, mixed>  $command
     */
    private function settledCourseVerdict(string $op, array $command, ?int $courseId): string
    {
        if ($op === 'delete') {
            return $courseId === null ? SettledOrder::Noop : SettledOrder::Reject;
        }

        if ($courseId === null) {
            return SettledOrder::Reject;
        }

        $held = OrderCourse::query()->whereKey($courseId)->first();

        if ($held === null) {
            return SettledOrder::Reject;
        }

        $changes = AuditRecorder::diff(
            [
                'course_index' => $held->getRawOriginal('course_index'),
                'name' => $held->getRawOriginal('name'),
                'fired' => $held->getRawOriginal('fired'),
            ],
            array_filter([
                'course_index' => $command['index'] ?? $command['course_index'] ?? null,
                'name' => $command['name'] ?? null,
                'fired' => $command['fired'] ?? null,
            ], static fn (mixed $v): bool => $v !== null),
        );

        return $changes === [] ? SettledOrder::Noop : SettledOrder::Reject;
    }

    /**
     * May this payment command touch a settled order? (BAN-410)
     *
     * Nothing about a payment may move, so the only permitted answer is `Noop` — the resend of an
     * unchanged row that every reprint produces.
     *
     * @param  array<string, mixed>  $command
     */
    private function settledPaymentVerdict(string $op, array $command, ?int $paymentId): string
    {
        if ($op === 'delete') {
            return $paymentId === null ? SettledOrder::Noop : SettledOrder::Reject;
        }

        if ($paymentId === null) {
            return SettledOrder::Reject;   // a new tender after the fact
        }

        $held = OrderPayment::query()->whereKey($paymentId)->first();

        if ($held === null) {
            return SettledOrder::Reject;
        }

        $changes = AuditRecorder::diff(
            [
                'amount' => $held->getRawOriginal('amount'),
                'payment_method_id' => $held->getRawOriginal('payment_method_id'),
                'is_change' => $held->getRawOriginal('is_change'),
                'is_refund' => $held->getRawOriginal('is_refund'),
            ],
            array_filter([
                'amount' => $command['amount'] ?? null,
                'payment_method_id' => $command['payment_method_id'] ?? null,
                'is_change' => $command['is_change'] ?? null,
                'is_refund' => $command['is_refund'] ?? null,
            ], static fn (mixed $v): bool => $v !== null),
        );

        return $changes === [] ? SettledOrder::Noop : SettledOrder::Reject;
    }

    /**
     * Record a payment appearing, vanishing or changing amount — on both trails.
     *
     * Odoo calls this `_create_pm_change_log` and writes it to the chatter. It matters because a
     * payment edited after the receipt printed is the classic skim: ring up €40 cash, print, then
     * quietly restate it as €30 and pocket the difference. The order total still balances, the
     * session still reconciles against what was declared, and nothing else in the system notices.
     *
     * A no-op resend writes nothing — `paymentChanged` compares the amounts, and the `audit_logs`
     * row is only raised when this is an amount change on a payment that already existed. Creating
     * the first payment on a draft is just a sale.
     */
    private function recordPaymentChange(
        PosConfig $config,
        Order $order,
        PosSession $session,
        ?PosDevice $device,
        ?int $employeeId,
        ?OrderPayment $before,
        ?OrderPayment $after,
    ): void {
        $old = $before === null ? null : (string) $before->getRawOriginal('amount');
        $new = $after === null ? null : (string) $after->getRawOriginal('amount');

        if ($old !== null && $new !== null && bccomp($old, $new, 4) === 0) {
            return;
        }

        $this->edits->paymentChanged(
            $config,
            $order,
            $old,
            $new,
            $before?->label ?? $after?->label,
            $employeeId,
            $device,
        );

        if ($before === null) {
            return;
        }

        $this->audit->record(
            event: AuditEvent::OrderPaymentChanged,
            subject: $order,
            severity: AuditSeverity::Warning,
            message: $new === null ? 'Payment removed' : 'Payment amount changed',
            changes: ['amount' => ['old' => $old, 'new' => $new]],
            config: $config,
            session: $session,
            employeeId: $employeeId,
            device: $device,
        );
    }

    /**
     * Write off what a settled sale was short because the server repriced it (BAN-514).
     *
     * BAN-502 made the server the price authority: the client's `price_unit` is a proposal and the
     * catalogue decides. That is right, and it stays right. But a till running a stale catalogue
     * has already taken the customer's money at the price it displayed, and the customer has left.
     * Repricing then leaves the order permanently short — and `session_sales_summaries` freeze the
     * *server's* total while `session_payment_totals` freeze what was actually tendered, so the
     * difference surfaces at the end of the chain as an unexplained `imbalance_amount` on the
     * accounting export. The drawer still reconciles; the ledger does not.
     *
     * So the shortfall is recorded rather than left outstanding — bounded three ways.
     *
     * ## The bound has to be the server's own number
     *
     * The tempting cap is `amount_total − amount_total_client`: what the order is worth against
     * what the till thought it was worth. It is also a hole straight through BAN-502. That field is
     * an unvalidated assertion by the device, so a till that under-declares it has the server
     * forgive whatever it likes — with a correct catalogue and no repricing at all, a push of ten
     * items worth 121.00 declaring a total of 12.10 and tendering 12.10 settles in full, writes off
     * 108.90, and the accounting export *balances*. BAN-502 stopped the device dictating the price;
     * that would have let it dictate what it owed, which is the same money by another route.
     *
     * So the cap is {@see repricingDelta()}: the sum of what *this server* moved each line by,
     * grossed up at the line's own tax rate. The device cannot inflate it — it is zero exactly when
     * the server changed nothing, which is precisely the fraud case above.
     *
     * ## The other two bounds
     *
     * - **Cumulative, not per-push.** The allowance is the delta *less what has already been
     *   forgiven*. Without that, a second push re-measures the full gap and forgives against it
     *   again: a tip added after settlement, with the till re-sending its original total, had the
     *   whole tip written off on top of the genuine 2.42.
     * - **Only after settlement.** A draft still being built is repriced with nobody's money on the
     *   counter, and the next push simply charges the right amount.
     *
     * Idempotent by construction: the amount lands in `pos_orders.amount_write_off`, which
     * {@see recompute()} subtracts on every subsequent pass, so a re-push recomputes `amount_due`
     * to zero, finds no residual, and adds nothing.
     *
     * @return array<string, mixed>|null the warning to return to the device, if anything was written off
     */
    private function absorbStalePriceShortfall(
        PosConfig $config,
        Order $order,
        PricePlan $pricePlan,
        PosSession $session,
        ?PosDevice $device,
        ?int $employeeId,
    ): ?array {
        if (! SettledOrder::isSettled($this->stateValue($order->state))) {
            return null;
        }

        $due = (string) $order->amount_due;

        if (bccomp($due, '0', 4) <= 0) {
            return null;
        }

        $delta = $this->repricingDelta($order, $pricePlan);
        $alreadyForgiven = (string) $order->amount_write_off;
        $allowance = bcsub($delta, $alreadyForgiven, 4);

        if (bccomp($allowance, '0', 4) <= 0) {
            return null;
        }

        $writeOff = bccomp($due, $allowance, 4) <= 0 ? $due : $allowance;

        $order->forceFill([
            'amount_write_off' => bcadd($alreadyForgiven, $writeOff, 4),
            'amount_due' => bcsub($due, $writeOff, 4),
        ])->save();

        $this->audit->record(
            event: AuditEvent::StalePriceWrittenOff,
            subject: $order,
            severity: AuditSeverity::Warning,
            message: 'Settled order repriced above what was collected; shortfall written off',
            changes: [
                'amount_write_off' => ['old' => $alreadyForgiven, 'new' => bcadd($alreadyForgiven, $writeOff, 4)],
                'repricing_delta' => ['old' => null, 'new' => $delta],
            ],
            config: $config,
            session: $session,
            employeeId: $employeeId,
            device: $device,
        );

        return [
            'code' => 'stale_price_written_off',
            'amount' => $writeOff,
            'repricing_delta' => $delta,
            'server_total' => (string) $order->amount_total,
        ];
    }

    /**
     * How much the server's own repricing added to this order, tax included.
     *
     * Only lines this push actually priced count, and only upward: `proposedFor()` is populated
     * exactly where {@see LinePriceAuthority} overrode the client, so a line whose price the client
     * was entitled to set — an open-price product, a tip, a permitted manual override — contributes
     * nothing, which is what makes a tip added after settlement stay owed rather than forgiven.
     *
     * Grossed up per line rather than at order level: `price_subtotal_incl / price_subtotal` is that
     * line's own effective rate, so a zero-rated line and a 21% line are not averaged into each
     * other. A change of `d` in the unit price moves the subtotal by `d × qty × (1 − discount)`,
     * because that is how the subtotal is built.
     */
    private function repricingDelta(Order $order, PricePlan $pricePlan): string
    {
        $delta = '0';

        /** @var list<OrderLine> $lines */
        $lines = OrderLine::query()->where('pos_order_id', $order->getKey())->get()->all();

        foreach ($lines as $line) {
            $proposed = $pricePlan->proposedFor((string) $line->uuid);

            if ($proposed === null) {
                continue;
            }

            // Signed, deliberately: a line the server priced *down* offsets one it priced up, and
            // the net is what the customer's tender actually fell short by. Skipping the downward
            // ones over-forgives — on a push with one line +2.42 and another −1.21 the order is
            // only 1.21 adrift, and an unrelated under-tender on top would have had 2.42 forgiven
            // instead of 1.21. The sum is guarded once at the end, where a net-negative delta
            // forgives nothing at all.
            $perUnit = bcsub((string) $line->price_unit, $proposed, 4);

            $untaxed = bcmul(
                bcmul($perUnit, (string) $line->quantity, 6),
                bcsub('1', bcdiv((string) $line->discount_percent, '100', 8), 8),
                6,
            );

            // A fully discounted line moves the subtotal by nothing, so there is no rate to read
            // off it and nothing to add either.
            $ratio = bccomp((string) $line->price_subtotal, '0', 4) === 0
                ? '1'
                : bcdiv((string) $line->price_subtotal_incl, (string) $line->price_subtotal, 8);

            $delta = bcadd($delta, bcmul($untaxed, $ratio, 4), 4);
        }

        return $delta;
    }

    // ------------------------------------------------------------ recompute

    /**
     * Re-derive every monetary field from primary facts. Runs on every ingest,
     * for every order, unconditionally.
     */
    public function recompute(PosConfig $config, Order $order): OrderResult
    {
        /** @var list<OrderLine> $lines */
        $lines = OrderLine::query()->where('pos_order_id', $order->getKey())->orderBy('id')->get()->all();

        $input = [];

        foreach ($lines as $line) {
            $taxIds = $this->calculator->taxIdsForVariant((int) $line->product_variant_id, (int) $line->product_id);

            $input[] = [
                'id' => (string) $line->uuid,
                'quantity' => (string) $line->quantity,
                'price_unit' => bcadd((string) $line->price_unit, (string) $line->price_extra, 4),
                'discount' => (string) $line->discount_percent,
                'tax_ids' => $taxIds,
            ];
        }

        $result = $this->calculator->compute($config, $input, $order->fiscal_position_id === null ? null : (int) $order->fiscal_position_id);

        $byUuid = [];
        foreach ($result->lines as $lineResult) {
            $byUuid[$lineResult->id] = $lineResult;
        }

        $discountTotal = '0';
        $costTotal = '0';

        foreach ($lines as $line) {
            $computed = $byUuid[(string) $line->uuid] ?? null;

            if ($computed === null) {
                continue;
            }

            $gross = bcmul(bcadd((string) $line->price_unit, (string) $line->price_extra, 4), (string) $line->quantity, 4);
            $discountAmount = bcmul($gross, bcdiv((string) $line->discount_percent, '100', 8), 4);
            $totalCost = bcmul((string) $line->unit_cost, (string) $line->quantity, 4);

            $discountTotal = bcadd($discountTotal, $discountAmount, 4);
            $costTotal = bcadd($costTotal, $totalCost, 4);

            $line->forceFill([
                'price_subtotal' => $computed->priceSubtotal,
                'price_subtotal_incl' => $computed->priceTotal,
                'tax_details' => array_map(
                    static fn ($t): array => ['taxId' => $t->taxId, 'base' => $t->base, 'amount' => $t->amount],
                    $computed->taxes,
                ),
                'tax_signature' => $this->taxSignature(array_map(static fn ($t): int => $t->taxId, $computed->taxes)),
                'discount_amount' => $discountAmount,
                'total_cost' => $totalCost,
                'margin' => bcsub($computed->priceSubtotal, $totalCost, 4),
            ])->save();
        }

        $totals = $result->totals;

        // The change handed back is the server's to record, not the client's (REG-204). Derive it
        // from the tender against the rounded total and write a single negative cash `is_change`
        // row, so amount_change is real and the drawer is not overstated at close.
        $this->reconcileChange($config, $order, $totals->roundedTotal);

        $payments = $this->paymentTotals($order);
        $netPaid = bcsub($payments['paid'], $payments['change'], 4);

        // The register closes a cash-rounded order once the shortfall is inside the rounding
        // tolerance (REG-176). The books have to agree: absorb that shortfall into the rounding
        // write-off here, or the order the cashier settled shows a residual `amount_due` forever.
        ['due' => $amountDue, 'rounding' => $amountRounding] = $this->absorbRoundingShortfall(
            $config,
            $order,
            bcsub($totals->roundedTotal, $netPaid, 4),
            $totals->roundingDelta,
        );

        // A stale-price shortfall already written off is settled business, not an outstanding debt
        // (BAN-514). Subtracting the *persisted* column here rather than re-deciding is what makes
        // this idempotent: the ingest path below writes the write-off once, and every subsequent
        // recompute — a re-push, a tip, a back-office edit — reproduces `amount_due = 0` from it
        // without needing to know why. Clamped at zero so a later credit cannot drive the due
        // negative and read as an overpayment.
        $amountDue = bccomp($amountDue, (string) $order->amount_write_off, 4) <= 0
            ? '0.0000'
            : bcsub($amountDue, (string) $order->amount_write_off, 4);

        $order->forceFill([
            'amount_untaxed' => $totals->totalExcluded,
            'amount_tax' => $totals->totalTax,
            'amount_total' => $totals->roundedTotal,
            'amount_rounding' => $amountRounding,
            'amount_discount' => $discountTotal,
            'amount_paid' => $payments['paid'],
            'amount_change' => $payments['change'],
            'amount_due' => $amountDue,
            'total_cost' => $costTotal,
            'margin' => bcsub($totals->totalExcluded, $costTotal, 4),
            'margin_percent' => bccomp($totals->totalExcluded, '0', 4) === 0
                ? '0'
                : bcmul(bcdiv(bcsub($totals->totalExcluded, $costTotal, 6), $totals->totalExcluded, 6), '100', 4),
            'tax_details' => array_map(
                static fn ($g): array => ['taxGroupId' => $g->taxGroupId, 'base' => $g->base, 'amount' => $g->amount],
                $totals->taxGroups,
            ),
        ])->save();

        return $result;
    }

    /**
     * Write off a cash-rounding shortfall the register was entitled to accept (REG-176).
     *
     * The tolerance is a *cash* concession — it exists because the drawer cannot make change below
     * the smallest coin — so it is granted on the same three conditions the register uses:
     * rounding is configured, the order carries a live cash tender, and the shortfall does not
     * exceed {@see CashRounding::fullyPaidTolerance()}. A card-only order keeps its residual and
     * shows as underpaid, which is correct: a terminal can always be charged the exact amount.
     *
     * The absorbed amount joins the rounding delta rather than vanishing, so
     * `amount_rounding` stays the single answer to "how much did rounding cost us on this order?"
     * and the session totals still reconcile.
     *
     * @param  string  $rawDue  roundedTotal − netPaid, positive when short
     * @return array{due: string, rounding: string}
     */
    private function absorbRoundingShortfall(
        PosConfig $config,
        Order $order,
        string $rawDue,
        string $roundingDelta,
    ): array {
        $unchanged = ['due' => $rawDue, 'rounding' => $roundingDelta];

        if (bccomp($rawDue, '0', 4) <= 0) {
            return $unchanged;
        }

        $rounding = $this->calculator->cashRounding($config);

        if ($rounding === null) {
            return $unchanged;
        }

        $hasCashTender = OrderPayment::query()
            ->where('pos_order_id', $order->getKey())
            ->where('is_change', false)
            ->whereNotIn('payment_status', [PaymentStatus::Failed->value, PaymentStatus::Cancelled->value])
            ->cash()
            ->exists();

        if (! $hasCashTender) {
            return $unchanged;
        }

        if (! CashRounding::isFullyPaid(Decimal::of($rawDue), $rounding->rounding, $rounding->method)) {
            return $unchanged;
        }

        return [
            'due' => '0.0000',
            // The effective total became roundedTotal − rawDue, so the adjustment against the raw
            // total grows by exactly the shortfall we just forgave.
            'rounding' => bcsub($roundingDelta, $rawDue, 4),
        ];
    }

    /** @return array{paid: string, change: string} */
    private function paymentTotals(Order $order): array
    {
        $rows = $this->connection->table('pos_payments')
            ->where('pos_order_id', $order->getKey())
            ->whereNull('deleted_at')
            ->selectRaw('sum(case when is_change then 0 else amount end) as paid')
            ->selectRaw('sum(case when is_change then amount else 0 end) as change_amount')
            ->first();

        return [
            'paid' => bcadd((string) ($rows->paid ?? '0'), '0', 4),
            'change' => ltrim(bcadd((string) ($rows->change_amount ?? '0'), '0', 4), '-'),
        ];
    }

    /**
     * Record (or clear) the change handed back for an order (REG-204). Change is the overpayment —
     * tender beyond the rounded total — given back from the drawer, so it is booked as a single
     * **negative** payment on the config's cash method with `is_change = true`. It is fully
     * server-owned and re-derived on every ingest: existing change rows are replaced, so the write
     * is idempotent, and if the overpayment is edited away the row is removed.
     *
     * An overpayment with no cash method to give change from is a contract error, not a silent
     * booking: `ChangeWithoutCashException` becomes a `change_without_cash` rejection.
     */
    private function reconcileChange(PosConfig $config, Order $order, string $roundedTotal): void
    {
        $tendered = bcadd((string) ($this->connection->table('pos_payments')
            ->where('pos_order_id', $order->getKey())
            ->whereNull('deleted_at')
            ->where('is_change', false)
            ->sum('amount') ?? '0'), '0', 4);

        $changeDue = bcsub($tendered, $roundedTotal, 4);

        /** @var Collection<int, OrderPayment> $existing */
        $existing = OrderPayment::query()
            ->where('pos_order_id', $order->getKey())
            ->where('is_change', true)
            ->get();

        // Change is excess *positive cash tender* over the total. A refund has a negative total and
        // non-positive tender, so `changeDue` (= tender − total) would read positive there — guard on
        // the tender sign too, or a refund would book phantom change (BAN-440).
        if (bccomp($changeDue, '0', 4) <= 0 || bccomp($tendered, '0', 4) <= 0) {
            // No overpayment (or a refund / an order grown past its tender): no change to record.
            $existing->each(static fn (OrderPayment $p): ?bool => $p->forceDelete());

            return;
        }

        $cashMethod = $config->paymentMethods()->where('payment_methods.is_cash_count', true)->first();

        if ($cashMethod === null) {
            throw new ChangeWithoutCashException;
        }

        $amount = '-'.$changeDue;
        $attributes = [
            'pos_order_id' => $order->getKey(),
            'pos_session_id' => $order->pos_session_id,
            'payment_method_id' => (int) $cashMethod->getKey(),
            'company_id' => $order->company_id,
            'currency_id' => $order->currency_id,
            'amount' => $amount,
            'amount_company_currency' => $amount,
            'is_change' => true,
            'is_refund' => false,
            'label' => 'Change',
            'paid_at' => now(),
            'employee_id' => $order->employee_id,
            'payment_status' => PaymentStatus::Done->value,
        ];

        // Keep one row, update it in place, and drop any duplicates so a resync never stacks change.
        $keep = $existing->shift();
        $existing->each(static fn (OrderPayment $p): ?bool => $p->forceDelete());

        if ($keep === null) {
            OrderPayment::query()->create([...$attributes, 'uuid' => (string) Str::uuid()]);
        } else {
            $keep->forceFill($attributes)->save();
        }
    }

    /**
     * The client's totals are a proposal. A divergence is surfaced as a warning
     * and logged — never as a rejection, because a manual price override is a
     * legitimate reason for the two to differ (spec §3.7).
     *
     * @param  array<string, mixed>  $attributes
     * @return list<array<string, mixed>>
     */
    private function mismatchWarnings(array $attributes, Order $order): array
    {
        $tolerance = (string) $this->config->get('pos.sync.amount_mismatch_tolerance', '0.00');
        $warnings = [];

        $pairs = [
            'amount_total_client' => (string) $order->amount_total,
            'amount_tax_client' => (string) $order->amount_tax,
        ];

        foreach ($pairs as $key => $server) {
            if (! isset($attributes[$key])) {
                continue;
            }

            $client = (string) $attributes[$key];
            $delta = bcsub($client, $server, 4);

            if (bccomp(ltrim($delta, '-'), $tolerance, 4) > 0) {
                $warnings[] = [
                    'code' => 'client_total_mismatch',
                    'field' => str_replace('_client', '', $key),
                    'client' => $client,
                    'server' => $server,
                    'delta' => $delta,
                ];
            }
        }

        return $warnings;
    }

    // ------------------------------------------------------------ bookkeeping

    /** @return array<string, mixed>|null */
    private function replay(string $requestUuid): ?array
    {
        $row = $this->connection->table('sync_requests')
            ->where('request_uuid', $requestUuid)
            ->whereNotNull('processed_at')
            ->first();

        if ($row === null) {
            return null;
        }

        /** @var array<string, mixed>|null $body */
        $body = json_decode((string) ($row->response_body ?? 'null'), true);

        if (! is_array($body)) {
            return null;
        }

        $body['replayed'] = true;

        return $body;
    }

    /**
     * @param  array<string, mixed>  $payload
     * @param  list<string>  $uuids
     */
    private function openRequestLog(PosConfig $config, ?PosDevice $device, string $requestUuid, array $payload, array $uuids): int
    {
        $encoded = json_encode($payload) ?: '';

        return (int) $this->connection->table('sync_requests')->insertGetId([
            'request_uuid' => $requestUuid,
            'pos_device_id' => $device?->getKey(),
            'pos_config_id' => $config->getKey(),
            'endpoint' => 'pos.sync',
            'payload_hash' => hash('sha256', $encoded),
            'record_uuids' => json_encode($uuids),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    /** @param array<string, mixed> $response */
    private function closeRequestLog(int $id, array $response, int $durationMs): void
    {
        $this->connection->table('sync_requests')->where('id', $id)->update([
            'response_status' => 200,
            'response_body' => json_encode($response),
            'processed_at' => now(),
            'duration_ms' => $durationMs,
            'updated_at' => now(),
        ]);
    }

    /** @param array<string, mixed> $detail */
    private function recordConflict(
        PosConfig $config,
        ?PosDevice $device,
        SyncConflictType $type,
        SyncResolution $resolution,
        string $recordUuid,
        array $detail,
    ): void {
        $this->connection->table('sync_conflicts')->insert([
            'uuid' => (string) Str::uuid(),
            'pos_config_id' => $config->getKey(),
            'pos_device_id' => $device?->getKey(),
            'conflict_type' => $type->value,
            'model_type' => Order::class,
            'record_uuid' => $recordUuid,
            'resolution' => $resolution->value,
            'detail' => json_encode($detail),
            'detected_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    private function broadcast(PosConfig $config, ?PosDevice $device, Order $order, ?string $previousState, bool $isNew): void
    {
        $state = $this->stateValue($order->state);

        $this->events->dispatch(new OrderSynced(
            configToken: (string) $config->access_token,
            orderUuid: (string) $order->uuid,
            orderId: (int) $order->getKey(),
            state: $state,
            tableId: $order->restaurant_table_id === null ? null : (int) $order->restaurant_table_id,
            amountTotal: (string) $order->amount_total,
            updatedAt: (string) $order->updated_at,
            emittedByDeviceUuid: $device?->uuid,
        ));

        if ($isNew || $previousState !== $state) {
            $this->events->dispatch(new OrderStateChanged(
                configToken: (string) $config->access_token,
                orderUuid: (string) $order->uuid,
                orderId: (int) $order->getKey(),
                fromState: $previousState ?? 'new',
                toState: $state,
                orderAccessToken: (string) $order->access_token,
                trackingNumber: $order->tracking_number,
                emittedByDeviceUuid: $device?->uuid,
            ));
        }
    }

    // ------------------------------------------------------------- helpers

    /** @return array<string, mixed> */
    private function orderSummary(Order $order): array
    {
        return [
            'id' => (int) $order->getKey(),
            'uuid' => (string) $order->uuid,
            'name' => $order->name,
            'sequence_number' => $order->sequence_number,
            'receipt_number' => $order->receipt_number,
            // The number the server assigned, which may not be the one the till proposed. The
            // customer is called by this and the kitchen prints it, so a till showing its own guess
            // would be calling a number nobody else uses (BAN-506).
            'tracking_number' => $order->tracking_number,
            'ticket_code' => $order->ticket_code,
            'access_token' => (string) $order->access_token,
            'state' => $this->stateValue($order->state),
            'pos_session_id' => (int) $order->pos_session_id,
            'amount_untaxed' => (string) $order->amount_untaxed,
            'amount_tax' => (string) $order->amount_tax,
            'amount_total' => (string) $order->amount_total,
            'amount_paid' => (string) $order->amount_paid,
            'amount_change' => (string) $order->amount_change,
            'amount_due' => (string) $order->amount_due,
            'amount_rounding' => (string) $order->amount_rounding,
            'updated_at' => (string) $order->updated_at,
        ];
    }

    /** @return array<string, mixed> */
    /**
     * Does this child uuid already belong to a *different* order? (BAN-492)
     *
     * `applyPaymentCommands` and `applyCourseCommands` both write through
     * `updateOrCreate(['uuid' => $uuid], ['pos_order_id' => $order->id, …])`, which matches on the
     * uuid **globally**. A command naming a payment or course uuid from someone else's order
     * therefore re-parented that row onto this one — and, for a payment, overwrote its amount and
     * method on the way. The victim's order kept a stale `amount_paid` until its next recompute,
     * at which point a settled order reads as unpaid. Across tenants, on a legitimately-owned
     * order, so the order-level guard above never sees it.
     *
     * Checked and rejected rather than scoped into the match: `uuid` is unique on both tables, so a
     * scoped `updateOrCreate` would fall through to an insert and die on the index — one bad child
     * command failing the whole order with an opaque `ingest_failed`.
     */
    private function belongsToAnotherOrder(string $table, string $uuid, Order $order): bool
    {
        $ownerId = $this->connection->table($table)->where('uuid', $uuid)->value('pos_order_id');

        return $ownerId !== null && (int) $ownerId !== (int) $order->getKey();
    }

    /**
     * May this config write to this order? (BAN-492)
     *
     * The set is the config's **own** orders plus those of its trusted peers — not the config
     * alone. Trusted configs exist precisely to "share open orders" (`PosConfig::trustedConfigs`),
     * and both the bootstrap (`Order::posLoadScope`) and the delta ship a peer's drafts to this
     * register, so a till holding one will sync its changes back. Scoping to `pos_config_id` alone
     * would have looked like the obvious one-line fix and broken multi-till service.
     *
     * `company_id` is checked too. A trusted pairing across tenants would be a configuration
     * mistake rather than an intention, and this is the boundary that must not depend on someone
     * having configured the pivot correctly.
     */
    private function isWritableBy(PosConfig $config, Order $order): bool
    {
        if ((int) $order->company_id !== (int) $config->company_id) {
            return false;
        }

        if ((int) $order->pos_config_id === (int) $config->getKey()) {
            return true;
        }

        // Property access, not `->trustedConfigs()`: Eloquent caches the loaded relation on the
        // model, so a batch of N orders costs one query rather than N.
        return $config->trustedConfigs
            ->contains(static fn (PosConfig $peer): bool => (int) $peer->getKey() === (int) $order->pos_config_id);
    }

    private function rejected(string $uuid, string $code, string $message): array
    {
        return [
            'uuid' => $uuid,
            'status' => 'rejected',
            'error' => ['code' => $code, 'message' => $message],
        ];
    }

    private function rev(Order $order): string
    {
        return 'r'.$order->getKey().':'.($order->updated_at?->getTimestampMs() ?? 0);
    }

    private function stateValue(mixed $state): string
    {
        return $state instanceof OrderState ? $state->value : (string) $state;
    }

    /** @param list<int> $taxIds */
    private function taxSignature(array $taxIds): string
    {
        $ids = array_values(array_unique(array_map(intval(...), $taxIds)));
        sort($ids);

        return $ids === [] ? 'none' : implode('-', $ids);
    }

    /** @return array{product_id: int, uom_id: int, display_name: string, list_price: string, standard_price: string, pos_category_id: ?int}|null */
    private function variantMeta(int $variantId): ?array
    {
        if ($variantId <= 0) {
            return null;
        }

        $row = $this->connection->table('product_variants')
            ->join('products', 'products.id', '=', 'product_variants.product_id')
            ->where('product_variants.id', $variantId)
            ->select([
                'product_variants.product_id',
                'product_variants.display_name',
                'product_variants.list_price as variant_price',
                'product_variants.standard_price as variant_cost',
                'products.uom_id',
                'products.list_price as product_price',
                'products.standard_price as product_cost',
                // Needed by the settled-order guard (BAN-410): a tip is the one line that may be
                // added to an order after it is paid.
                'products.special_kind',
            ])
            ->first();

        if ($row === null) {
            return null;
        }

        $categoryId = $this->connection->table('pos_category_product')
            ->where('product_id', $row->product_id)
            ->orderBy('sequence')
            ->value('pos_category_id');

        return [
            'product_id' => (int) $row->product_id,
            'uom_id' => (int) $row->uom_id,
            'display_name' => (string) $row->display_name,
            'list_price' => (string) ($row->variant_price ?? $row->product_price),
            'standard_price' => (string) ($row->variant_cost ?: $row->product_cost),
            'pos_category_id' => $categoryId === null ? null : (int) $categoryId,
            'special_kind' => (string) $row->special_kind,
        ];
    }

    /**
     * Resolve a sibling line's id — the combo parent of the line being written.
     *
     * Scoped to the order under edit (BAN-492). The fallback lookup used to search every line in
     * the database, so a crafted `combo_parent_uuid` could point a line at a parent on someone
     * else's order. Narrower than the order hole — it writes one FK on a line the caller does own —
     * but the same reach-across, in the same file.
     *
     * The fallback is still needed: `$existing` starts as the lines already on the order and grows
     * as this batch creates more, but a parent created in an *earlier* request is in neither, and
     * `createLine` receives `$existing` by reference precisely so within-batch parents resolve.
     *
     * @param  array<string, int>  $existing
     */
    private function lineIdFor(mixed $uuid, array $existing, ?Order $order = null): ?int
    {
        if (! is_string($uuid) || $uuid === '') {
            return null;
        }

        return $existing[$uuid] ?? $this->lineIdByUuid($uuid, $order);
    }

    private function lineIdByUuid(mixed $uuid, ?Order $order = null): ?int
    {
        if (! is_string($uuid) || $uuid === '' || $order === null) {
            return null;
        }

        $id = OrderLine::query()
            ->where('uuid', $uuid)
            ->where('pos_order_id', $order->getKey())
            ->value('id');

        return $id === null ? null : (int) $id;
    }

    private function courseIdFor(?Order $order, mixed $uuid): ?int
    {
        if ($order === null || ! is_string($uuid) || $uuid === '') {
            return null;
        }

        $id = OrderCourse::query()->where('uuid', $uuid)->where('pos_order_id', $order->getKey())->value('id');

        return $id === null ? null : (int) $id;
    }

    /** `pos_order_lines.internal_note` is `[{text, color_index}]` JSON. */
    private function normaliseNote(mixed $note): ?array
    {
        if ($note === null || $note === '') {
            return null;
        }

        if (is_array($note)) {
            return array_is_list($note) ? $note : [$note];
        }

        return [['text' => (string) $note, 'color_index' => 0]];
    }
}
