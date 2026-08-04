<?php

declare(strict_types=1);

namespace App\Services\SelfOrder;

use App\Enums\DeviceType;
use App\Enums\OrderSource;
use App\Enums\OrderState;
use App\Enums\PaymentStatus;
use App\Enums\SelfOrderPayAfter;
use App\Enums\SelfOrderServiceMode;
use App\Enums\SyncConflictType;
use App\Enums\SyncResolution;
use App\Events\Pos\PaymentStatusChanged;
use App\Events\SelfOrder\SelfOrderPlaced;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\Order;
use App\Models\Pos\Payment as OrderPayment;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Services\Kitchen\PreparationService;
use App\Services\Payment\Dto\PaymentIntent;
use App\Services\Payment\PaymentProvider;
use App\Services\Pos\BootstrapService;
use App\Services\Pos\OrderSyncService;
use App\Services\Pos\PricingService;
use App\Services\Pos\SessionService;
use DomainException;
use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * The public self-order surface (spec 02 SLF-001…SLF-129).
 *
 * Two rules govern everything here:
 *
 * 1. **The client is untrusted.** Prices, taxes and totals are recomputed from
 *    the catalog on submission; a payload carrying its own prices is recorded as
 *    a `price_tamper` conflict and the server's numbers win regardless.
 * 2. **Append vs. new is a config decision, not a client one.** In table service
 *    with `pay_after = meal`, a cart joins the table's existing draft order so
 *    the tab stays whole. Everywhere else it creates its own order.
 */
