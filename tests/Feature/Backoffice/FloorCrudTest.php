<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\FloorCrud;

use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use App\Models\Restaurant\Floor;
use App\Models\Restaurant\Table as RestaurantTable;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * A back-office user of `$fx`'s company holding `$permissions`.
 *
 * Deliberately not a super-admin: one bypasses `FloorPolicy` entirely, so a suite written on one
 * would pass with no policy at all — and it has no company of its own, which is the case `store`
 * refuses.
 *
 * @param  list<string>  $permissions
 */
function floorActor(PosFixtures $fx, array $permissions): User
{
    $role = Role::query()->create([
        'name' => 'Room manager',
        'slug' => 'room-manager-'.Str::random(6),
        'is_system' => false,
    ]);

    foreach ($permissions as $slug) {
        $permission = Permission::query()->firstOrCreate(['slug' => $slug], ['group' => 'config']);
        DB::table('permission_role')->insertOrIgnore([
            'role_id' => $role->getKey(),
            'permission_id' => $permission->getKey(),
        ]);
    }

    $user = User::factory()->create(['company_id' => $fx->company->getKey(), 'is_super_admin' => false]);
    DB::table('role_user')->insert(['role_id' => $role->getKey(), 'user_id' => $user->getKey()]);

    return $user;
}

beforeEach(function (): void {
    // A decoy venue first, so the acting company is not id 1 — otherwise a controller that hardcoded
    // `company_id => 1` would be indistinguishable from one that reads the acting user.
    PosFixtures::make();

    $this->fx = PosFixtures::make()->withSession()->withFloor();
    $this->actingAs(floorActor($this->fx, ['backoffice.access', 'restaurant.manage_floors']));
});

/** @param array<string, mixed> $payload */
function addFloor(array $payload = []): TestResponse
{
    return test()->post(route('floors.store'), ['name' => 'Terrace', ...$payload]);
}

function tableOn(PosFixtures $fx, Floor $floor, int $number): RestaurantTable
{
    return RestaurantTable::query()->create([
        'uuid' => (string) Str::uuid(),
        'restaurant_floor_id' => $floor->getKey(),
        'company_id' => $fx->company->getKey(),
        'table_number' => $number,
        'name' => 'T'.$number,
        'identifier' => Str::lower(Str::random(8)),
        'shape' => 'square',
        'position_x' => 10, 'position_y' => 10, 'width' => 50, 'height' => 50,
        'seats' => 2, 'active' => true,
    ]);
}

/**
 * BOF-116 (BAN-439) — adding and removing a dining room.
 *
 * Refusals go through `deleteJson` and are asserted on the **422**. A plain `delete()` answers a
 * `ValidationException` as a redirect when it carries no body and as JSON when it does, so the
 * transport — not the behaviour — decided what the assertion had to be. The guard fires either way;
 * this just stops the test depending on which.
 *
 * Addressed by **uuid** throughout: `HasUuid` binds routes on the uuid column, and that contract is
 * deliberate and pinned by `RouteBindingTest` (BAN-499). Passing the model to `route()` serialises
 * its numeric id instead and 404s — worth knowing before writing the next one of these.
 *
 * Floors could be renamed and recoloured; there was no create and no delete, so the list was
 * whatever the seeder produced and a venue that opened a terrace had no way to say so.
 *
 * Two of the ticket's bullets were already done and are not rebuilt here: `FloorRequest` covers the
 * whole floor-plan payload (BAN-449), and the register-side endpoints have carried an ownership
 * check since the same ticket.
 */
it('adds a room', function (): void {
    addFloor()->assertRedirect();

    expect(Floor::query()->where('name', 'Terrace')->exists())->toBeTrue();
});

it('files it against the acting company', function (): void {
    addFloor()->assertRedirect();

    expect((int) Floor::query()->where('name', 'Terrace')->value('company_id'))
        ->toBe((int) $this->fx->company->getKey());
});

it('puts a new room after the existing ones rather than on top of one', function (): void {
    // `sequence` orders the floor picker. Defaulting to the same number as an existing room makes
    // the order arbitrary, and it is the order a waiter's muscle memory uses.
    addFloor()->assertRedirect();

    $existing = (int) Floor::query()->where('name', '!=', 'Terrace')->max('sequence');

    expect((int) Floor::query()->where('name', 'Terrace')->value('sequence'))->toBeGreaterThan($existing);
});

it('honours an explicit sequence', function (): void {
    addFloor(['sequence' => 99])->assertRedirect();

    expect((int) Floor::query()->where('name', 'Terrace')->value('sequence'))->toBe(99);
});

it('needs a name', function (): void {
    test()->post(route('floors.store'), [])->assertSessionHasErrors('name');
});

it('removes an empty room', function (): void {
    addFloor()->assertRedirect();
    $floor = Floor::query()->where('name', 'Terrace')->firstOrFail();

    test()->delete(route('floors.destroy', $floor->uuid))->assertRedirect();

    expect(Floor::query()->whereKey($floor->getKey())->exists())->toBeFalse();
});

