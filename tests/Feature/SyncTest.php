<?php

declare(strict_types=1);

use App\Enums\OrderState;
use App\Enums\SessionState;
use App\Enums\SyncConflictType;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
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
