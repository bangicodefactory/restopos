<?php

declare(strict_types=1);

use App\Models\Restaurant\Table as RestaurantTable;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BOF-115 — the back-office floor editor must actually persist the plan it submits. Before this
 * landed, `FloorRequest` validated the floor's four fields only and the `tables[]` payload was
 * dropped before the controller saw it, so every layout change reverted on reload.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withFloor();
    $this->actingAs(User::factory()->create(['is_super_admin' => true]));
});

/** One table row shaped like the editor's `toTablePayload`. */
function tablePayload(array $overrides = []): array
{
    return [
        'id' => -1,
        'uuid' => 'local-1',
        'table_number' => 1,
        'name' => null,
        'shape' => 'square',
        'position_x' => '10.00',
        'position_y' => '10.00',
        'width' => '50.00',
        'height' => '50.00',
        'seats' => 2,
        'color' => null,
        'parent_id' => null,
        'active' => true,
        ...$overrides,
    ];
}

it('persists moved geometry, new tables and deletions in one save', function (): void {
    $floorId = $this->fx->floor->getKey();
    $one = $this->fx->tableOne;
    $two = $this->fx->tableTwo;

    // Move table one, add a brand-new table, and drop table two by omission.
    $response = $this->from(route('floors.edit', $this->fx->floor->uuid))->patch(route('floors.update', $this->fx->floor->uuid), [
        'name' => 'Terrace',
        'active' => true,
        'tables' => [
            tablePayload([
                'id' => $one->getKey(),
                'uuid' => (string) $one->uuid,
                'table_number' => (int) $one->table_number,
                'position_x' => '120.00',
                'position_y' => '80.00',
                'width' => '75.00',
                'height' => '60.00',
                'seats' => 6,
            ]),
            tablePayload(['id' => -1, 'table_number' => 99, 'name' => 'New']),
        ],
    ]);

    $response->assertRedirect(route('floors.edit', $this->fx->floor->uuid))->assertSessionHas('success');

    // Geometry survived.
    $one->refresh();
    expect((float) $one->position_x)->toBe(120.0)
        ->and((float) $one->position_y)->toBe(80.0)
        ->and((float) $one->width)->toBe(75.0)
        ->and((int) $one->seats)->toBe(6);

    // The new table exists on the floor with its own generated QR token.
    $created = RestaurantTable::query()->where('restaurant_floor_id', $floorId)->where('table_number', 99)->first();
    expect($created)->not->toBeNull()
        ->and(strlen((string) $created->identifier))->toBe(8);

    // The omitted table was deleted.
    $this->assertSoftDeleted('restaurant_tables', ['id' => $two->getKey()]);
});

it('never rotates a table QR token as a side effect of saving geometry', function (): void {
    $floorId = $this->fx->floor->getKey();
    $one = $this->fx->tableOne;
    $tokenBefore = (string) $one->identifier;

    $this->patch(route('floors.update', $this->fx->floor->uuid), [
        'name' => 'Terrace',
        'tables' => [
            tablePayload([
                'id' => $one->getKey(),
                'table_number' => (int) $one->table_number,
                'position_x' => '200.00',
            ]),
        ],
    ])->assertRedirect();

    expect((string) $one->refresh()->identifier)->toBe($tokenBefore);
});

it('persists a cleared name and colour rather than swallowing the null', function (): void {
    $one = $this->fx->tableOne; // starts as 'T1'
    $one->forceFill(['color' => '#dbeafe'])->save();

    $this->patch(route('floors.update', $this->fx->floor->uuid), [
        'name' => 'Terrace',
        'tables' => [
            tablePayload([
                'id' => $one->getKey(),
                'table_number' => (int) $one->table_number,
                'name' => null,
                'color' => null,
            ]),
        ],
    ])->assertRedirect();

    $one->refresh();
    expect($one->name)->toBeNull()
        ->and($one->color)->toBeNull();
    // Sanity: the clear was an update, not a delete — the table is still there.
    expect(RestaurantTable::query()->whereKey($one->getKey())->exists())->toBeTrue();
});

it('links a table to a parent created in the same save', function (): void {
    $floorId = $this->fx->floor->getKey();
    $one = $this->fx->tableOne;

    // A new table (client id -1) becomes the parent of the existing table one.
    $this->patch(route('floors.update', $this->fx->floor->uuid), [
        'name' => 'Terrace',
        'tables' => [
            tablePayload(['id' => -1, 'table_number' => 50, 'name' => 'Island']),
            tablePayload([
                'id' => $one->getKey(),
                'table_number' => (int) $one->table_number,
                'parent_id' => -1,
            ]),
        ],
    ])->assertRedirect()->assertSessionHasNoErrors();

    $parent = RestaurantTable::query()->where('restaurant_floor_id', $floorId)->where('table_number', 50)->firstOrFail();
    expect((int) $one->refresh()->parent_id)->toBe((int) $parent->getKey());
});

it('rejects a table link that forms a cycle and rolls the save back', function (): void {
    $floorId = $this->fx->floor->getKey();
    $one = $this->fx->tableOne;
    $two = $this->fx->tableTwo;

    $response = $this->from(route('floors.edit', $this->fx->floor->uuid))->patch(route('floors.update', $this->fx->floor->uuid), [
        'name' => 'Terrace',
        'tables' => [
            tablePayload(['id' => $one->getKey(), 'table_number' => (int) $one->table_number, 'parent_id' => $two->getKey()]),
            tablePayload(['id' => $two->getKey(), 'table_number' => (int) $two->table_number, 'parent_id' => $one->getKey()]),
        ],
    ]);

    $response->assertRedirect(route('floors.edit', $this->fx->floor->uuid))->assertSessionHasErrors('tables');

    // The whole save rolled back: neither parent link was written.
    expect($one->refresh()->parent_id)->toBeNull()
        ->and($two->refresh()->parent_id)->toBeNull();
});

it('rejects an invalid table instead of silently swallowing it', function (): void {
    $floorId = $this->fx->floor->getKey();
    $one = $this->fx->tableOne;

    $response = $this->from(route('floors.edit', $this->fx->floor->uuid))->patch(route('floors.update', $this->fx->floor->uuid), [
        'name' => 'Terrace',
        'tables' => [
            tablePayload(['id' => $one->getKey(), 'table_number' => (int) $one->table_number, 'shape' => 'triangle']),
        ],
    ]);

    $response->assertSessionHasErrors('tables.0.shape');
});
