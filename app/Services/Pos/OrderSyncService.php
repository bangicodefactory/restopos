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
use App\Models\Identity\Customer;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Pos\Payment as OrderPayment;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Models\Pos\PosSession;
use App\Models\Restaurant\OrderCourse;
use App\Services\Kitchen\PreparationService;
use App\Support\Tax\Dto\OrderResult;
use Illuminate\Contracts\Config\Repository as Config;
use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Carbon;
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
            return $this->connection->transaction(fn (): array => $this->ingest($config, $device, $uuid, $command, $employeeId));
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

        $movement = $this->sessions->cashMove(
            session: $session,
            type: $type,
            amount: (string) ($payload['amount'] ?? '0'),
            reason: isset($payload['reason']) ? (string) $payload['reason'] : null,
            employeeId: isset($payload['employee_id']) ? (int) $payload['employee_id'] : $employeeId,
            deviceId: $device?->getKey(),
            uuid: isset($payload['uuid']) ? (string) $payload['uuid'] : $uuid,
        );

        return ['uuid' => $uuid, 'status' => 'ok', 'server_rev' => null, 'id' => (int) $movement->getKey()];
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

        return ['uuid' => $uuid, 'status' => 'ok', 'server_rev' => null, 'id' => (int) $customer->getKey()];
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

        $order = $orderUuid === ''
            ? null
            : Order::query()->where('pos_config_id', $config->getKey())->where('uuid', $orderUuid)->first();

        if ($order === null) {
            return $this->rejected($uuid, 'unknown_order', 'prep.sent references an order not on this register.');
        }

        $version = $this->preparation->markAllSent($order);

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
            'tracking_number' => $attributes['tracking_number'] ?? null,
            'ticket_code' => $attributes['ticket_code'] ?? $this->sequences->receiptToken(),
            'access_token' => (string) ($attributes['access_token'] ?? Str::uuid()),
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
            'to_invoice', 'customer_email', 'customer_phone', 'tracking_number',
            // A table transfer, a tip, and an explicit "no tip" (is_tipped=false, tip_amount=0)
            // must all survive an update; the client sends the column names directly.
            'restaurant_table_id', 'is_tipped', 'tip_amount',
        ];

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
            'combo_parent_line_id' => $this->lineIdFor($command['combo_parent_uuid'] ?? null, $existing),
            'combo_id' => $command['combo_id'] ?? null,
            'combo_item_id' => $command['combo_item_id'] ?? null,
            'restaurant_course_id' => $this->courseIdFor($order, $command['course_uuid'] ?? null),
            'refunded_order_line_id' => $this->lineIdByUuid($command['refunded_line_uuid'] ?? null),
            'skip_preparation' => (bool) ($command['skip_preparation'] ?? false),
        ]);

        $existing[$uuid] = (int) $line->getKey();

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

        return ['uuid' => $uuid, 'id' => (int) $line->getKey(), 'status' => 'ok'];
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
        $payments = $this->paymentTotals($order);
        $netPaid = bcsub($payments['paid'], $payments['change'], 4);

        $order->forceFill([
            'amount_untaxed' => $totals->totalExcluded,
            'amount_tax' => $totals->totalTax,
            'amount_total' => $totals->roundedTotal,
            'amount_rounding' => $totals->roundingDelta,
            'amount_discount' => $discountTotal,
            'amount_paid' => $payments['paid'],
            'amount_change' => $payments['change'],
            'amount_due' => bcsub($totals->roundedTotal, $netPaid, 4),
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

    /** @param array<string, int> $existing */
    private function lineIdFor(mixed $uuid, array $existing): ?int
    {
        if (! is_string($uuid) || $uuid === '') {
            return null;
        }

        return $existing[$uuid] ?? $this->lineIdByUuid($uuid);
    }

    private function lineIdByUuid(mixed $uuid): ?int
    {
        if (! is_string($uuid) || $uuid === '') {
            return null;
        }

        $id = OrderLine::query()->where('uuid', $uuid)->value('id');

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
