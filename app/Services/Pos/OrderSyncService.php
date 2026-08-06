<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\CashMovementType;
use App\Enums\OrderSource;
use App\Enums\OrderState;
use App\Enums\PaymentStatus;
use App\Enums\PriceType;
use App\Enums\SyncConflictType;
use App\Enums\SyncResolution;
use App\Events\Pos\OrderStateChanged;
use App\Events\Pos\OrderSynced;
use App\Exceptions\Pos\ChangeWithoutCashException;
use App\Models\Identity\Customer;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Pos\Payment as OrderPayment;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Models\Pos\PosSession;
use App\Models\Restaurant\OrderCourse;
use App\Services\Kitchen\PreparationService;
use App\Support\Money\Decimal;
use App\Support\Tax\CashRounding;
use App\Support\Tax\Dto\OrderResult;
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
        private Dispatcher $events,
        private LoggerInterface $logger,
        private Config $config,
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

        foreach ($orders as $command) {
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
            $command['order'] = $this->resolvePlaceholderCustomer($command['order'], $customerIdMap);
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

    /** Drop an unresolved client-placeholder (negative) customer id to null; remap a resolved one.
     *
     * @param  array<string, mixed>  $order
     * @param  array<int, int>  $customerIdMap
     * @return array<string, mixed>
     */
    private function resolvePlaceholderCustomer(array $order, array $customerIdMap): array
    {
        if (! isset($order['customer_id'])) {
            return $order;
        }

        $customerId = (int) $order['customer_id'];

        if ($customerId >= 0) {
            return $order;
        }

        $order['customer_id'] = $customerIdMap[$customerId] ?? null;

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

            $this->updateOrder($order, $session, $attributes, $employeeId);
        }

        if ($op === 'delete_draft') {
            return $this->deleteDraft($config, $device, $order, $uuid);
        }

        // 4 — child commands, with create↔update rewriting.
        $lineResults = $this->applyLineCommands($config, $order, (array) ($command['lines'] ?? []));
        $courseResults = $this->applyCourseCommands($order, (array) ($command['courses'] ?? []));
        $paymentResults = $this->applyPaymentCommands($order, $session, $device, (array) ($command['payments'] ?? []));

        if ($op === 'cancel') {
            $order->forceFill([
                'state' => OrderState::Cancelled->value,
                'cancelled_at' => now(),
                'cancel_reason' => (string) ($attributes['cancel_reason'] ?? 'Cancelled on device'),
            ])->save();

            $this->withdrawFromKitchen($config, $device, $order);
        }

        // 5 — recompute every monetary field. This is the authoritative pass.
        $computed = $this->recompute($config, $order);

        foreach ($this->mismatchWarnings($attributes, $order) as $warning) {
            $warnings[] = $warning;

            $this->recordConflict($config, $device, SyncConflictType::PayloadMismatch, SyncResolution::ServerWins, $uuid, $warning);
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
        ];

        // `tracking_number` is deliberately NOT writable, for the same reason `access_token` is not
        // (BAN-496): the server assigns it, so letting a client write it back would undo that.
        //
        // Concretely — the bug this closes. A till proposes `001`, the server finds it taken and
        // assigns `002`, and the till syncs the same order again a moment later with its original
        // `001` still attached. The update wrote it straight through, colliding with whoever holds
        // `001`, and the order was rejected. Fixing only the create path left this open, and it is
        // the path a register uses most: every draft is pushed again when it is paid (BAN-506).

        $update = ['pos_session_id' => $session->getKey()];

        foreach ($writable as $field) {
            if (array_key_exists($field, $attributes)) {
                $update[$field] = $attributes[$field];
            }
        }

        foreach ([['table_id', 'restaurant_table_id'], ['preset_id', 'pos_preset_id']] as [$client, $column]) {
            if (array_key_exists($client, $attributes)) {
                $update[$column] = $attributes[$client];
            }
        }

        if ($employeeId !== null && ! isset($update['employee_id'])) {
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
    private function applyLineCommands(PosConfig $config, Order $order, array $commands): array
    {
        /** @var array<string, int> $existing uuid => id */
        $existing = OrderLine::query()
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

            $op = (string) ($command['op'] ?? 'create');

            // A create for a uuid we already hold is an update (retry), and an
            // update for a uuid we have never seen is a create (coalesced
            // outbox entry). Both directions are load-bearing.
            if ($op === 'create' && isset($existing[$uuid])) {
                $op = 'update';
            } elseif ($op === 'update' && ! isset($existing[$uuid])) {
                $op = 'create';
            }

            $results[] = match ($op) {
                'delete' => $this->deleteLine($existing[$uuid] ?? null, $uuid),
                'update' => $this->updateLine($existing[$uuid], $command, $uuid),
                default => $this->createLine($config, $order, $command, $uuid, $existing),
            };
        }

        return $results;
    }

    /**
     * @param  array<string, mixed>  $command
     * @param  array<string, int>  $existing
     * @return array<string, mixed>
     */
    private function createLine(PosConfig $config, Order $order, array $command, string $uuid, array &$existing): array
    {
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
            'line_number' => count($existing) + 1,
            'product_variant_id' => $variantId,
            'product_id' => $variant['product_id'],
            'pos_category_id' => $variant['pos_category_id'],
            'full_product_name' => (string) ($command['full_product_name'] ?? $variant['display_name']),
            'uom_id' => $variant['uom_id'],
            'quantity' => (string) ($command['qty'] ?? $command['quantity'] ?? '1'),
            'price_unit' => (string) ($command['price_unit'] ?? $variant['list_price']),
            'price_extra' => (string) ($command['price_extra'] ?? '0'),
            'price_type' => (string) ($command['price_type'] ?? PriceType::Original->value),
            'discount_percent' => (string) ($command['discount'] ?? $command['discount_percent'] ?? '0'),
            'discount_notice' => $command['discount_notice'] ?? null,
            'tax_signature' => $this->taxSignature($taxIds),
            'unit_cost' => (string) $variant['standard_price'],
            'customer_note' => $command['customer_note'] ?? null,
            'internal_note' => $this->normaliseNote($command['note'] ?? $command['internal_note'] ?? null),
            'combo_parent_line_id' => $this->lineIdFor($command['combo_parent_uuid'] ?? null, $existing, $order),
            'combo_id' => $command['combo_id'] ?? null,
            'combo_item_id' => $command['combo_item_id'] ?? null,
            'restaurant_course_id' => $this->courseIdFor($order, $command['course_uuid'] ?? null),
            'refunded_order_line_id' => $this->lineIdByUuid($command['refunded_line_uuid'] ?? null),
            'skip_preparation' => (bool) ($command['skip_preparation'] ?? false),
        ]);

        $existing[$uuid] = (int) $line->getKey();

        $this->syncLineAttributes((int) $line->getKey(), (int) $variant['product_id'], $command);

        return ['uuid' => $uuid, 'id' => (int) $line->getKey(), 'status' => 'ok'];
    }

    /**
     * @param  array<string, mixed>  $command
     * @return array<string, mixed>
     */
    private function updateLine(int $id, array $command, string $uuid): array
    {
        /** @var OrderLine|null $line */
        $line = OrderLine::query()->find($id);

        if ($line === null) {
            return ['uuid' => $uuid, 'status' => 'rejected', 'code' => 'line_vanished'];
        }

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

        $update = ['is_edited' => true];

        foreach ($map as $from => $to) {
            if (array_key_exists($from, $command)) {
                $update[$to] = $command[$from];
            }
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

        // A resent line carries its options; re-sync them (replace-on-write) so an edit that
        // adds or clears an option is reflected. A note-only update omits the keys and no-ops.
        $this->syncLineAttributes((int) $line->getKey(), (int) $line->product_id, $command);

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
    private function deleteLine(?int $id, string $uuid): array
    {
        if ($id === null) {
            return ['uuid' => $uuid, 'status' => 'ok', 'deleted' => true, 'code' => 'already_absent'];
        }

        OrderLine::query()->whereKey($id)->delete();

        return ['uuid' => $uuid, 'id' => $id, 'status' => 'ok', 'deleted' => true];
    }

    /**
     * @param  array<int, array<string, mixed>>  $commands
     * @return list<array<string, mixed>>
     */
    private function applyCourseCommands(Order $order, array $commands): array
    {
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
    private function applyPaymentCommands(Order $order, PosSession $session, ?PosDevice $device, array $commands): array
    {
        /** @var array<string, int> $existing */
        $existing = OrderPayment::query()
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

            // A payment uuid that already belongs to another order is never this order's to write
            // (BAN-492). This is the money one: without it, the row is re-parented here and its
            // amount overwritten, leaving a settled order elsewhere unpaid.
            if (! isset($existing[$uuid]) && $this->belongsToAnotherOrder('pos_payments', $uuid, $order)) {
                $results[] = ['uuid' => $uuid, 'status' => 'rejected', 'code' => 'payment_not_writable'];

                continue;
            }

            $op = (string) ($command['op'] ?? 'create');

            if ($op === 'delete') {
                if (isset($existing[$uuid])) {
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

            $results[] = ['uuid' => $uuid, 'id' => (int) $payment->getKey(), 'status' => 'ok'];
        }

        return $results;
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
