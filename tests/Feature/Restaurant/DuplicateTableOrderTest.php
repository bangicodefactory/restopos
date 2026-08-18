<?php

declare(strict_types=1);

namespace Tests\Feature\Restaurant\DuplicateTableOrder;

use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession()->withFloor();
});

function pushOrder(PosFixtures $fx, string $uuid, ?int $tableId, string $qty): TestResponse
{
    return test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
            'qty' => $qty, 'price_unit' => '10.00', 'discount' => '0',
        ]], ['table_id' => $tableId, 'guest_count' => 2])],
    ]);
}

function draftsOn(int $tableId): int
{
    return Order::query()->where('restaurant_table_id', $tableId)->where('state', 'draft')->count();
}

/**
 * RST-058 (BAN-471) — two waiters opening the same table.
 *
 * `pos_orders_draft_table_unique` refused the second insert and the **whole order was rejected**:
 * `ingest_failed`, carrying a raw `SQLSTATE[23000] … UNIQUE constraint failed` string straight to
 * the client. Not a cosmetic failure — `ErrorEnvelope` classifies 23xxx as *permanent*, so the
 * outbox quarantines the push and never retries it. The second waiter's order and every line on it
 * is gone, and the only trace is a SQL statement in a log.
 *
 * The collision is now anticipated rather than hit: the incoming order is created detached from the
 * table, its children land normally, and it is folded into the sitting draft once everything has
 * arrived.
 */
it('reconciles a second order for the same table instead of losing it', function (): void {
    $table = $this->fx->tableOne->getKey();

    $first = (string) Str::uuid();
    $second = (string) Str::uuid();

    pushOrder($this->fx, $first, $table, '1')->assertOk()->assertJsonPath('results.0.status', 'ok');

    $response = pushOrder($this->fx, $second, $table, '2')->assertOk();

    // Not `rejected`, and not a SQL error.
    expect($response->json('results.0.status'))->toBe('merged')
        // The answer names the survivor, so the losing till can switch to it rather than keep
        // showing a bill that no longer exists.
        ->and($response->json('results.0.merged_into_uuid'))->toBe($first);

    expect(draftsOn($table))->toBe(1);
});

it('keeps the lines from both devices on the surviving bill', function (): void {
    // The point of merging rather than refusing: the second waiter's two drinks are on the table's
    // bill, not in a log.
    $table = $this->fx->tableOne->getKey();

    $first = (string) Str::uuid();
    pushOrder($this->fx, $first, $table, '1')->assertOk();
    pushOrder($this->fx, (string) Str::uuid(), $table, '2')->assertOk();

    $survivor = Order::query()->where('uuid', $first)->firstOrFail();

    $quantities = OrderLine::query()
        ->where('pos_order_id', $survivor->getKey())
        ->pluck('quantity')
        ->map(static fn (mixed $q): float => (float) $q)
        ->sort()
        ->values()
        ->all();

    expect($quantities)->toBe([1.0, 2.0]);
});

it('writes a reversible merge row rather than quietly absorbing the order', function (): void {
    // A reconciliation nobody can inspect or undo is indistinguishable from data loss.
    $table = $this->fx->tableOne->getKey();

    pushOrder($this->fx, (string) Str::uuid(), $table, '1')->assertOk();
    pushOrder($this->fx, (string) Str::uuid(), $table, '2')->assertOk();

    $merge = DB::table('pos_order_merges')->first();

    expect($merge)->not->toBeNull()
        ->and($merge->reverted_at)->toBeNull()
        ->and($merge->restore_payload)->not->toBeNull();
});

it('keeps the older bill as the survivor', function (): void {
    // The bill the table has been building all evening wins; the one that arrived second is the
    // addition. Reversing that would merge away the earlier waiter's work.
    $table = $this->fx->tableOne->getKey();

    $first = (string) Str::uuid();
    $second = (string) Str::uuid();

    pushOrder($this->fx, $first, $table, '1')->assertOk();
    pushOrder($this->fx, $second, $table, '2')->assertOk();

    expect(Order::query()->where('uuid', $first)->exists())->toBeTrue()
        ->and(Order::query()->where('uuid', $second)->exists())->toBeFalse();
});

it('leaves an ordinary first order on a free table alone', function (): void {
    $table = $this->fx->tableOne->getKey();

    pushOrder($this->fx, (string) Str::uuid(), $table, '1')
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    expect(DB::table('pos_order_merges')->count())->toBe(0)
        ->and(draftsOn($table))->toBe(1);
});

it('does not reconcile a counter sale, which has no table to collide on', function (): void {
    pushOrder($this->fx, (string) Str::uuid(), null, '1')->assertOk()->assertJsonPath('results.0.status', 'ok');
    pushOrder($this->fx, (string) Str::uuid(), null, '2')->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect(DB::table('pos_order_merges')->count())->toBe(0);
});

it('takes the table when the sitting bill was settled while the push was in flight', function (): void {
    // The race the other way round. If the first order is paid before the second arrives, the table
    // is free — merging into a settled bill would reopen money that is already counted.
    $table = $this->fx->tableOne->getKey();

    $first = (string) Str::uuid();
    $second = (string) Str::uuid();

    pushOrder($this->fx, $first, $table, '1')->assertOk();
    Order::query()->where('uuid', $first)->update(['state' => 'paid']);

    pushOrder($this->fx, $second, $table, '2')->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect(DB::table('pos_order_merges')->count())->toBe(0)
        ->and((int) Order::query()->where('uuid', $second)->value('restaurant_table_id'))->toBe($table);
});

it('is idempotent on a resend, which the outbox produces routinely', function (): void {
    // The same uuid arriving twice is an update, not a second bill — it must not merge itself away.
    $table = $this->fx->tableOne->getKey();
    $uuid = (string) Str::uuid();

    pushOrder($this->fx, $uuid, $table, '1')->assertOk();
    pushOrder($this->fx, $uuid, $table, '1')->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect(draftsOn($table))->toBe(1)
        ->and(DB::table('pos_order_merges')->count())->toBe(0)
        ->and(Order::query()->where('uuid', $uuid)->exists())->toBeTrue();
});
