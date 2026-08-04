<?php

declare(strict_types=1);

use App\Enums\OrderState;
use App\Enums\SelfOrderMode;
use App\Enums\SelfOrderPayAfter;
use App\Enums\SelfOrderServiceMode;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make([
        'self_ordering_mode' => SelfOrderMode::Mobile->value,
        'self_ordering_service_mode' => SelfOrderServiceMode::Table->value,
        'self_ordering_pay_after' => SelfOrderPayAfter::Meal->value,
        'self_ordering_brand_name' => 'Trattoria',
    ])->withSession()->withFloor();

    $this->token = $this->fx->config->access_token;
    $this->tableToken = $this->fx->tableOne->identifier;
});

it('rejects an unknown config token', function (): void {
    $this->getJson('/api/self-order/not-a-real-token/menu')
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'invalid_config_token');
});

it('rejects a bad table token even with a valid config token', function (): void {
    $this->getJson("/api/self-order/{$this->token}/menu?tt=deadbeef")
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'invalid_table_token');
});

it('404s when self-ordering is disabled for the venue', function (): void {
    $this->fx->config->forceFill(['self_ordering_mode' => SelfOrderMode::Nothing->value])->save();

    $this->getJson("/api/self-order/{$this->token}/menu")
        ->assertStatus(404)
        ->assertJsonPath('error.code', 'self_order_disabled');
});

it('serves the anonymous menu with branding and the resolved table', function (): void {
    $response = $this->getJson("/api/self-order/{$this->token}/menu?tt={$this->tableToken}");

    $response->assertOk()
        ->assertJsonPath('profile', 'self_order')
        ->assertJsonPath('self_order.mode', SelfOrderMode::Mobile->value)
        ->assertJsonPath('self_order.brand_name', 'Trattoria')
        ->assertJsonPath('table.id', $this->fx->tableOne->getKey());

    expect($response->json('data.products'))->not->toBeEmpty()
        // The anonymous profile never ships staff data.
        ->and($response->json('data.employees'))->toBeNull()
        ->and($response->json('data.pos_devices'))->toBeNull();
});

it('accepts a cart and prices it from the catalog, ignoring the client price', function (): void {
    $response = $this->postJson("/api/self-order/{$this->token}/orders?tt={$this->tableToken}", [
        'lines' => [
            ['variant_id' => $this->fx->variant->getKey(), 'quantity' => 2, 'price_unit' => '0.01'],
        ],
        'customer_note' => 'Table by the window',
    ]);

    $response->assertCreated()
        ->assertJsonPath('appended', false)
        ->assertJsonStructure(['order' => ['uuid', 'access_token', 'state', 'amount_total', 'lines'], 'access_token']);

    // 2 × 10.00 + 21 % — not 2 × 0.01.
    expect($response->json('order.amount_total'))->toBe('24.2000')
        ->and($response->json('order.state'))->toBe(OrderState::Draft->value);

    // The tampered price is recorded rather than silently ignored.
    expect(DB::table('sync_conflicts')->where('conflict_type', 'price_tamper')->count())->toBe(1);
});

it('appends to the table order in table service with pay-after-meal', function (): void {
    $first = $this->postJson("/api/self-order/{$this->token}/orders?tt={$this->tableToken}", [
        'lines' => [['variant_id' => $this->fx->variant->getKey(), 'quantity' => 1]],
    ]);

    $first->assertCreated()->assertJsonPath('appended', false);

    $second = $this->postJson("/api/self-order/{$this->token}/orders?tt={$this->tableToken}", [
        'lines' => [['variant_id' => $this->fx->drinkVariant->getKey(), 'quantity' => 2]],
    ]);

    $second->assertCreated()->assertJsonPath('appended', true);

    expect($second->json('order.uuid'))->toBe($first->json('order.uuid'))
        ->and(Order::query()->where('source', 'mobile')->count())->toBe(1);

    $orderId = (int) Order::query()->where('uuid', $first->json('order.uuid'))->value('id');

    expect(OrderLine::query()->where('pos_order_id', $orderId)->count())->toBe(2)
        // 10.00 + 2 × 2.50 = 15.00 net, 3.15 tax.
        ->and((string) Order::query()->whereKey($orderId)->value('amount_total'))->toBe('18.1500');
});

it('starts a new order per cart in counter service with pay-each', function (): void {
    $this->fx->config->forceFill([
        'self_ordering_service_mode' => SelfOrderServiceMode::Counter->value,
        'self_ordering_pay_after' => SelfOrderPayAfter::Each->value,
    ])->save();

    $this->postJson("/api/self-order/{$this->token}/orders?tt={$this->tableToken}", [
        'lines' => [['variant_id' => $this->fx->variant->getKey(), 'quantity' => 1]],
    ])->assertCreated()->assertJsonPath('appended', false);

    $this->postJson("/api/self-order/{$this->token}/orders?tt={$this->tableToken}", [
        'lines' => [['variant_id' => $this->fx->variant->getKey(), 'quantity' => 1]],
    ])->assertCreated()->assertJsonPath('appended', false);

    expect(Order::query()->where('source', 'mobile')->count())->toBe(2);
});

it('rejects an empty cart', function (): void {
    $this->postJson("/api/self-order/{$this->token}/orders?tt={$this->tableToken}", ['lines' => []])
        ->assertStatus(422);
});

