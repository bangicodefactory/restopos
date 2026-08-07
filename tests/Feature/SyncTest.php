<?php

declare(strict_types=1);

use App\Enums\CashMovementType;
use App\Enums\OrderState;
use App\Enums\SessionState;
use App\Enums\SyncConflictType;
use App\Models\Identity\Customer;
use App\Models\Pos\CashMovement;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Pos\Payment;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosSession;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();
});

function sync(array $orders, array $headers = []): TestResponse
{
    /** @var PosFixtures $fx */
    $fx = test()->fx;

    return test()->withHeaders($fx->headers($headers))->postJson('/api/pos/sync', [
        'client_version' => '1.0.0',
        'employee_id' => $fx->cashier->getKey(),
        'orders' => $orders,
    ]);
}

/** One outbox command envelope: a random entry uuid the client matches results against. */
function command(string $kind, array $payload): array
{
    return ['uuid' => (string) Str::uuid(), 'kind' => $kind, 'payload' => $payload, 'at' => now()->toIso8601String()];
}

/** POST a batch of commands (and optionally orders) to the sync endpoint. */
function pushBatch(array $commands, array $orders = []): TestResponse
{
    /** @var PosFixtures $fx */
    $fx = test()->fx;

    return test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'client_version' => '1.0.0',
        'employee_id' => $fx->cashier->getKey(),
        'orders' => $orders,
        'commands' => $commands,
    ]);
}

it('accepts an order and returns per-record results', function (): void {
    $uuid = (string) Str::uuid();

    $response = sync([$this->fx->orderCommand($uuid)]);

    $response->assertOk()
        ->assertJsonPath('results.0.uuid', $uuid)
        ->assertJsonPath('results.0.status', 'ok')
        ->assertJsonStructure(['server_time', 'results' => [['uuid', 'status', 'server_rev', 'order', 'lines', 'totals']]]);

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((int) $order->pos_config_id)->toBe($this->fx->config->getKey())
        ->and((int) $order->pos_session_id)->toBe($this->fx->session->getKey())
        ->and(OrderLine::query()->where('pos_order_id', $order->getKey())->count())->toBe(1);
});

it('is idempotent on uuid: the same order twice yields one order', function (): void {
    $uuid = (string) Str::uuid();
    $command = $this->fx->orderCommand($uuid);

    sync([$command])->assertOk()->assertJsonPath('results.0.status', 'ok');
    sync([$command])->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect(Order::query()->where('uuid', $uuid)->count())->toBe(1);

    // The line command was a `create` both times; the second one is rewritten to
    // an update, so the line must not be duplicated either.
    $order = Order::query()->where('uuid', $uuid)->firstOrFail();
    expect(OrderLine::query()->where('pos_order_id', $order->getKey())->count())->toBe(1);
});

it('replays a recorded response for a repeated Idempotency-Key', function (): void {
    $uuid = (string) Str::uuid();
    $key = (string) Str::uuid();
    $command = $this->fx->orderCommand($uuid);

    $first = sync([$command], ['Idempotency-Key' => $key]);
    $first->assertOk();

    $second = sync([$command], ['Idempotency-Key' => $key]);

    $second->assertOk()->assertJsonPath('replayed', true);
    expect($second->json('results.0.order.id'))->toBe($first->json('results.0.order.id'));
});

it('rewrites an update for an unknown line into a create', function (): void {
    $uuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    // The outbox coalesced the create and a later edit into one `update`.
    sync([$this->fx->orderCommand($uuid, [[
        'op' => 'update',
        'uuid' => $lineUuid,
        'variant_id' => $this->fx->variant->getKey(),
        'qty' => '3',
        'price_unit' => '10.00',
        'discount' => '0',
    ]])])->assertOk()->assertJsonPath('results.0.lines.0.status', 'ok');

    $line = OrderLine::query()->where('uuid', $lineUuid)->first();

    expect($line)->not->toBeNull()
        ->and((float) $line->quantity)->toBe(3.0);
});

it('recomputes every monetary field and never trusts the client totals', function (): void {
    $uuid = (string) Str::uuid();

    // 2 × 10.00 with 21 % excluded VAT ⇒ 20.00 net, 4.20 tax, 24.20 total.
    // The client claims 99.99.
    $response = sync([$this->fx->orderCommand(
        $uuid,
        [],
        ['amount_total_client' => '99.99', 'amount_tax_client' => '0.00'],
    )]);

    $response->assertOk()->assertJsonPath('results.0.status', 'ok');

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((string) $order->amount_untaxed)->toBe('20.0000')
        ->and((string) $order->amount_tax)->toBe('4.2000')
        ->and((string) $order->amount_total)->toBe('24.2000');

    $warnings = collect($response->json('results.0.warnings'))->keyBy('field');

    expect($warnings)->toHaveKey('amount_total')
        ->and($warnings['amount_total']['code'])->toBe('client_total_mismatch')
        ->and($warnings['amount_total']['client'])->toBe('99.99')
        ->and($warnings['amount_total']['server'])->toBe('24.2000');

    // …and the divergence is recorded for triage, not silently swallowed.
    expect(DB::table('sync_conflicts')
        ->where('record_uuid', $uuid)
        ->where('conflict_type', SyncConflictType::PayloadMismatch->value)
        ->count())->toBeGreaterThan(0);
});

it('derives line taxes from the catalog, ignoring client-supplied tax ids', function (): void {
    $uuid = (string) Str::uuid();

    sync([$this->fx->orderCommand($uuid, [[
        'op' => 'create',
        'uuid' => (string) Str::uuid(),
        'variant_id' => $this->fx->variant->getKey(),
        'qty' => '1',
        'price_unit' => '10.00',
        'discount' => '0',
        'tax_ids' => [], // a tampered client trying to zero the VAT
    ]])])->assertOk();

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((string) $order->amount_tax)->toBe('2.1000');
});

it('applies a line discount before tax', function (): void {
    $uuid = (string) Str::uuid();

    sync([$this->fx->orderCommand($uuid, [[
        'op' => 'create',
        'uuid' => (string) Str::uuid(),
        'variant_id' => $this->fx->variant->getKey(),
        'qty' => '1',
        'price_unit' => '10.00',
        'discount' => '10',
    ]])])->assertOk();

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((string) $order->amount_untaxed)->toBe('9.0000')
        ->and((string) $order->amount_tax)->toBe('1.8900')
        ->and((string) $order->amount_discount)->toBe('1.0000');
});

