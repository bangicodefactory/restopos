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
