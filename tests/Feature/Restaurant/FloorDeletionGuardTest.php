<?php

declare(strict_types=1);

namespace Tests\Feature\Restaurant\FloorDeletionGuard;

use App\Models\Pos\Order;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession()->withFloor();
});

/** Put a draft order on a table. */
function occupy(PosFixtures $fx, int $tableId): string
{
    $uuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        ]], ['table_id' => $tableId, 'guest_count' => 2])],
    ])->assertOk()->assertJsonPath('results.0.status', 'ok');

    return $uuid;
}

/**
 * RST-032, RST-039 (BAN-452) — you cannot delete a table somebody is still sitting at.
 *
 * Neither destroy path checked for a live bill. Deleting an occupied table does not delete the
 * order: the row keeps a `restaurant_table_id` pointing at something that no longer exists, so the
 * floor screen cannot draw it and the ticket list — which filters by table — misses it. The money is
 * unreachable from every screen a waiter has, and **nothing says it is there**. That silence is what
 * makes it worse than an error.
 */
it('refuses to delete a floor that still has an open bill on it, and names the table', function (): void {
    occupy($this->fx, $this->fx->tableOne->getKey());

    $response = $this->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/floors/{$this->fx->floor->uuid}")
        ->assertStatus(422);

    expect($response->json('error.code'))->toBe('floor_occupied')
        // Named rather than merely refused: "you cannot delete this floor" sends a manager hunting
        // through the room; a table number is a job they can finish.
        ->and($response->json('error.tables'))->toContain((string) $this->fx->tableOne->table_number);

    expect(DB::table('restaurant_floors')->where('id', $this->fx->floor->getKey())->whereNull('deleted_at')->exists())
        ->toBeTrue();
});

it('refuses to delete an occupied table, and the order stays reachable', function (): void {
    $orderUuid = occupy($this->fx, $this->fx->tableOne->getKey());

    $this->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/tables/{$this->fx->tableOne->getKey()}")
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'table_occupied');

    // The point of the guard: the bill is still attached to a table that still exists.
    $order = Order::query()->where('uuid', $orderUuid)->firstOrFail();

    expect((int) $order->restaurant_table_id)->toBe($this->fx->tableOne->getKey())
        ->and(DB::table('restaurant_tables')->where('id', $order->restaurant_table_id)->whereNull('deleted_at')->exists())
        ->toBeTrue();
});

it('still deletes a free table', function (): void {
    // The guard has to be about occupancy, not about deletion. A manager tidying an empty room must
    // not be blocked because some *other* table is busy.
    occupy($this->fx, $this->fx->tableOne->getKey());

    $this->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/tables/{$this->fx->tableTwo->getKey()}")
        ->assertNoContent();

    expect(DB::table('restaurant_tables')->where('id', $this->fx->tableTwo->getKey())->whereNull('deleted_at')->exists())
        ->toBeFalse();
});

it('still deletes a floor once its bills are settled', function (): void {
    $orderUuid = occupy($this->fx, $this->fx->tableOne->getKey());

    Order::query()->where('uuid', $orderUuid)->update(['state' => 'paid']);

    $this->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/floors/{$this->fx->floor->uuid}")
        ->assertNoContent();
});

it('ignores a soft-deleted order, which is not money anybody is coming back for', function (): void {
    $orderUuid = occupy($this->fx, $this->fx->tableOne->getKey());

    Order::query()->where('uuid', $orderUuid)->update(['deleted_at' => now()]);

    $this->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/tables/{$this->fx->tableOne->getKey()}")
        ->assertNoContent();
});

/**
 * The binding this guard could not be tested without (BAN-452, regression from BAN-449).
 *
 * `HasUuid::resolveRouteBindingQuery` resolves uuids only, and `floor` had no `Route::bind` of its
 * own — unlike `table`, which has accepted an id all along. So `PATCH /api/pos/floors/{id}` always
 * 404'd, and the register's rename-floor and duplicate-floor never reached their controller.
 *
 * It also means BAN-449's own floor tests passed on a binding failure rather than on the ownership
 * guard they claimed to exercise: they asserted 404, and got one for the wrong reason.
 */
it('reaches a floor addressed by uuid, which is the only key that binds', function (): void {
    $this->withHeaders($this->fx->headers())
        ->patchJson("/api/pos/floors/{$this->fx->floor->uuid}", ['name' => 'Veranda'])
        ->assertOk();

    expect(DB::table('restaurant_floors')->where('id', $this->fx->floor->getKey())->value('name'))->toBe('Veranda');
});

it('does not reach a floor addressed by numeric id', function (): void {
    // Pinning the constraint that caused the bug rather than working around it. `HasUuid` binds by
    // uuid and BAN-499 deliberately kept back-office addressing uuid-only, so the fix belongs in the
    // caller: the register now sends `floor.uuid`. If a permissive binding is ever added for floors,
    // this test is where that decision should be argued.
    $this->withHeaders($this->fx->headers())
        ->patchJson("/api/pos/floors/{$this->fx->floor->getKey()}", ['name' => 'Patio'])
        ->assertNotFound();
});

it('still refuses a floor belonging to another company, now that the address actually resolves', function (): void {
    // The BAN-449 assertion, re-armed. It passed a numeric id, which *never* resolved for any floor,
    // so it returned 404 without ever reaching `assertOwnedFloor` — a green test proving nothing.
    $other = PosFixtures::make()->withFloor();

    $this->withHeaders($this->fx->headers())
        ->patchJson("/api/pos/floors/{$other->floor->uuid}", ['name' => 'Owned'])
        ->assertNotFound();

    expect(DB::table('restaurant_floors')->where('id', $other->floor->getKey())->value('name'))->not->toBe('Owned');
});

it('refuses a merged child of an occupied table (review of #66)', function (): void {
    // Two tables pushed together for a large party: the bill lives on the parent and the child
    // carries no order of its own. A naive draft lookup calls the child free and deletes it out from
    // under a seated party — the room then shows one table where there are two and the merge link
    // dangles. The bill survives, so no money is lost, which is exactly why nobody would notice.
    //
    // The docblock claimed this case was handled before the code did.
    $parent = $this->fx->tableOne;
    $child = $this->fx->tableTwo;

    DB::table('restaurant_tables')->where('id', $child->getKey())->update(['parent_id' => $parent->getKey()]);
    occupy($this->fx, $parent->getKey());

    $this->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/tables/{$child->getKey()}")
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'table_occupied');

    expect(DB::table('restaurant_tables')->where('id', $child->getKey())->whereNull('deleted_at')->exists())
        ->toBeTrue();
});

it('still deletes a linked child once the parent bill is settled', function (): void {
    // The link alone is not a reason to refuse — only a link to a table somebody is sitting at.
    $parent = $this->fx->tableOne;
    $child = $this->fx->tableTwo;

    DB::table('restaurant_tables')->where('id', $child->getKey())->update(['parent_id' => $parent->getKey()]);
    $orderUuid = occupy($this->fx, $parent->getKey());

    Order::query()->where('uuid', $orderUuid)->update(['state' => 'paid']);

    $this->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/tables/{$child->getKey()}")
        ->assertNoContent();
});