it('assigns a gapless session sequence and a display name on settlement', function (): void {
    $first = (string) Str::uuid();
    $second = (string) Str::uuid();

    sync([
        $this->fx->orderCommand($first, [], ['state' => OrderState::Paid->value]),
        $this->fx->orderCommand($second, [], ['state' => OrderState::Paid->value]),
    ])->assertOk();

    $one = Order::query()->where('uuid', $first)->firstOrFail();
    $two = Order::query()->where('uuid', $second)->firstOrFail();

    expect((int) $one->sequence_number)->toBe(1)
        ->and((int) $two->sequence_number)->toBe(2)
        ->and($one->name)->toBe('Bar/00001')
        ->and($two->name)->toBe('Bar/00002');
});

it('recomputes amount_paid, change and due from the payment rows', function (): void {
    $uuid = (string) Str::uuid();

    sync([$this->fx->orderCommand($uuid, [], ['state' => OrderState::Paid->value], [
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '30.00'],
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '-5.80', 'is_change' => true],
    ])])->assertOk();

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((string) $order->amount_total)->toBe('24.2000')
        ->and((string) $order->amount_paid)->toBe('30.0000')
        ->and((string) $order->amount_change)->toBe('5.8000')
        ->and((string) $order->amount_due)->toBe('0.0000');
});

it('reroutes an order whose session closed into a rescue session', function (): void {
    $closedId = $this->fx->session->getKey();
    $this->fx->session->forceFill(['state' => SessionState::Closed->value, 'closed_at' => now()])->save();

    $uuid = (string) Str::uuid();

    $response = sync([$this->fx->orderCommand($uuid, [], ['session_id' => $closedId])]);

    $response->assertOk()->assertJsonPath('results.0.status', 'ok');

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();
    $session = PosSession::query()->findOrFail($order->pos_session_id);

    expect((int) $session->getKey())->not->toBe($closedId)
        ->and((bool) $session->is_rescue)->toBeTrue()
        ->and((string) $session->opening_notes)->toContain($uuid);

    $warning = collect($response->json('results.0.warnings'))->firstWhere('code', 'session_rescued');
    expect($warning)->not->toBeNull();

    expect(DB::table('sync_conflicts')
        ->where('record_uuid', $uuid)
        ->where('conflict_type', SyncConflictType::ClosedSession->value)
        ->where('resolution', 'rerouted')
        ->count())->toBe(1);
});

it('prefers another open session over creating a rescue session', function (): void {
    $closedId = $this->fx->session->getKey();
    $this->fx->session->forceFill(['state' => SessionState::Closed->value, 'closed_at' => now()])->save();

    $reopened = PosSession::query()->create([
        'uuid' => (string) Str::uuid(),
        'pos_config_id' => $this->fx->config->getKey(),
        'company_id' => $this->fx->company->getKey(),
        'currency_id' => $this->fx->currency->getKey(),
        'name' => 'Bar/00002',
        'state' => SessionState::Opened->value,
        'opened_at' => now(),
        'business_date' => now()->toDateString(),
    ]);

    $uuid = (string) Str::uuid();

    sync([$this->fx->orderCommand($uuid, [], ['session_id' => $closedId])])->assertOk();

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((int) $order->pos_session_id)->toBe($reopened->getKey());
});

it('supersedes a stale draft push against an already settled order', function (): void {
    $uuid = (string) Str::uuid();

    sync([$this->fx->orderCommand($uuid, [], ['state' => OrderState::Paid->value])])->assertOk();

    $response = sync([$this->fx->orderCommand($uuid, [], ['state' => OrderState::Draft->value])]);

    $response->assertOk()->assertJsonPath('results.0.status', 'superseded');

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();
    expect($order->state->value)->toBe(OrderState::Paid->value);
});

it('does not let one poisoned order block the rest of the batch', function (): void {
    $good = (string) Str::uuid();
    $bad = (string) Str::uuid();

    $response = sync([
        $this->fx->orderCommand($bad, [[
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'variant_id' => 999999, // no such variant
            'qty' => '1',
        ]]),
        $this->fx->orderCommand($good),
    ]);

    $response->assertOk();

    $results = collect($response->json('results'))->keyBy('uuid');

    expect($results[$good]['status'])->toBe('ok')
        ->and($results[$bad]['lines'][0]['status'])->toBe('rejected')
        ->and($results[$bad]['lines'][0]['code'])->toBe('unknown_variant');

    expect(Order::query()->where('uuid', $good)->exists())->toBeTrue();
});

it('deletes a draft on delete_draft and refuses to delete a settled order', function (): void {
    $uuid = (string) Str::uuid();

    sync([$this->fx->orderCommand($uuid)])->assertOk();

    sync([['uuid' => $uuid, 'op' => 'delete_draft', 'order' => []]])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    expect(Order::query()->where('uuid', $uuid)->exists())->toBeFalse();

    $settled = (string) Str::uuid();
    sync([$this->fx->orderCommand($settled, [], ['state' => OrderState::Paid->value])])->assertOk();

    sync([['uuid' => $settled, 'op' => 'delete_draft', 'order' => ['state' => OrderState::Paid->value]]])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'superseded');

    expect(Order::query()->where('uuid', $settled)->exists())->toBeTrue();
});

it('records the request in sync_requests with a payload hash', function (): void {
    $uuid = (string) Str::uuid();
    $key = (string) Str::uuid();

    sync([$this->fx->orderCommand($uuid)], ['Idempotency-Key' => $key])->assertOk();

    $row = DB::table('sync_requests')->where('request_uuid', $key)->first();

    expect($row)->not->toBeNull()
        ->and($row->endpoint)->toBe('pos.sync')
        ->and($row->response_status)->toBe(200)
        ->and($row->processed_at)->not->toBeNull()
        ->and(json_decode((string) $row->record_uuids, true))->toContain($uuid);
});

// ── commands[] on the sync endpoint (BAN-404) ─────────────────────────────────

