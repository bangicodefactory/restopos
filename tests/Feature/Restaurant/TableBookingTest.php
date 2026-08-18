<?php

declare(strict_types=1);

namespace Tests\Feature\Restaurant\TableBooking;

use App\Models\Pos\Order;
use App\Models\Restaurant\Table as RestaurantTable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession()->withFloor();
});

function book(PosFixtures $fx, RestaurantTable $table, ?string $note = null): TestResponse
{
    return test()->withHeaders($fx->headers())
        ->postJson('/api/pos/tables/'.$table->uuid.'/book', $note === null ? [] : ['note' => $note]);
}

function unbook(PosFixtures $fx, RestaurantTable $table): TestResponse
{
    return test()->withHeaders($fx->headers())->postJson('/api/pos/tables/'.$table->uuid.'/unbook');
}

function bookedAt(RestaurantTable $table): ?string
{
    $value = RestaurantTable::query()->whereKey($table->getKey())->value('booked_at');

    return $value === null ? null : (string) $value;
}

/**
 * RST-059 (BAN-523) — holding a table.
 *
 * A booked table looked exactly like a free one on every screen, so the only place a reservation
 * existed was the paper book by the door — and whoever was not standing next to it seated the 20:30
 * party's table at 20:00.
 *
 * Server-side rather than local, because a booking is a claim on a shared resource: two tills
 * holding the same table from their own caches is the state this exists to prevent.
 */
it('holds a table', function (): void {
    $table = $this->fx->tableOne;

    book($this->fx, $table)->assertOk();

    expect(bookedAt($table))->not->toBeNull();
});

it('records who it is held for', function (): void {
    $table = $this->fx->tableOne;

    book($this->fx, $table, 'Benali, 4')->assertOk();

    expect(RestaurantTable::query()->whereKey($table->getKey())->value('booked_note'))->toBe('Benali, 4');
});

it('releases the hold', function (): void {
    $table = $this->fx->tableOne;

    book($this->fx, $table, 'Benali, 4')->assertOk();
    unbook($this->fx, $table)->assertOk();

    expect(bookedAt($table))->toBeNull()
        ->and(RestaurantTable::query()->whereKey($table->getKey())->value('booked_note'))->toBeNull();
});

it('does not reset the clock when a held table is booked again', function (): void {
    // The timestamp is what a waiter reads to decide whether the party is late. Re-booking — a
    // second till pressing the same button, a note being added — must not push it forward.
    $table = $this->fx->tableOne;

    book($this->fx, $table)->assertOk();
    $first = bookedAt($table);

    RestaurantTable::query()->whereKey($table->getKey())->update(['booked_at' => now()->subMinutes(30)]);
    $moved = bookedAt($table);

    book($this->fx, $table, 'Benali, 4')->assertOk();

    expect(bookedAt($table))->toBe($moved)
        ->and($first)->not->toBeNull();
});

it('holds a table that already has a bill on it', function (): void {
    // A party finishing at 20:00 on a table booked for 20:30 is the ordinary case. Refusing would
    // make the feature useless exactly when it matters.
    $table = $this->fx->tableOne;
    $uuid = (string) Str::uuid();

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        ]], ['table_id' => $table->getKey(), 'guest_count' => 2])],
    ])->assertOk();

    book($this->fx, $table)->assertOk();

    expect(bookedAt($table))->not->toBeNull()
        ->and(Order::query()->where('uuid', $uuid)->value('restaurant_table_id'))->toBe($table->getKey());
});

it('leaves the bill alone when the hold is released', function (): void {
    // Releasing a booking says the reservation is over, not that the sale is.
    $table = $this->fx->tableOne;
    $uuid = (string) Str::uuid();

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        ]], ['table_id' => $table->getKey(), 'guest_count' => 2])],
    ])->assertOk();

    book($this->fx, $table)->assertOk();
    unbook($this->fx, $table)->assertOk();

    expect((int) Order::query()->where('uuid', $uuid)->value('restaurant_table_id'))
        ->toBe((int) $table->getKey());
});

it('never holds another company table', function (): void {
    // The same boundary every other table endpoint enforces — a hold is a claim on a room this
    // device has no business in.
    $other = PosFixtures::make()->withSession()->withFloor();

    book($this->fx, $other->tableOne)->assertNotFound();

    expect(bookedAt($other->tableOne))->toBeNull();
});

it('reaches the other tills, because the hold is on the row they all read', function (): void {
    $table = $this->fx->tableOne;

    book($this->fx, $table, 'Benali, 4')->assertOk();

    $row = collect(
        test()->withHeaders($this->fx->headers())
            ->getJson('/api/pos/bootstrap')
            ->assertOk()
            ->json('data.restaurant_tables')
    )->firstWhere('id', $table->getKey());

    expect($row['booked_at'])->not->toBeNull()
        ->and($row['booked_note'])->toBe('Benali, 4');
});