it('returns an order status only to the holder of its access token', function (): void {
    $created = $this->postJson("/api/self-order/{$this->token}/orders?tt={$this->tableToken}", [
        'lines' => [['variant_id' => $this->fx->variant->getKey(), 'quantity' => 1]],
    ])->assertCreated();

    $uuid = $created->json('order.uuid');
    $orderToken = $created->json('access_token');

    $this->withHeaders(['X-Order-Token' => $orderToken])
        ->getJson("/api/self-order/{$this->token}/orders/{$uuid}")
        ->assertOk()
        ->assertJsonPath('uuid', $uuid)
        ->assertJsonPath('state', OrderState::Draft->value);

    $this->withHeaders(['X-Order-Token' => (string) Str::uuid()])
        ->getJson("/api/self-order/{$this->token}/orders/{$uuid}")
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'invalid_order_token');

    $this->getJson("/api/self-order/{$this->token}/orders/{$uuid}")
        ->assertStatus(403);
});

it('lets a customer cancel their own draft', function (): void {
    $created = $this->postJson("/api/self-order/{$this->token}/orders?tt={$this->tableToken}", [
        'lines' => [['variant_id' => $this->fx->variant->getKey(), 'quantity' => 1]],
    ])->assertCreated();

    $uuid = $created->json('order.uuid');
    $orderToken = $created->json('access_token');

    $this->withHeaders(['X-Order-Token' => $orderToken])
        ->postJson("/api/self-order/{$this->token}/orders/{$uuid}/cancel")
        ->assertOk()
        ->assertJsonPath('state', OrderState::Cancelled->value);

    // …and not twice.
    $this->withHeaders(['X-Order-Token' => $orderToken])
        ->postJson("/api/self-order/{$this->token}/orders/{$uuid}/cancel")
        ->assertStatus(422);
});

it('runs the online payment flow end to end through the stub provider', function (): void {
    $provider = DB::table('payment_providers')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Stub',
        'code' => 'none',
        'state' => 'test',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $this->fx->card->forceFill(['payment_provider_id' => $provider])->save();
    $this->fx->config->forceFill(['self_order_online_payment_method_id' => $this->fx->card->getKey()])->save();

    $created = $this->postJson("/api/self-order/{$this->token}/orders?tt={$this->tableToken}", [
        'lines' => [['variant_id' => $this->fx->variant->getKey(), 'quantity' => 1]],
    ])->assertCreated();

    $uuid = $created->json('order.uuid');
    $orderToken = $created->json('access_token');

    $intent = $this->withHeaders(['X-Order-Token' => $orderToken])
        ->postJson("/api/self-order/{$this->token}/orders/{$uuid}/payment-intent");

    $intent->assertCreated()
        ->assertJsonPath('state', 'pending')
        ->assertJsonPath('amount', '12.1000')
        ->assertJsonStructure(['reference', 'provider_reference', 'state', 'amount']);

    expect(DB::table('payment_transactions')->count())->toBe(1);

    $confirm = $this->withHeaders(['X-Order-Token' => $orderToken])
        ->postJson("/api/self-order/{$this->token}/orders/{$uuid}/payment-confirm", [
            'reference' => $intent->json('reference'),
        ]);

    $confirm->assertOk()
        ->assertJsonPath('state', 'done')
        ->assertJsonPath('order.state', OrderState::Paid->value)
        ->assertJsonPath('order.amount_due', '0.0000');

    expect(DB::table('pos_payments')->count())->toBe(1)
        ->and((float) DB::table('pos_payments')->value('amount'))->toBe(12.1);
});

it('refuses an online payment when the venue has no provider configured', function (): void {
    $created = $this->postJson("/api/self-order/{$this->token}/orders?tt={$this->tableToken}", [
        'lines' => [['variant_id' => $this->fx->variant->getKey(), 'quantity' => 1]],
    ])->assertCreated();

    $this->withHeaders(['X-Order-Token' => $created->json('access_token')])
        ->postJson("/api/self-order/{$this->token}/orders/{$created->json('order.uuid')}/payment-intent")
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'payment_intent_failed');
});

it('marks self-ordered lines as already sent to the kitchen', function (): void {
    $this->fx->withPrepDisplay();

    $created = $this->postJson("/api/self-order/{$this->token}/orders?tt={$this->tableToken}", [
        'lines' => [['variant_id' => $this->fx->variant->getKey(), 'quantity' => 2]],
    ])->assertCreated();

    $uuid = $created->json('order.uuid');

    // The kitchen already has them, so the cashier must not re-fire (KDS-062).
    $this->withHeaders($this->fx->headers())
        ->getJson("/api/pos/orders/{$uuid}/preparation-changes")
        ->assertOk()
        ->assertJsonPath('nbr_of_changes', 0);

    expect(DB::table('prep_orders')->count())->toBe(1);
});

/**
 * BAN-431 (SLF-027) — the self-order request validates `attribute_value_ids`, so they must actually
 * persist. submitCart maps them into the ingest line command; the join table is written and the
 * option rides onto the kitchen ticket the cart fires on submit.
 */
it('persists attribute selections from a self-order cart and fires them to the kitchen', function (): void {
    $this->fx->withPrepDisplay();
    $chocolate = $this->fx->attributeOption('Chocolate', '1.50');

    $response = $this->postJson("/api/self-order/{$this->token}/orders?tt={$this->tableToken}", [
        'lines' => [[
            'variant_id' => $this->fx->variant->getKey(),
            'quantity' => 1,
            'attribute_value_ids' => [$chocolate],
        ]],
    ])->assertCreated();

    $orderId = (int) Order::query()->where('uuid', $response->json('order.uuid'))->value('id');
    $lineId = (int) DB::table('pos_order_lines')->where('pos_order_id', $orderId)->value('id');

    expect(DB::table('pos_order_line_attribute_value')
        ->where('pos_order_line_id', $lineId)
        ->where('product_attribute_line_value_id', $chocolate)
        ->exists())->toBeTrue();

    // Fired to the kitchen on submit, with the option on the ticket.
    $displayName = (string) DB::table('prep_order_lines')->value('display_name');
    expect($displayName)->toContain('Chocolate');
});