it('accepts a commands-only batch and applies cash, partner and prep side effects', function (): void {
    // The offline kitchen send targets an order that must already exist server-side.
    $orderUuid = (string) Str::uuid();
    sync([$this->fx->orderCommand($orderUuid)])->assertOk();
    $order = Order::query()->where('uuid', $orderUuid)->firstOrFail();

    $session = $this->fx->session;
    $partnerUuid = (string) Str::uuid();

    $response = pushBatch([
        command('session.cash_move', ['uuid' => (string) Str::uuid(), 'session_id' => $session->getKey(), 'movement_type' => 'cash_in', 'amount' => '50.00', 'reason' => 'float top-up', 'employee_id' => $this->fx->cashier->getKey()]),
        command('session.cash_move', ['uuid' => (string) Str::uuid(), 'session_id' => $session->getKey(), 'movement_type' => 'cash_out', 'amount' => '20.00', 'reason' => 'supplier', 'employee_id' => $this->fx->cashier->getKey()]),
        command('partner.create', ['id' => -1712345678, 'uuid' => $partnerUuid, 'name' => 'Chez Fatima', 'email' => 'fatima@example.test']),
        command('prep.sent', ['order_uuid' => $orderUuid, 'snapshot_version' => 0, 'course_index' => null]),
    ]);

    // No 422, no quarantine — every command comes back ok.
    $response->assertOk();
    expect($response->json('results'))->toHaveCount(4)
        ->and(collect($response->json('results'))->pluck('status')->unique()->values()->all())->toBe(['ok']);

    // (a) cash in + cash out landed as signed rows.
    $movements = CashMovement::query()->where('pos_session_id', $session->getKey())->get();
    expect($movements)->toHaveCount(2)
        ->and((float) $movements->firstWhere('movement_type', CashMovementType::CashIn)->amount)->toBe(50.0)
        ->and((float) $movements->firstWhere('movement_type', CashMovementType::CashOut)->amount)->toBe(-20.0);

    // (b) the offline customer exists with a real positive id, and the result maps its uuid → id.
    $customer = Customer::query()->where('uuid', $partnerUuid)->firstOrFail();
    expect($customer->getKey())->toBeGreaterThan(0)
        ->and($customer->name)->toBe('Chez Fatima');

    $partnerResult = collect($response->json('results'))->firstWhere('partner.uuid', $partnerUuid);
    expect($partnerResult)->not->toBeNull()
        ->and($partnerResult['partner']['id'])->toBe($customer->getKey());

    // (c) the prep snapshot advanced.
    expect($order->fresh()->last_prep_sent_at)->not->toBeNull();
});

it('is idempotent on a repeated cash-move command', function (): void {
    $session = $this->fx->session;
    $moveUuid = (string) Str::uuid();
    $cmd = command('session.cash_move', ['uuid' => $moveUuid, 'session_id' => $session->getKey(), 'movement_type' => 'cash_in', 'amount' => '15.00', 'employee_id' => $this->fx->cashier->getKey()]);

    pushBatch([$cmd])->assertOk();
    pushBatch([$cmd])->assertOk();

    expect(CashMovement::query()->where('uuid', $moveUuid)->count())->toBe(1);
});

it('reconciles an offline customer id referenced by an order in the same batch', function (): void {
    $partnerUuid = (string) Str::uuid();
    $placeholderId = -1712345999;
    $orderUuid = (string) Str::uuid();

    $response = pushBatch(
        [command('partner.create', ['id' => $placeholderId, 'uuid' => $partnerUuid, 'name' => 'Walk-in Ahmed'])],
        [$this->fx->orderCommand($orderUuid, [], ['customer_id' => $placeholderId])],
    );

    $response->assertOk();

    $customer = Customer::query()->where('uuid', $partnerUuid)->firstOrFail();
    $order = Order::query()->where('uuid', $orderUuid)->firstOrFail();

    // The negative placeholder was rewritten to the real customer — no FK violation.
    expect((int) $order->customer_id)->toBe($customer->getKey())
        ->and($order->customer_id)->toBeGreaterThan(0);
});

it('drops an unresolved placeholder customer id to null rather than violating the FK', function (): void {
    $orderUuid = (string) Str::uuid();

    // No partner.create in the batch: the negative id cannot resolve.
    pushBatch([], [$this->fx->orderCommand($orderUuid, [], ['customer_id' => -999999])])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    expect(Order::query()->where('uuid', $orderUuid)->firstOrFail()->customer_id)->toBeNull();
});

it('nulls a placeholder when the order arrives in a later batch than partner.create (known cross-batch gap)', function (): void {
    $partnerUuid = (string) Str::uuid();
    $placeholderId = -1712340000;

    // Batch 1: create the customer only.
    pushBatch([command('partner.create', ['id' => $placeholderId, 'uuid' => $partnerUuid, 'name' => 'Later Order'])])->assertOk();
    $customer = Customer::query()->where('uuid', $partnerUuid)->firstOrFail();

    // Batch 2: an order references the placeholder, but no partner.create rides along, so the
    // in-batch map is empty. The client now remaps its local id on the partner.create result
    // (issue #7), so this path is the server-side safety net: an *un*remapped placeholder is dropped
    // to null rather than allowed to violate the FK. The customer still exists to relink against.
    $orderUuid = (string) Str::uuid();
    pushBatch([], [$this->fx->orderCommand($orderUuid, [], ['customer_id' => $placeholderId])])
        ->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect(Order::query()->where('uuid', $orderUuid)->firstOrFail()->customer_id)->toBeNull()
        ->and($customer->getKey())->toBeGreaterThan(0);
});

it('links a later-batch order to a customer created in an earlier partner.create batch', function (): void {
    $partnerUuid = (string) Str::uuid();

    // Batch 1: create the customer offline.
    pushBatch([command('partner.create', ['id' => -1712340001, 'uuid' => $partnerUuid, 'name' => 'Repeat Customer'])])->assertOk();
    $customer = Customer::query()->where('uuid', $partnerUuid)->firstOrFail();

    // Batch 2: the client has remapped its local id, so a later order references the real (positive)
    // id — which links directly, no partner.create needed in this batch. This is the end state
    // issue #7's client remap produces.
    $orderUuid = (string) Str::uuid();
    pushBatch([], [$this->fx->orderCommand($orderUuid, [], ['customer_id' => $customer->getKey()])])
        ->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect((int) Order::query()->where('uuid', $orderUuid)->firstOrFail()->customer_id)->toBe($customer->getKey());
});

it('does not double-bump the prep snapshot on a retried prep.sent', function (): void {
    $orderUuid = (string) Str::uuid();
    sync([$this->fx->orderCommand($orderUuid)])->assertOk();
    $order = Order::query()->where('uuid', $orderUuid)->firstOrFail();

    // The same outbox entry (same command uuid) drained twice — a network retry after the first 200.
    $cmd = command('prep.sent', ['order_uuid' => $orderUuid, 'snapshot_version' => 0, 'course_index' => null]);

    pushBatch([$cmd])->assertOk();
    $afterFirst = (int) DB::table('order_preparation_snapshots')->where('pos_order_id', $order->getKey())->value('server_version');

    pushBatch([$cmd])->assertOk();
    $afterRetry = (int) DB::table('order_preparation_snapshots')->where('pos_order_id', $order->getKey())->value('server_version');

    expect($afterRetry)->toBe($afterFirst);
});

