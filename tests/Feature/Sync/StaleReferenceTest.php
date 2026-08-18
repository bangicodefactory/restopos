<?php

declare(strict_types=1);

namespace Tests\Feature\Sync\StaleReference;

use App\Models\Pos\Order;
use App\Models\Restaurant\Table as RestaurantTable;
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

function send(PosFixtures $fx, string $uuid, array $attributes): TestResponse
{
    return test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [[
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'variant_id' => $fx->variant->getKey(),
            'qty' => '1',
            'price_unit' => '10.00',
            'discount' => '0',
        ]], $attributes)],
    ]);
}

function tableOf(string $uuid): ?int
{
    $value = Order::query()->where('uuid', $uuid)->value('restaurant_table_id');

    return $value === null ? null : (int) $value;
}

function presetOf(string $uuid): ?int
{
    $value = Order::query()->where('uuid', $uuid)->value('pos_preset_id');

    return $value === null ? null : (int) $value;
}

function makePreset(PosFixtures $fx, string $name): int
{
    return (int) DB::table('pos_presets')->insertGetId([
        'company_id' => $fx->company->getKey(),
        'name' => $name,
        'sequence' => 10,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

/**
 * BAN-524 — a reference the server cannot use is ignored, not written.
 *
 * `resolveOwnedTable` and `resolveOwnedPreset` dropped an unusable id by setting it to null. On a
 * create that is the same as leaving it out, because the write ends in `?? null`. On an **update**
 * it is not: `updateOrder` writes any key that is present, so the null landed on the column and
 * erased what the order already had.
 *
 * No attacker is involved. A device holding a stale id after a table is deleted or moved off its
 * floors sends exactly this on its next routine push — and the register re-pushes every draft when
 * it is paid (BAN-506).
 *
 * **Every case here asserts `ok` as well as the column**, and that is the part worth explaining. An
 * id that exists nowhere violates the foreign key, so without the guard the update throws SQLSTATE
 * 23000, comes back `ingest_failed`, and the client classifies 23xxx as permanent and quarantines
 * the push. The table then survives only because the whole update was rolled back and lost.
 *
 * Asserting the column alone passes in both worlds. That is not hypothetical — the first version of
 * these tests did exactly that, and a sabotage removing half the guard cleared them.
 */
it('keeps a seated order on its table when a stale id arrives', function (): void {
    // Probed before the fix: `ok`, and the bill came back sitting on no table at all.
    $table = (int) $this->fx->tableOne->getKey();
    $uuid = (string) Str::uuid();

    send($this->fx, $uuid, ['table_id' => $table, 'guest_count' => 2])->assertOk();
    expect(tableOf($uuid))->toBe($table);

    send($this->fx, $uuid, ['table_id' => 999999])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    expect(tableOf($uuid))->toBe($table);
});

it('keeps it when the table it names has since been deleted', function (): void {
    // The realistic shape: the id was valid when the device cached it. A bill on no table is the
    // failure BAN-452 guards against from the other side — the floor screen cannot draw it and the
    // waiter cannot reach it from the room.
    $table = (int) $this->fx->tableOne->getKey();
    $uuid = (string) Str::uuid();

    send($this->fx, $uuid, ['table_id' => $table, 'guest_count' => 2])->assertOk();
    RestaurantTable::query()->whereKey($table)->delete();

    send($this->fx, $uuid, ['table_id' => $table])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    expect(tableOf($uuid))->toBe($table);
});

it('keeps it when another company table is named', function (): void {
    $other = PosFixtures::make()->withSession()->withFloor();
    $table = (int) $this->fx->tableOne->getKey();
    $uuid = (string) Str::uuid();

    send($this->fx, $uuid, ['table_id' => $table, 'guest_count' => 2])->assertOk();

    send($this->fx, $uuid, ['table_id' => (int) $other->tableOne->getKey()])->assertOk();

    expect(tableOf($uuid))->toBe($table);
});

it('guards the other spelling too, which reaches the column by a different route', function (): void {
    // `table_id` is mapped to the column by `updateOrder`'s client-key loop; `restaurant_table_id`
    // is written straight from its writable list. Two write paths, and the guard has to cover both —
    // it loops over each spelling for exactly this reason, and only one of them was covered.
    //
    // Probed with that spelling removed from the loop: `rejected`, `ingest_failed`, "FOREIGN KEY
    // constraint failed". So the guard is not only keeping the order on its table, it is keeping the
    // push out of the outbox's permanent-failure bin — which is why `ok` is asserted here.
    $table = (int) $this->fx->tableOne->getKey();
    $uuid = (string) Str::uuid();

    send($this->fx, $uuid, ['table_id' => $table, 'guest_count' => 2])->assertOk();

    send($this->fx, $uuid, ['restaurant_table_id' => 999999])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    expect(tableOf($uuid))->toBe($table);
});

it('still takes an order off its table when the client says so explicitly', function (): void {
    // The distinction that makes "ignore" safe. `isset()` is already false for null, so an explicit
    // `table_id: null` never reaches the guard — "take this order off its table" still means what it
    // says, and only "put it on a table I cannot use" is ignored.
    $table = (int) $this->fx->tableOne->getKey();
    $uuid = (string) Str::uuid();

    send($this->fx, $uuid, ['table_id' => $table, 'guest_count' => 2])->assertOk();

    send($this->fx, $uuid, ['table_id' => null])->assertOk();

    expect(tableOf($uuid))->toBeNull();
});

it('still moves an order to a table that is usable', function (): void {
    // The control: a guard that ignored every table would pass every test above.
    $uuid = (string) Str::uuid();

    send($this->fx, $uuid, ['table_id' => (int) $this->fx->tableOne->getKey(), 'guest_count' => 2])->assertOk();

    send($this->fx, $uuid, ['table_id' => (int) $this->fx->tableTwo->getKey()])->assertOk();

    expect(tableOf($uuid))->toBe((int) $this->fx->tableTwo->getKey());
});

it('creates an order on no table when the only id it names is unusable', function (): void {
    // The create-path behaviour `DuplicateTableOrderTest` pins, unchanged: with the key dropped the
    // write ends in `?? null`, which is where it landed before.
    $uuid = (string) Str::uuid();

    send($this->fx, $uuid, ['table_id' => 999999])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    expect(tableOf($uuid))->toBeNull();
});

it('keeps the service mode when a stale preset id arrives', function (): void {
    // The preset drives the kitchen ticket header and whether a cover count is asked for at all, so
    // losing it quietly changes what the pass is told.
    $preset = makePreset($this->fx, 'Dine in');
    $uuid = (string) Str::uuid();

    send($this->fx, $uuid, ['preset_id' => $preset])->assertOk();
    expect(presetOf($uuid))->toBe($preset);

    send($this->fx, $uuid, ['preset_id' => 999999])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    expect(presetOf($uuid))->toBe($preset);
});

it('still switches to a preset that is usable', function (): void {
    $first = makePreset($this->fx, 'Dine in');
    $second = makePreset($this->fx, 'Takeaway');
    $uuid = (string) Str::uuid();

    send($this->fx, $uuid, ['preset_id' => $first])->assertOk();
    send($this->fx, $uuid, ['preset_id' => $second])->assertOk();

    expect(presetOf($uuid))->toBe($second);
});
