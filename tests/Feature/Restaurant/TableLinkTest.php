<?php

declare(strict_types=1);

namespace Tests\Feature\Restaurant\TableLink;

use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Restaurant\Floor;
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

function linkTo(PosFixtures $fx, RestaurantTable $child, ?int $parentId): TestResponse
{
    return test()->withHeaders($fx->headers())->patchJson('/api/pos/tables/'.$child->uuid, [
        'restaurant_floor_id' => $child->restaurant_floor_id,
        'table_number' => $child->table_number,
        'parent_id' => $parentId,
    ]);
}

function draftOn(PosFixtures $fx, int $tableId, string $qty): string
{
    $uuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
            'qty' => $qty, 'price_unit' => '10.00', 'discount' => '0',
        ]], ['table_id' => $tableId, 'guest_count' => 2])],
    ])->assertOk();

    return $uuid;
}

/**
 * RST-050 (BAN-463) — dragging one table onto another.
 *
 * The link itself has existed in `TableService` since the floor plan landed, reachable only by a
 * hand-written PATCH. This ticket puts a gesture on it, which is the moment its guards start to
 * matter.
 */
it('links a table and moves its bill onto the parent', function (): void {
    $child = $this->fx->tableTwo;
    $parent = $this->fx->tableOne;

    $orderUuid = draftOn($this->fx, (int) $child->getKey(), '2');

    linkTo($this->fx, $child, (int) $parent->getKey())->assertOk();

    expect((int) RestaurantTable::query()->whereKey($child->getKey())->value('parent_id'))
        ->toBe((int) $parent->getKey())
        ->and((int) Order::query()->where('uuid', $orderUuid)->value('restaurant_table_id'))
        ->toBe((int) $parent->getKey());
});

it('merges the two bills when both tables are already open', function (): void {
    // The party of eight sat at two fours and both were served before anybody pushed them together.
    $parent = $this->fx->tableOne;
    $child = $this->fx->tableTwo;

    $kept = draftOn($this->fx, (int) $parent->getKey(), '1');
    draftOn($this->fx, (int) $child->getKey(), '2');

    linkTo($this->fx, $child, (int) $parent->getKey())->assertOk();

    $survivor = Order::query()->where('uuid', $kept)->firstOrFail();

    $quantities = OrderLine::query()
        ->where('pos_order_id', $survivor->getKey())
        ->pluck('quantity')
        ->map(static fn (mixed $q): float => (float) $q)
        ->sort()
        ->values()
        ->all();

    expect($quantities)->toBe([1.0, 2.0]);
});

it('unlinks by clearing the parent', function (): void {
    $child = $this->fx->tableTwo;

    linkTo($this->fx, $child, (int) $this->fx->tableOne->getKey())->assertOk();
    linkTo($this->fx, $child, null)->assertOk();

    expect(RestaurantTable::query()->whereKey($child->getKey())->value('parent_id'))->toBeNull();
});

it('refuses a self-link', function (): void {
    $table = $this->fx->tableOne;

    linkTo($this->fx, $table, (int) $table->getKey())
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'invalid_link');
});

it('refuses a cycle', function (): void {
    linkTo($this->fx, $this->fx->tableTwo, (int) $this->fx->tableOne->getKey())->assertOk();

    linkTo($this->fx, $this->fx->tableOne, (int) $this->fx->tableTwo->getKey())
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'invalid_link');
});

it('never links onto another company table', function (): void {
    // The child is ownership-checked by the route binding; the *parent* arrives in the body, and its
    // only rule was `exists:restaurant_tables,id` — which does not care whose table it is.
    //
    // `link()` does not merely set a column: it moves the child's draft onto the parent and merges
    // it into the parent's bill. Unscoped, a device could hand its own sale to another tenant, lines,
    // courses, prep snapshot and all — and be left with no bill at all.
    //
    // Probed before it was fixed: 200, and `parent_id` pointed at the other company's table.
    $other = PosFixtures::make()->withSession()->withFloor();
    $foreign = $other->tableOne;

    $theirOrder = draftOn($other, (int) $foreign->getKey(), '1');
    $ourOrder = draftOn($this->fx, (int) $this->fx->tableTwo->getKey(), '5');

    linkTo($this->fx, $this->fx->tableTwo, (int) $foreign->getKey())
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'invalid_link');

    expect(RestaurantTable::query()->whereKey($this->fx->tableTwo->getKey())->value('parent_id'))->toBeNull();

    // Our bill is still ours, and theirs never grew.
    expect((int) Order::query()->where('uuid', $ourOrder)->value('restaurant_table_id'))
        ->toBe((int) $this->fx->tableTwo->getKey());

    $theirId = (int) Order::query()->where('uuid', $theirOrder)->value('id');
    expect(OrderLine::query()->where('pos_order_id', $theirId)->count())->toBe(1);
});

it('refuses a table on a floor this device cannot reach', function (): void {
    // Same company, different room the device is not configured for — the rule `assertOwnedTable`
    // already applies to the child.
    $otherRoom = Floor::query()->create([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Cellar',
        'sequence' => 2,
        'active' => true,
    ]);

    $unreachable = RestaurantTable::query()->create([
        'uuid' => (string) Str::uuid(),
        'restaurant_floor_id' => $otherRoom->getKey(),
        'company_id' => $this->fx->company->getKey(),
        'table_number' => 99,
        'name' => 'Far',
        'identifier' => 'faraway1',
        'shape' => 'square',
        'position_x' => 10, 'position_y' => 10, 'width' => 50, 'height' => 50,
        'seats' => 2, 'active' => true,
    ]);

    linkTo($this->fx, $this->fx->tableTwo, (int) $unreachable->getKey())
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'invalid_link');
});