/**
 * BAN-431 (REG-073, KDS-006) — variant options chosen on a line must survive ingest: the
 * `no_variant` attribute values land in the pivot, custom text lands in its own table, and the
 * kitchen ticket is rebuilt from those structured options rather than `full_product_name` alone.
 */
it('persists attribute selections and custom values and shows them on the kitchen ticket', function (): void {
    $this->fx->withPrepDisplay();
    $chocolate = $this->fx->attributeOption('Chocolate', '2.00');
    $message = $this->fx->attributeOption('Message');

    $uuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    sync([$this->fx->orderCommand($uuid, [[
        'op' => 'create',
        'uuid' => $lineUuid,
        'variant_id' => $this->fx->variant->getKey(),
        'qty' => '1',
        'price_unit' => '20.00',
        'discount' => '0',
        'full_product_name' => 'Cake',
        'attribute_line_value_ids' => [$chocolate],
        'custom_attribute_values' => [
            ['uuid' => (string) Str::uuid(), 'value_id' => $message, 'custom_value' => 'Happy Birthday'],
        ],
    ]])])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $lineId = (int) DB::table('pos_order_lines')->where('uuid', $lineUuid)->value('id');

    // Both join tables are written, and the option's price_extra is frozen onto the pivot.
    $pivot = DB::table('pos_order_line_attribute_value')->where('pos_order_line_id', $lineId)->get();
    expect($pivot)->toHaveCount(1)
        ->and((int) $pivot[0]->product_attribute_line_value_id)->toBe($chocolate)
        ->and((float) $pivot[0]->price_extra)->toBe(2.0)
        ->and(DB::table('pos_order_line_custom_attribute_values')
            ->where('pos_order_line_id', $lineId)
            ->where('product_attribute_line_value_id', $message)
            ->where('custom_value', 'Happy Birthday')
            ->exists())->toBeTrue();

    // The kitchen ticket text carries the options.
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    $displayName = (string) DB::table('prep_order_lines')->value('display_name');
    expect($displayName)->toContain('Chocolate')->toContain('Happy Birthday');
});

it('drops an attribute id that belongs to another product', function (): void {
    // An option defined on the *drink* product, sent on a line for the pizza variant. It exists,
    // so the FK would accept it, but it is not this product's option — it must not be persisted.
    $foreign = $this->fx->attributeOption('Sirop', '0', $this->fx->drink->getKey());

    $uuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    sync([$this->fx->orderCommand($uuid, [[
        'op' => 'create', 'uuid' => $lineUuid, 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        'attribute_line_value_ids' => [$foreign],
    ]])])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $lineId = (int) DB::table('pos_order_lines')->where('uuid', $lineUuid)->value('id');
    expect(DB::table('pos_order_line_attribute_value')->where('pos_order_line_id', $lineId)->count())->toBe(0);
});

it('drops an unknown attribute id rather than failing the whole order', function (): void {
    $uuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    sync([$this->fx->orderCommand($uuid, [[
        'op' => 'create',
        'uuid' => $lineUuid,
        'variant_id' => $this->fx->variant->getKey(),
        'qty' => '1',
        'price_unit' => '10.00',
        'discount' => '0',
        'attribute_line_value_ids' => [999999], // does not exist
    ]])])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $lineId = (int) DB::table('pos_order_lines')->where('uuid', $lineUuid)->value('id');
    expect(DB::table('pos_order_line_attribute_value')->where('pos_order_line_id', $lineId)->count())->toBe(0);
});

it('replaces a line’s options when it is resent (edit)', function (): void {
    $keep = $this->fx->attributeOption('Vanilla');
    $swap = $this->fx->attributeOption('Chocolate');

    $uuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    sync([$this->fx->orderCommand($uuid, [[
        'op' => 'create', 'uuid' => $lineUuid, 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        'attribute_line_value_ids' => [$keep],
    ]])])->assertOk();

    // Resend the same line naming a different option.
    sync([$this->fx->orderCommand($uuid, [[
        'op' => 'update', 'uuid' => $lineUuid, 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '1', 'attribute_line_value_ids' => [$swap],
    ]])])->assertOk();

    $lineId = (int) DB::table('pos_order_lines')->where('uuid', $lineUuid)->value('id');
    $ids = DB::table('pos_order_line_attribute_value')->where('pos_order_line_id', $lineId)
        ->pluck('product_attribute_line_value_id')->map(fn ($v) => (int) $v)->all();

    expect($ids)->toBe([$swap]);
});

/**
 * BAN-492 — the sync path looked an order up by uuid alone, then wrote to whatever it found.
 *
 * Any paired device could therefore mutate any draft order in the database — any venue, any tenant
 * — by pushing a uuid it had merely observed. The read paths already scoped (spec §0.5); this one
 * did not, and nothing tested it.
 */
it('refuses to mutate an order belonging to another register', function (): void {
    $other = PosFixtures::make()->withSession();

    $victimUuid = (string) Str::uuid();
    $this->withHeaders($other->headers())->postJson('/api/pos/sync', [
        'orders' => [$other->orderCommand($victimUuid)],
    ])->assertOk();

    $victim = Order::query()->where('uuid', $victimUuid)->firstOrFail();
    $before = OrderLine::query()->where('pos_order_id', $victim->getKey())->count();

    // This fixture's device pushes an edit to the other venue's order.
    $response = $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($victimUuid, [], ['state' => OrderState::Cancelled->value])],
    ]);

    $response->assertOk()
        ->assertJsonPath('results.0.status', 'rejected')
        ->assertJsonPath('results.0.error.code', 'order_not_writable');

    $victim->refresh();

    expect($victim->state->value)->toBe(OrderState::Draft->value)
        ->and((int) $victim->pos_config_id)->toBe($other->config->getKey())
        ->and(OrderLine::query()->where('pos_order_id', $victim->getKey())->count())->toBe($before);

    // The attempt is recorded, not just refused.
    expect(DB::table('sync_conflicts')->where('conflict_type', SyncConflictType::UuidCollision->value)->count())->toBe(1);
});