final readonly class SelfOrderService
{
    public function __construct(
        private ConnectionInterface $connection,
        private BootstrapService $bootstrap,
        private OrderSyncService $sync,
        private PricingService $pricing,
        private SessionService $sessions,
        private PreparationService $preparation,
        private PaymentProvider $payments,
        private Dispatcher $events,
    ) {}

    /**
     * The anonymous menu payload — a narrower row *and* field set than the
     * register profile (spec 01-schema §5.6).
     *
     * @return array<string, mixed>
     */
    public function menu(SelfOrderContext $context): array
    {
        $config = $context->config;

        $payload = $this->bootstrap->payload(
            config: $config,
            device: $this->pseudoDevice($config),
            only: [
                'currencies', 'decimal_precisions', 'cash_roundings',
                'tax_groups', 'taxes', 'fiscal_positions', 'fiscal_position_taxes',
                'uoms', 'pos_categories', 'products', 'product_variants',
                'product_attributes', 'product_attribute_values', 'product_attribute_lines',
                'product_attribute_line_values', 'combos', 'combo_items',
                'pricelists', 'pricelist_items', 'pos_presets',
            ],
            profile: PosLoadable::PROFILE_SELF_ORDER,
        );

        $payload['self_order'] = [
            'mode' => $config->self_ordering_mode->value,
            'service_mode' => $config->self_ordering_service_mode->value,
            'pay_after' => $config->self_ordering_pay_after->value,
            'ordering_open' => $this->bootstrap->selfOrderOpen($config),
            'brand_name' => $config->self_ordering_brand_name,
            'primary_color' => $config->self_ordering_primary_color,
            'text_color' => $config->self_ordering_text_color,
            'kiosk_idle_seconds' => (int) $config->kiosk_idle_seconds,
            'kiosk_confirmation_seconds' => (int) $config->kiosk_confirmation_seconds,
            'online_payment_method_id' => $config->self_order_online_payment_method_id,
            'custom_links' => $config->selfOrderLinks()->get()->map(static fn ($l): array => [
                'id' => (int) $l->getKey(),
                'name' => (string) $l->name,
                'url' => (string) $l->url,
                'style' => (string) $l->style,
                'open_in_new_tab' => (bool) $l->open_in_new_tab,
            ])->all(),
        ];

        $payload['table'] = $context->table === null ? null : [
            'id' => $context->tableId(),
            'name' => $context->table->name,
            'table_number' => $context->table->table_number,
            'seats' => $context->table->seats,
        ];

        return $payload;
    }

    /**
     * Submit a cart.
     *
     * @param  list<array{variant_id: int, quantity: string|float, customer_note?: string|null, attribute_value_ids?: list<int>, combo_parent_uuid?: string|null, combo_item_id?: int|null}>  $lines
     * @return array<string, mixed>
     */
    public function submitCart(
        SelfOrderContext $context,
        array $lines,
        ?string $customerNote = null,
        ?string $customerEmail = null,
        ?string $customerPhone = null,
        ?string $tableStandNumber = null,
        ?int $presetId = null,
        ?string $clientOrderUuid = null,
    ): array {
        $config = $context->config;

        if (! $config->self_ordering_mode->allowsOrdering()) {
            throw new DomainException('Ordering is not enabled for this venue.');
        }

        if ($lines === []) {
            throw new DomainException('The cart is empty.');
        }

        $target = $this->targetOrder($context);
        $appending = $target !== null;
        $orderUuid = $target?->uuid ?? ($clientOrderUuid ?? (string) Str::uuid());
        $accessToken = $target?->access_token ?? (string) Str::uuid();

        $session = $this->sessions->resolveForIngest($config, null, (string) $orderUuid)['session'];
        $pricelistId = $this->pricing->resolvePricelistId($config, null, $presetId, null);

        $lineCommands = [];

        foreach ($lines as $line) {
            $variantId = (int) $line['variant_id'];
            $quantity = (string) $line['quantity'];

            $command = [
                'op' => 'create',
                'uuid' => (string) Str::uuid(),
                'variant_id' => $variantId,
                'qty' => $quantity,
                // Server-resolved price. The cart's own number is never used.
                'price_unit' => $this->pricing->priceFor($config, $variantId, $pricelistId, $quantity),
                'discount' => '0',
                'customer_note' => $line['customer_note'] ?? null,
                'combo_parent_uuid' => $line['combo_parent_uuid'] ?? null,
                'combo_item_id' => $line['combo_item_id'] ?? null,
            ];

            // The self-order contract calls them `attribute_value_ids`; ingest (createLine) reads
            // `attribute_line_value_ids`. Same ids, so map them through (BAN-431 / SLF-027).
            if (isset($line['attribute_value_ids'])) {
                $command['attribute_line_value_ids'] = array_map('intval', (array) $line['attribute_value_ids']);
            }

            $lineCommands[] = $command;

            if (isset($line['price_unit'])) {
                $this->recordTamper($config, (string) $orderUuid, [
                    'variant_id' => $variantId,
                    'client_price_unit' => (string) $line['price_unit'],
                ]);
            }
        }

        $source = $config->self_ordering_mode->value === 'kiosk' ? OrderSource::Kiosk : OrderSource::Mobile;

        $result = $this->sync->sync($config, null, [
            'orders' => [[
                'uuid' => (string) $orderUuid,
                'op' => 'upsert',
                'order' => array_filter([
                    'session_id' => $session->getKey(),
                    'state' => OrderState::Draft->value,
                    'source' => $source->value,
                    'access_token' => (string) $accessToken,
                    'pricelist_id' => $pricelistId,
                    'preset_id' => $presetId,
                    'table_id' => $this->tableIdFor($context),
                    'general_customer_note' => $customerNote,
                    'customer_email' => $customerEmail,
                    'customer_phone' => $customerPhone,
                    'tracking_number' => $target?->tracking_number ?? $this->trackingNumber($source),
                ], static fn ($v): bool => $v !== null),
                'lines' => $lineCommands,
            ]],
        ]);

        /** @var array<string, mixed> $first */
        $first = $result['results'][0] ?? [];

        if (($first['status'] ?? '') !== 'ok') {
            throw new DomainException('The order could not be accepted: '.json_encode($first['error'] ?? $first));
        }

        /** @var Order $order */
        $order = Order::query()->where('uuid', $orderUuid)->firstOrFail();

        if ($tableStandNumber !== null) {
            $order->forceFill(['table_stand_number' => $tableStandNumber])->save();
        }

        // Customer-submitted lines must not be re-fired by the cashier
        // (KDS-062); the kitchen fan-out happens here, once.
        if ($config->use_preparation_display || $config->use_preparation_printers) {
            $this->preparation->send($order, $config);
        }

        $this->events->dispatch(new SelfOrderPlaced(
            configToken: (string) $config->access_token,
            orderUuid: (string) $order->uuid,
            orderId: (int) $order->getKey(),
            orderAccessToken: (string) $order->access_token,
            state: OrderState::Draft->value,
            tableId: $order->restaurant_table_id === null ? null : (int) $order->restaurant_table_id,
            trackingNumber: $order->tracking_number,
            amountTotal: (string) $order->amount_total,
            source: $source->value,
            appended: $appending,
        ));

        return [
            'order' => $this->publicOrder($order),
            'appended' => $appending,
            'access_token' => (string) $order->access_token,
            'warnings' => $first['warnings'] ?? [],
        ];
    }

    /**
     * Status polling for the customer's phone (SLF-090). Only ever returns the
     * order whose token the caller holds.
     *
     * @return array<string, mixed>
     */
    public function status(SelfOrderContext $context, string $orderUuid, string $orderToken): array
    {
        $order = $this->requireOwnOrder($context, $orderUuid, $orderToken);

        return $this->publicOrder($order);
    }

    /** Cancel one's own draft order. */
    public function cancel(SelfOrderContext $context, string $orderUuid, string $orderToken): array
    {
        $order = $this->requireOwnOrder($context, $orderUuid, $orderToken);

        if ($order->state !== OrderState::Draft) {
            throw new DomainException('Only a draft order can be cancelled.');
        }

        $order->forceFill([
            'state' => OrderState::Cancelled->value,
            'cancelled_at' => now(),
            'cancel_reason' => 'Cancelled by customer',
        ])->save();

        return $this->publicOrder($order);
    }

    /**
     * Start an online payment (SLF-060). The provider is behind
     * {@see PaymentProvider}; the shipped implementation is a stub.
     *
     * @return array<string, mixed>
     */
    public function createPaymentIntent(SelfOrderContext $context, string $orderUuid, string $orderToken, ?string $returnUrl = null): array
    {
        $order = $this->requireOwnOrder($context, $orderUuid, $orderToken);
        $config = $context->config;

        $methodId = $config->self_order_online_payment_method_id;

        if ($methodId === null) {
            throw new DomainException('Online payment is not configured for this venue.');
        }

        $providerId = $this->connection->table('payment_methods')->where('id', $methodId)->value('payment_provider_id');

        if ($providerId === null) {
            throw new DomainException('The online payment method has no provider.');
        }

        $reference = 'SO-'.strtoupper(Str::random(10));
        $currencyCode = (string) $this->connection->table('currencies')->where('id', $order->currency_id)->value('code');

        $result = $this->payments->createIntent(new PaymentIntent(
            orderUuid: (string) $order->uuid,
            orderAccessToken: (string) $order->access_token,
            amount: (string) $order->amount_due,
            currencyCode: $currencyCode,
            paymentMethodId: (int) $methodId,
            customerEmail: $order->customer_email,
            customerPhone: $order->customer_phone,
            returnUrl: $returnUrl,
            reference: $reference,
        ));

        $this->connection->table('payment_transactions')->insert([
            'uuid' => (string) Str::uuid(),
            'company_id' => $order->company_id,
            'pos_order_id' => $order->getKey(),
            'payment_provider_id' => $providerId,
            'payment_method_id' => $methodId,
            'reference' => $reference,
            'provider_reference' => $result->providerReference,
            'amount' => (string) $order->amount_due,
            'currency_id' => $order->currency_id,
            'state' => $result->state->value,
            'state_message' => $result->message,
            'payload' => json_encode($result->payload),
            'initiated_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $this->events->dispatch(new PaymentStatusChanged(
            configToken: (string) $config->access_token,
            orderUuid: (string) $order->uuid,
            paymentUuid: $reference,
            status: $result->state->value,
            amount: (string) $order->amount_due,
            orderAccessToken: (string) $order->access_token,
        ));

        return [
            'reference' => $reference,
            'provider_reference' => $result->providerReference,
            'state' => $result->state->value,
            'redirect_url' => $result->redirectUrl,
            'amount' => (string) $order->amount_due,
        ];
    }

    /**
     * Confirm/capture. Idempotent: a second confirmation of the same reference
     * does not create a second `pos_payments` row.
     *
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    public function confirmPayment(SelfOrderContext $context, string $orderUuid, string $orderToken, string $reference, array $payload = []): array
    {
        $order = $this->requireOwnOrder($context, $orderUuid, $orderToken);
        $config = $context->config;

        $transaction = $this->connection->table('payment_transactions')
            ->where('pos_order_id', $order->getKey())
            ->where('reference', $reference)
            ->first();

        if ($transaction === null) {
            throw new DomainException('Unknown payment reference.');
        }

        $result = $this->payments->confirm(
            (string) $transaction->provider_reference,
            [...$payload, 'amount' => (string) $transaction->amount],
        );

        $this->connection->table('payment_transactions')->where('id', $transaction->id)->update([
            'state' => $result->state->value,
            'state_message' => $result->message,
            'payload' => json_encode($result->payload),
            'completed_at' => $result->isCaptured() ? now() : null,
            'updated_at' => now(),
        ]);

        if ($result->isCaptured()) {
            OrderPayment::query()->updateOrCreate(
                ['uuid' => 'txn-'.$transaction->uuid],
                [
                    'pos_order_id' => $order->getKey(),
                    'pos_session_id' => $order->pos_session_id,
                    'payment_method_id' => $transaction->payment_method_id,
                    'company_id' => $order->company_id,
                    'currency_id' => $order->currency_id,
                    'amount' => (string) $transaction->amount,
                    'amount_company_currency' => (string) $transaction->amount,
                    'is_change' => false,
                    'label' => 'Online payment',
                    'paid_at' => now(),
                    'payment_status' => PaymentStatus::Done->value,
                    'payment_transaction_id' => $transaction->id,
                ],
            );

            $this->sync->recompute($config, $order);

            $order->refresh();

            if (bccomp((string) $order->amount_due, '0', 4) <= 0) {
                $order->forceFill(['state' => OrderState::Paid->value, 'paid_at' => now()])->save();
            }
        }

        $this->events->dispatch(new PaymentStatusChanged(
            configToken: (string) $config->access_token,
            orderUuid: (string) $order->uuid,
            paymentUuid: $reference,
            status: $result->isCaptured() ? PaymentStatus::Done->value : $result->state->value,
            amount: (string) $transaction->amount,
            orderAccessToken: (string) $order->access_token,
        ));

        return [
            'state' => $result->state->value,
            'order' => $this->publicOrder($order->refresh()),
        ];
    }

    // ------------------------------------------------------------- internals

    /**
     * A cart is only *attached* to a table in table service. In counter or
     * kiosk service the QR still identifies where the customer is sitting, but
     * the order belongs to the counter — and the schema enforces one draft order
     * per table (RST-058), so attaching every counter cart to the scanned table
     * would collide on the second customer.
     */
    private function tableIdFor(SelfOrderContext $context): ?int
    {
        return $context->config->self_ordering_service_mode === SelfOrderServiceMode::Table
            ? $context->tableId()
            : null;
    }

    /**
     * Append-to-table-order semantics: table service + `pay_after = meal` means
     * the cart joins the tab (SLF-110).
     */
    private function targetOrder(SelfOrderContext $context): ?Order
    {
        $config = $context->config;

        if ($context->table === null
            || $config->self_ordering_service_mode !== SelfOrderServiceMode::Table
            || $config->self_ordering_pay_after !== SelfOrderPayAfter::Meal
        ) {
            return null;
        }

        /** @var Order|null $order */
        $order = Order::query()
            ->where('pos_config_id', $config->getKey())
            ->where('restaurant_table_id', $context->tableId())
            ->where('state', OrderState::Draft->value)
            ->orderBy('id')
            ->first();

        return $order;
    }

    private function requireOwnOrder(SelfOrderContext $context, string $orderUuid, string $orderToken): Order
    {
        /** @var Order|null $order */
        $order = Order::query()
            ->where('uuid', $orderUuid)
            ->where('pos_config_id', $context->config->getKey())
            ->first();

        if ($order === null || ! hash_equals((string) $order->access_token, $orderToken)) {
            throw new DomainException('Unknown order or invalid order token.');
        }

        return $order;
    }

    /** @return array<string, mixed> */
    private function publicOrder(Order $order): array
    {
        $lines = $this->connection->table('pos_order_lines')
            ->where('pos_order_id', $order->getKey())
            ->whereNull('deleted_at')
            ->orderBy('id')
            ->get(['uuid', 'full_product_name', 'quantity', 'price_unit', 'price_subtotal_incl', 'customer_note'])
            ->map(static fn (object $l): array => (array) $l)
            ->all();

        return [
            'uuid' => (string) $order->uuid,
            'access_token' => (string) $order->access_token,
            'state' => $order->state instanceof OrderState ? $order->state->value : (string) $order->state,
            'prep_state' => (string) $order->prep_state?->value ?? null,
            'tracking_number' => $order->tracking_number,
            'table_stand_number' => $order->table_stand_number,
            'amount_untaxed' => (string) $order->amount_untaxed,
            'amount_tax' => (string) $order->amount_tax,
            'amount_total' => (string) $order->amount_total,
            'amount_paid' => (string) $order->amount_paid,
            'amount_due' => (string) $order->amount_due,
            'lines' => $lines,
            'server_time' => Carbon::now()->toIso8601ZuluString('millisecond'),
        ];
    }

    private function trackingNumber(OrderSource $source): string
    {
        return $source->trackingPrefix().str_pad((string) random_int(1, 999), 3, '0', STR_PAD_LEFT);
    }

    /** @param array<string, mixed> $detail */
    private function recordTamper(PosConfig $config, string $orderUuid, array $detail): void
    {
        $this->connection->table('sync_conflicts')->insert([
            'uuid' => (string) Str::uuid(),
            'pos_config_id' => $config->getKey(),
            'conflict_type' => SyncConflictType::PriceTamper->value,
            'model_type' => Order::class,
            'record_uuid' => $orderUuid,
            'resolution' => SyncResolution::ServerWins->value,
            'detail' => json_encode($detail),
            'detected_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    /**
     * The bootstrap serializer wants a device for the employee verifiers; the
     * self-order profile never emits them, so a detached stand-in is enough.
     */
    private function pseudoDevice(PosConfig $config): PosDevice
    {
        $device = new PosDevice;
        $device->forceFill([
            'uuid' => (string) $config->access_token,
            'pos_config_id' => $config->getKey(),
            'device_identifier' => 0,
            'device_type' => DeviceType::SelfMobile->value,
        ]);

        return $device;
    }
}