it('refuses to remove a room that still has tables, until it is confirmed', function (): void {
    // Not a formality. The tables go with it, and each carries the QR capability token printed on the
    // card at that table — re-creating the room mints new tokens and every printed QR is dead.
    addFloor()->assertRedirect();
    $floor = Floor::query()->where('name', 'Terrace')->firstOrFail();
    tableOn($this->fx, $floor, 1);

    test()->deleteJson(route('floors.destroy', $floor->uuid))->assertStatus(422);

    expect(Floor::query()->whereKey($floor->getKey())->exists())->toBeTrue();
});

it('removes it once confirmed, tables and all', function (): void {
    addFloor()->assertRedirect();
    $floor = Floor::query()->where('name', 'Terrace')->firstOrFail();
    $table = tableOn($this->fx, $floor, 1);

    test()->delete(route('floors.destroy', $floor->uuid), ['confirm' => true])->assertRedirect();

    expect(Floor::query()->whereKey($floor->getKey())->exists())->toBeFalse()
        ->and(RestaurantTable::query()->whereKey($table->getKey())->exists())->toBeFalse();
});

it('refuses outright while a bill is open on it, confirmed or not', function (): void {
    // A different refusal from the one above, and the difference is the point: deleting this strands
    // money. The order keeps a table id pointing at nothing, the floor screen cannot draw it and the
    // ticket list filters it out — the bill does not vanish, which is worse (RST-032).
    $floor = $this->fx->floor;
    $uuid = (string) Str::uuid();

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        ]], ['table_id' => $this->fx->tableOne->getKey(), 'guest_count' => 2])],
    ])->assertOk();

    test()->deleteJson(route('floors.destroy', $floor->uuid), ['confirm' => true])->assertStatus(422);

    expect(Floor::query()->whereKey($floor->getKey())->exists())->toBeTrue();
});

it('names the tables that are still open, rather than merely saying no', function (): void {
    $floor = $this->fx->floor;
    $uuid = (string) Str::uuid();

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        ]], ['table_id' => $this->fx->tableOne->getKey(), 'guest_count' => 2])],
    ])->assertOk();

    $response = test()->deleteJson(route('floors.destroy', $floor->uuid), ['confirm' => true])->assertStatus(422);

    // Named, not merely refused: "you cannot delete this floor" sends a manager hunting through the
    // room; a list of table numbers is a job they can finish.
    expect((string) json_encode($response->json()))->toContain((string) $this->fx->tableOne->table_number);
});

it('never touches another company room', function (): void {
    $other = PosFixtures::make()->withFloor();

    test()->delete(route('floors.destroy', $other->floor->uuid))->assertNotFound();
    test()->patch(route('floors.update', $other->floor->uuid), ['name' => 'Mine now'])->assertNotFound();

    expect(Floor::query()->withoutGlobalScopes()->whereKey($other->floor->getKey())->exists())->toBeTrue();
});

it('refuses a user who may not configure the venue', function (): void {
    // The policy, not the scope: this user is in the right company and simply may not add or remove
    // a room.
    addFloor()->assertRedirect();
    $floor = Floor::query()->where('name', 'Terrace')->firstOrFail();

    test()->actingAs(floorActor($this->fx, ['backoffice.access']));

    addFloor(['name' => 'Sneaky'])->assertForbidden();
    test()->delete(route('floors.destroy', $floor->uuid))->assertForbidden();
    test()->patch(route('floors.update', $floor->uuid), ['name' => 'Renamed'])->assertForbidden();

    expect(Floor::query()->where('name', 'Sneaky')->exists())->toBeFalse()
        ->and((string) Floor::query()->whereKey($floor->getKey())->value('name'))->toBe('Terrace');
});

it('takes the tables with it through the register door too', function (): void {
    // The same action, the same answer, whichever screen it came from.
    //
    // `restaurant_floor_id` is `cascadeOnDelete`, but a floor is **soft**-deleted so nothing
    // cascades. Probed before the fix: the register endpoint left two live tables pointing at a room
    // that no longer existed — still in the catalog, drawable nowhere, still holding the QR tokens
    // printed on the cards in that room (review of #78).
    $floor = $this->fx->floor;
    $floorId = (int) $floor->getKey();

    // No bills, so the room is free to go.
    test()->withHeaders($this->fx->headers())->deleteJson('/api/pos/floors/'.$floor->uuid)->assertNoContent();

    expect(RestaurantTable::query()->where('restaurant_floor_id', $floorId)->count())->toBe(0)
        ->and(Floor::query()->whereKey($floorId)->exists())->toBeFalse();
});

it('still refuses through the register door while a bill is open', function (): void {
    $floor = $this->fx->floor;
    $uuid = (string) Str::uuid();

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        ]], ['table_id' => $this->fx->tableOne->getKey(), 'guest_count' => 2])],
    ])->assertOk();

    test()->withHeaders($this->fx->headers())->deleteJson('/api/pos/floors/'.$floor->uuid)
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'floor_occupied');

    // And nothing was taken on the way out.
    expect(RestaurantTable::query()->where('restaurant_floor_id', $floor->getKey())->count())->toBeGreaterThan(0);
});