it('refuses a second till in the same venue that is not a trusted peer', function (): void {
    // The realistic attack, and the one the cross-tenant test above cannot reach: two configs in
    // one company — a chain, or a second till at the same bar — with no trusted pairing. The
    // `company_id` half of the guard passes here, so only the config-set half can reject it.
    $sibling = PosConfig::query()->create([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Terrace till',
        'access_token' => PosConfig::newAccessToken(),
        'currency_id' => $this->fx->currency->getKey(),
        'is_restaurant' => true,
        'limited_product_count' => 100,
        'limited_customer_count' => 20,
    ]);

    $victim = Order::query()->create([
        'uuid' => (string) Str::uuid(),
        'pos_config_id' => $sibling->getKey(),
        'company_id' => $this->fx->company->getKey(),
        'currency_id' => $this->fx->currency->getKey(),
        'pos_session_id' => $this->fx->session->getKey(),
        'access_token' => (string) Str::uuid(),
        'state' => OrderState::Draft->value,
        'ordered_at' => now(),
    ]);

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand((string) $victim->uuid, [], ['state' => OrderState::Cancelled->value])],
    ])->assertOk()
        ->assertJsonPath('results.0.status', 'rejected')
        ->assertJsonPath('results.0.error.code', 'order_not_writable');

    $victim->refresh();

    expect($victim->state->value)->toBe(OrderState::Draft->value)
        ->and(OrderLine::query()->where('pos_order_id', $victim->getKey())->count())->toBe(0);
});

it('still lets a trusted peer register sync a shared open order', function (): void {
    // Trusted configs exist to "share open orders": the bootstrap and the delta both ship a peer's
    // drafts to this till, so it will sync changes back. Scoping the lookup to `pos_config_id`
    // alone — the obvious one-line fix — would break multi-till service.
    $peer = PosConfig::query()->create([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Terrace till',
        'access_token' => PosConfig::newAccessToken(),
        'currency_id' => $this->fx->currency->getKey(),
        'is_restaurant' => true,
        'limited_product_count' => 100,
        'limited_customer_count' => 20,
    ]);

    $this->fx->config->trustedConfigs()->syncWithoutDetaching([$peer->getKey()]);

    // An order opened on the peer till.
    $shared = Order::query()->create([
        'uuid' => (string) Str::uuid(),
        'pos_config_id' => $peer->getKey(),
        'company_id' => $this->fx->company->getKey(),
        'currency_id' => $this->fx->currency->getKey(),
        'pos_session_id' => $this->fx->session->getKey(),
        'access_token' => (string) Str::uuid(),
        'state' => OrderState::Draft->value,
        'ordered_at' => now(),
    ]);

    // A waiter picks it up on this till and adds a round.
    $response = $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand((string) $shared->uuid)],
    ]);

    $response->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect(OrderLine::query()->where('pos_order_id', $shared->getKey())->count())->toBe(1);
});

it('lets a trusted peer fire a shared order to the kitchen, and refuses a stranger', function (): void {
    // `prep.sent` used to scope to `pos_config_id` alone, so a waiter who picked up a peer's order
    // on this till could add to it but not fire it — the two write paths disagreeing about whose
    // order it is (BAN-492).
    $makeConfig = fn (string $name): PosConfig => PosConfig::query()->create([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'name' => $name,
        'access_token' => PosConfig::newAccessToken(),
        'currency_id' => $this->fx->currency->getKey(),
        'is_restaurant' => true,
        'limited_product_count' => 100,
        'limited_customer_count' => 20,
    ]);

    $peer = $makeConfig('Terrace till');
    $stranger = $makeConfig('Other bar');
    $this->fx->config->trustedConfigs()->syncWithoutDetaching([$peer->getKey()]);

    $orderOn = function (PosConfig $config): Order {
        $order = Order::query()->create([
            'uuid' => (string) Str::uuid(),
            'pos_config_id' => $config->getKey(),
            'company_id' => $this->fx->company->getKey(),
            'currency_id' => $this->fx->currency->getKey(),
            'pos_session_id' => $this->fx->session->getKey(),
            'access_token' => (string) Str::uuid(),
            'state' => OrderState::Draft->value,
            'ordered_at' => now(),
        ]);

        return $order;
    };

    $shared = $orderOn($peer);
    $foreign = $orderOn($stranger);

    pushBatch([command('prep.sent', ['order_uuid' => (string) $shared->uuid, 'snapshot_version' => 0, 'course_index' => null])])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    expect($shared->fresh()->last_prep_sent_at)->not->toBeNull();

    // The stranger's order is not this register's to fire, and it is not told that it exists.
    pushBatch([command('prep.sent', ['order_uuid' => (string) $foreign->uuid, 'snapshot_version' => 0, 'course_index' => null])])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'rejected')
        ->assertJsonPath('results.0.error.code', 'unknown_order');

    expect($foreign->fresh()->last_prep_sent_at)->toBeNull();
});

it('does not link a combo child to a parent line on another order', function (): void {
    // `combo_parent_uuid` resolved through a database-wide line lookup, so a crafted uuid could
    // point a line at a parent belonging to someone else's order (BAN-492).
    $otherUuid = (string) Str::uuid();
    $parentLineUuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($otherUuid, [[
            'op' => 'create',
            'uuid' => $parentLineUuid,
            'variant_id' => $this->fx->variant->getKey(),
            'qty' => '1',
            'price_unit' => '10.00',
            'discount' => '0',
        ]])],
    ])->assertOk();

    $childUuid = (string) Str::uuid();
    $mineUuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($mineUuid, [[
            'op' => 'create',
            'uuid' => $childUuid,
            'variant_id' => $this->fx->variant->getKey(),
            'qty' => '1',
            'price_unit' => '10.00',
            'discount' => '0',
            'combo_parent_uuid' => $parentLineUuid,
        ]])],
    ])->assertOk();

    // The line is created, but unparented — it never reaches across to the other order.
    expect(DB::table('pos_order_lines')->where('uuid', $childUuid)->value('combo_parent_line_id'))->toBeNull();
});

/**
 * BAN-492 — the child-uuid reach-across, found while reviewing the order-level guard.
 *
 * `applyPaymentCommands` wrote through `updateOrCreate(['uuid' => $uuid], …)`, matching globally.
 * The order-level guard never sees this: the order being written is legitimately the caller's, and
 * the foreign row is reached by *payment* uuid.
 */
it('refuses to adopt a payment row belonging to another order', function (): void {
    $victimFx = PosFixtures::make()->withSession();

    $victimOrderUuid = (string) Str::uuid();
    $paymentUuid = (string) Str::uuid();

    $this->withHeaders($victimFx->headers())->postJson('/api/pos/sync', [
        'orders' => [$victimFx->orderCommand($victimOrderUuid, [], ['state' => OrderState::Paid->value], [[
            'op' => 'create', 'uuid' => $paymentUuid,
            'payment_method_id' => $victimFx->cash->getKey(), 'amount' => '24.20',
        ]])],
    ])->assertOk();

    $victim = Order::query()->where('uuid', $victimOrderUuid)->firstOrFail();

    // My own order — legitimately mine — whose payment command reuses the victim's payment uuid.
    $mineUuid = (string) Str::uuid();
    $response = $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($mineUuid, [], [], [[
            'op' => 'create', 'uuid' => $paymentUuid,
            'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '0.01',
        ]])],
    ]);

    $response->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect(collect($response->json('results.0.payments'))->pluck('code')->all())
        ->toContain('payment_not_writable');

    // The victim's payment is untouched: same order, same amount, still settling that order.
    $payment = Payment::query()->where('uuid', $paymentUuid)->firstOrFail();
    $mine = Order::query()->where('uuid', $mineUuid)->firstOrFail();

    expect((int) $payment->pos_order_id)->toBe((int) $victim->getKey())
        ->and((float) $payment->amount)->toBe(24.20)
        ->and((float) $victim->fresh()->amount_paid)->toBe(24.20)
        // …and my order gained nothing.
        ->and(Payment::query()->where('pos_order_id', $mine->getKey())->count())->toBe(0);
});

it('refuses to adopt a course row belonging to another order', function (): void {
    $firstUuid = (string) Str::uuid();
    $courseUuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [[
            ...$this->fx->orderCommand($firstUuid),
            'courses' => [['op' => 'create', 'uuid' => $courseUuid, 'index' => 1, 'name' => 'Starters']],
        ]],
    ])->assertOk();

    $first = Order::query()->where('uuid', $firstUuid)->firstOrFail();

    $secondUuid = (string) Str::uuid();
    $response = $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [[
            ...$this->fx->orderCommand($secondUuid),
            'courses' => [['op' => 'create', 'uuid' => $courseUuid, 'index' => 1, 'name' => 'Stolen']],
        ]],
    ]);

    $response->assertOk();

    expect(collect($response->json('results.0.courses'))->pluck('code')->all())
        ->toContain('course_not_writable');

    expect((int) DB::table('restaurant_order_courses')->where('uuid', $courseUuid)->value('pos_order_id'))
        ->toBe((int) $first->getKey())
        ->and((string) DB::table('restaurant_order_courses')->where('uuid', $courseUuid)->value('name'))
        ->toBe('Starters');
});

// ── XCT-107 — who decides what a line costs ──────────────────────────────────

/**
 * BAN-502.
 *
 * The register resolved prices client-side and the server stored what it was handed. The
 * `client_total_mismatch` warning was never a control on this: it compares the client's total
 * against the server's recomputation *of the client's own prices*, so a till that agrees with
 * itself — a bug, a stale pricelist, a crafted payload — passed in silence. A EUR 10 pizza pushed at
 * EUR 0.01 was charged at EUR 0.01, with no warning at all.
 *
 * What makes this a behavioural change rather than a bug fix is that a client-set price is often the
 * *right* answer on a till. These pin which cases are which.
 */

/** One line command, spelled out, so a test can vary exactly one field. */
function priced(PosFixtures $fx, array $overrides = []): array
{
    return [
        'op' => 'create',
        'uuid' => (string) Str::uuid(),
        'variant_id' => $fx->variant->getKey(),
        'qty' => '1',
        'price_unit' => '10.00',
        'discount' => '0',
        ...$overrides,
    ];
}

/** Ring up one line and return the order it landed on. */
function ringOneLine(PosFixtures $fx, array $line, array $order = []): Order
{
    $uuid = (string) Str::uuid();

    sync([$fx->orderCommand($uuid, [$line], $order)])->assertOk()->assertJsonPath('results.0.status', 'ok');

    return Order::query()->where('uuid', $uuid)->firstOrFail();
}

it('prices a catalog line itself and ignores what the client sent', function (): void {
    // The pizza is 10.00 in the catalogue. The till says one cent.
    $order = ringOneLine($this->fx, priced($this->fx, ['price_unit' => '0.01']));

    expect((string) OrderLine::query()->where('pos_order_id', $order->getKey())->value('price_unit'))
        ->toBe('10.0000')
        ->and((string) $order->amount_total)->toBe('12.1000');
});

it('does not warn about a price it simply overruled', function (): void {
    // Ignored, not flagged: the client's number never reaches the money, so there is nothing for a
    // manager to triage. Warnings are for divergences that stand.
    $uuid = (string) Str::uuid();

    $warnings = sync([$this->fx->orderCommand($uuid, [priced($this->fx, ['price_unit' => '0.01'])])])
        ->assertOk()->json('results.0.warnings');

    expect(collect($warnings)->pluck('code')->all())->not->toContain('price_override_refused');
});

it('honours a manual override on a register that does not restrict price control', function (): void {
    // The default configuration, and the till's own rule (`NumpadPanel`): with price control
    // unrestricted, typing a price is an ordinary part of the job.
    $order = ringOneLine($this->fx, priced($this->fx, ['price_unit' => '7.50', 'price_type' => 'manual']));

    expect((string) OrderLine::query()->where('pos_order_id', $order->getKey())->value('price_unit'))
        ->toBe('7.5000');
});

it('refuses an override the pushing employee is not entitled to make', function (): void {
    // With `restrict_price_control` on, a hand-typed price is a manager's action. A cashier's push
    // is corrected to the catalogue price — not rejected, because a rejected *line* is invisible to
    // the client (it reads the order's status) and the sale would proceed with the line silently
    // missing. Corrected is money-safe and shows up in the response.
    $this->fx->config->forceFill(['restrict_price_control' => true])->save();

    $uuid = (string) Str::uuid();

    $response = sync([$this->fx->orderCommand($uuid, [
        priced($this->fx, ['price_unit' => '0.01', 'price_type' => 'manual']),
    ])])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((string) OrderLine::query()->where('pos_order_id', $order->getKey())->value('price_unit'))
        ->toBe('10.0000');

    expect(collect($response->json('results.0.warnings'))->pluck('code')->all())
        ->toContain('price_override_refused');

    // …and it is recorded for triage rather than only echoed back.
    expect(DB::table('sync_conflicts')->where('record_uuid', $uuid)->count())->toBeGreaterThan(0);
});

it('honours the same override from an employee who holds the ability', function (): void {
    $this->fx->config->forceFill(['restrict_price_control' => true])->save();

    $uuid = (string) Str::uuid();

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'employee_id' => $this->fx->manager->getKey(),
        'orders' => [$this->fx->orderCommand($uuid, [
            priced($this->fx, ['price_unit' => '7.50', 'price_type' => 'manual']),
        ])],
    ])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((string) OrderLine::query()->where('pos_order_id', $order->getKey())->value('price_unit'))
        ->toBe('7.5000');
});

it('lets an open-price product be priced by anyone, restricted or not', function (): void {
    // A deposit or a zero-priced product: the prompt *is* the price and the catalogue has nothing to
    // overrule it with. The till sends these as `manual` too, so without the product-level exemption
    // a restricted register could not sell one at all.
    $this->fx->config->forceFill(['restrict_price_control' => true])->save();
    $this->fx->product->forceFill(['list_price' => '0'])->save();
    $this->fx->variant->forceFill(['list_price' => '0'])->save();

    $order = ringOneLine($this->fx, priced($this->fx, ['price_unit' => '3.00', 'price_type' => 'manual']));

    expect((string) OrderLine::query()->where('pos_order_id', $order->getKey())->value('price_unit'))
        ->toBe('3.0000');
});

it('still prices a weighed line from the catalogue', function (): void {
    // The scale sets the *quantity*, not the price — the unit price stays the catalogue's, so a
    // weighed line needs no exemption at all. 2.5 kg of a 10.00/kg product is 25.00 net.
    $this->fx->product->forceFill(['to_weight' => true])->save();

    $order = ringOneLine($this->fx, priced($this->fx, ['qty' => '2.5', 'price_unit' => '10.00']));

    expect((string) $order->amount_untaxed)->toBe('25.0000');
});

it('derives the option surcharge from the options, not from the client', function (): void {
    // `price_extra` is the sum of the chosen options' own extras and nothing else. The server
    // already wrote the real per-option amounts into the pivot and charged the client's figure
    // beside them, so a line could claim a discount the catalogue never gave.
    $optionId = $this->fx->attributeOption('Extra cheese', '2.00');

    $honest = ringOneLine($this->fx, priced($this->fx, [
        'price_extra' => '2.00', 'attribute_line_value_ids' => [$optionId],
    ]));

    $lying = ringOneLine($this->fx, priced($this->fx, [
        'price_extra' => '0', 'attribute_line_value_ids' => [$optionId],
    ]));

    expect((string) $honest->amount_total)->toBe('14.5200')
        ->and((string) $lying->amount_total)->toBe('14.5200');

    // …and a surcharge with no option behind it is fiction, whatever the client claims.
    $invented = ringOneLine($this->fx, priced($this->fx, ['price_extra' => '-9.00']));

    expect((string) $invented->amount_total)->toBe('12.1000');
});

it('will not let an update reprice a line the create was not allowed to price', function (): void {
    // Otherwise the check on create is a formality: ring it up honestly, then edit the price.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    sync([$this->fx->orderCommand($orderUuid, [priced($this->fx, ['uuid' => $lineUuid])])])->assertOk();

    sync([$this->fx->orderCommand($orderUuid, [
        ['op' => 'update', 'uuid' => $lineUuid, 'price_unit' => '0.01'],
    ])])->assertOk();

    expect((string) OrderLine::query()->where('uuid', $lineUuid)->value('price_unit'))->toBe('10.0000');
});

it('credits a refund at what the original line was actually charged', function (): void {
    // The cap (BAN-406) bounds how *many* units come back and says nothing about the rate, so one
    // unit of a cheap line could be credited at any price at all.
    $this->fx->config->forceFill(['restrict_price_control' => false])->save();

    $saleUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    sync([$this->fx->orderCommand($saleUuid, [
        priced($this->fx, ['uuid' => $lineUuid, 'qty' => '1', 'price_unit' => '4.00', 'price_type' => 'manual']),
    ], ['state' => OrderState::Paid->value])])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $refundUuid = (string) Str::uuid();
    $refundLine = (string) Str::uuid();

    sync([$this->fx->orderCommand($refundUuid, [[
        'op' => 'create', 'uuid' => $refundLine, 'variant_id' => $this->fx->variant->getKey(),
        'qty' => '-1', 'price_unit' => '500.00', 'discount' => '0', 'refunded_line_uuid' => $lineUuid,
    ]], ['is_refund' => true, 'refunded_order_uuid' => $saleUuid])])
        ->assertOk()->assertJsonPath('results.0.status', 'ok');

    // 4.00 was charged, so 4.00 comes back — never the 500.00 the push asked for.
    expect((string) OrderLine::query()->where('uuid', $refundLine)->value('price_unit'))->toBe('4.0000');
});

it('charges a register combo exactly what the kiosk charges for it', function (): void {
    // The parity that matters: `ComboCartPricer` was written for the kiosk in BAN-470 and the
    // register priced combos client-side, so the same meal could cost two different amounts
    // depending on which screen rang it up.
    $combo = DB::table('combos')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Pick a drink', 'base_price' => '4.00', 'qty_free' => 1, 'qty_max' => 1,
        'sequence' => 10, 'active' => true, 'created_at' => now(), 'updated_at' => now(),
    ]);
    $item = DB::table('combo_items')->insertGetId([
        'combo_id' => $combo,
        'product_variant_id' => $this->fx->drinkVariant->getKey(),
        'extra_price' => '0', 'sequence' => 10, 'created_at' => now(), 'updated_at' => now(),
    ]);

    $orderUuid = (string) Str::uuid();
    $parentUuid = (string) Str::uuid();
    $childUuid = (string) Str::uuid();

    // The till sends the components at their own list prices, which is the overcharge SLF-030 named.
    sync([$this->fx->orderCommand($orderUuid, [
        [
            'op' => 'create', 'uuid' => $parentUuid,
            'variant_id' => $this->fx->variant->getKey(), 'qty' => '1',
            'price_unit' => '10.00', 'discount' => '0',
        ],
        [
            'op' => 'create', 'uuid' => $childUuid,
            'variant_id' => $this->fx->drinkVariant->getKey(), 'qty' => '1',
            'price_unit' => '2.50', 'discount' => '0',
            'combo_parent_uuid' => $parentUuid, 'combo_item_id' => $item,
        ],
    ])])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $order = Order::query()->where('uuid', $orderUuid)->firstOrFail();

    // All of the money rides on the children, exactly as on the kiosk path.
    expect((float) OrderLine::query()->where('uuid', $parentUuid)->value('price_unit'))->toBe(0.0)
        ->and((float) OrderLine::query()->where('uuid', $childUuid)->value('price_unit'))->toBe(10.0);

    // 10.00 + 21 % — not 12.50 + tax, which is what the components at list would have produced.
    expect((float) $order->amount_total)->toBe(12.10);
});

it('does not charge a combo upgrade twice', function (): void {
    // The child's price already carries its attribute extra: `ComboCartPricer` folds it in before
    // distributing, so a `price_extra` column beside it would bill the paid upgrade a second time.
    $combo = DB::table('combos')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Pick a drink', 'base_price' => '4.00', 'qty_free' => 1, 'qty_max' => 1,
        'sequence' => 10, 'active' => true, 'created_at' => now(), 'updated_at' => now(),
    ]);
    $item = DB::table('combo_items')->insertGetId([
        'combo_id' => $combo,
        'product_variant_id' => $this->fx->drinkVariant->getKey(),
        'extra_price' => '0', 'sequence' => 10, 'created_at' => now(), 'updated_at' => now(),
    ]);

    // "Make it a large" on the drink inside the meal, worth 2.00.
    $optionId = $this->fx->attributeOption('Large', '2.00', $this->fx->drink->getKey());

    $orderUuid = (string) Str::uuid();
    $parentUuid = (string) Str::uuid();
    $childUuid = (string) Str::uuid();

    sync([$this->fx->orderCommand($orderUuid, [
        [
            'op' => 'create', 'uuid' => $parentUuid,
            'variant_id' => $this->fx->variant->getKey(), 'qty' => '1',
            'price_unit' => '10.00', 'discount' => '0',
        ],
        [
            'op' => 'create', 'uuid' => $childUuid,
            'variant_id' => $this->fx->drinkVariant->getKey(), 'qty' => '1',
            'price_unit' => '2.50', 'discount' => '0',
            'combo_parent_uuid' => $parentUuid, 'combo_item_id' => $item,
            'attribute_line_value_ids' => [$optionId],
        ],
    ])])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $child = OrderLine::query()->where('uuid', $childUuid)->firstOrFail();

    // 10.00 meal + 2.00 upgrade, all of it inside the unit price and none of it beside it.
    expect((string) $child->price_unit)->toBe('12.0000')
        ->and((string) $child->price_extra)->toBe('0.0000');

    // 12.00 + 21 % — not 14.00 + 21 %, which is the upgrade counted twice.
    expect((float) Order::query()->where('uuid', $orderUuid)->value('amount_total'))->toBe(14.52);
});

it('keeps combo pricing when a later push carries only one child', function (): void {
    // The register normally re-pushes an order whole, but nothing in the contract requires it. Priced
    // from the push alone, a child arriving on its own has no parent in view and is repriced as a
    // loose product at list — which is both a mispricing and a way around combo pricing altogether.
    $combo = DB::table('combos')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Pick a drink', 'base_price' => '4.00', 'qty_free' => 1, 'qty_max' => 1,
        'sequence' => 10, 'active' => true, 'created_at' => now(), 'updated_at' => now(),
    ]);
    $item = DB::table('combo_items')->insertGetId([
        'combo_id' => $combo,
        'product_variant_id' => $this->fx->drinkVariant->getKey(),
        'extra_price' => '0', 'sequence' => 10, 'created_at' => now(), 'updated_at' => now(),
    ]);

    $orderUuid = (string) Str::uuid();
    $parentUuid = (string) Str::uuid();
    $childUuid = (string) Str::uuid();

    sync([$this->fx->orderCommand($orderUuid, [
        [
            'op' => 'create', 'uuid' => $parentUuid,
            'variant_id' => $this->fx->variant->getKey(), 'qty' => '1',
            'price_unit' => '10.00', 'discount' => '0',
        ],
        [
            'op' => 'create', 'uuid' => $childUuid,
            'variant_id' => $this->fx->drinkVariant->getKey(), 'qty' => '1',
            'price_unit' => '2.50', 'discount' => '0',
            'combo_parent_uuid' => $parentUuid, 'combo_item_id' => $item,
        ],
    ])])->assertOk();

    expect((string) OrderLine::query()->where('uuid', $childUuid)->value('price_unit'))->toBe('10.0000');

    // The child alone, naming no parent — the meal is only visible in what the order already holds.
    sync([$this->fx->orderCommand($orderUuid, [
        ['op' => 'update', 'uuid' => $childUuid, 'qty' => '1'],
    ])])->assertOk();

    expect((string) OrderLine::query()->where('uuid', $childUuid)->value('price_unit'))->toBe('10.0000')
        ->and((float) Order::query()->where('uuid', $orderUuid)->value('amount_total'))->toBe(12.10);
});

it('will not let a partial update strip a line out of its combo', function (): void {
    // The narrower version of the same dodge: a push that names the line and its price but leaves
    // out `combo_parent_uuid`. Priced from the command alone the line looks like a loose drink, and
    // repricing it at list is exactly the meal-deal reversal BAN-470 fixed for the kiosk.
    $combo = DB::table('combos')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Pick a drink', 'base_price' => '4.00', 'qty_free' => 1, 'qty_max' => 1,
        'sequence' => 10, 'active' => true, 'created_at' => now(), 'updated_at' => now(),
    ]);
    $item = DB::table('combo_items')->insertGetId([
        'combo_id' => $combo,
        'product_variant_id' => $this->fx->drinkVariant->getKey(),
        'extra_price' => '0', 'sequence' => 10, 'created_at' => now(), 'updated_at' => now(),
    ]);

    $orderUuid = (string) Str::uuid();
    $parentUuid = (string) Str::uuid();
    $childUuid = (string) Str::uuid();

    sync([$this->fx->orderCommand($orderUuid, [
        [
            'op' => 'create', 'uuid' => $parentUuid,
            'variant_id' => $this->fx->variant->getKey(), 'qty' => '1',
            'price_unit' => '10.00', 'discount' => '0',
        ],
        [
            'op' => 'create', 'uuid' => $childUuid,
            'variant_id' => $this->fx->drinkVariant->getKey(), 'qty' => '1',
            'price_unit' => '2.50', 'discount' => '0',
            'combo_parent_uuid' => $parentUuid, 'combo_item_id' => $item,
        ],
    ])])->assertOk();

    // Names the variant and a price, says nothing about the meal it belongs to.
    sync([$this->fx->orderCommand($orderUuid, [[
        'op' => 'update', 'uuid' => $childUuid,
        'variant_id' => $this->fx->drinkVariant->getKey(),
        'qty' => '1', 'price_unit' => '2.50',
    ]])])->assertOk();

    expect((string) OrderLine::query()->where('uuid', $childUuid)->value('price_unit'))->toBe('10.0000')
        ->and((float) Order::query()->where('uuid', $orderUuid)->value('amount_total'))->toBe(12.10);
});

it('still warns when a client-priced line disagrees with the client own total', function (): void {
    // The mismatch warning keeps its job for the cases that stay client-priced — it is simply no
    // longer the only thing standing between a device and the price of a pizza.
    $uuid = (string) Str::uuid();

    $response = sync([$this->fx->orderCommand(
        $uuid,
        [priced($this->fx, ['price_unit' => '7.50', 'price_type' => 'manual'])],
        ['amount_total_client' => '99.99'],
    )])->assertOk();

    expect(collect($response->json('results.0.warnings'))->pluck('code')->all())
        ->toContain('client_total_mismatch');
});
