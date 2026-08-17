<?php

declare(strict_types=1);

use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Restaurant\OrderCourse;
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

/** Push an order onto a table and return its uuid. */
function tableOrder(PosFixtures $fx, ?int $tableId, string $qty = '2'): string
{
    $uuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [[
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'variant_id' => $fx->variant->getKey(),
            'qty' => $qty,
            'price_unit' => '10.00',
            'discount' => '0',
        ]], ['table_id' => $tableId, 'guest_count' => 2])],
    ])->assertOk();

    return $uuid;
}

it('lists floors with their tables and the QR identifier', function (): void {
    $response = $this->withHeaders($this->fx->headers())->getJson('/api/pos/floors');

    $response->assertOk()->assertJsonCount(1, 'floors');

    expect($response->json('floors.0.name'))->toBe('Terrace')
        ->and($response->json('floors.0.tables'))->toHaveCount(2)
        ->and($response->json('floors.0.tables.0.identifier'))->toHaveLength(8);
});

it('transfers an order to an empty table', function (): void {
    $uuid = tableOrder($this->fx, $this->fx->tableOne->getKey());

    $response = $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$uuid}/transfer", ['table_id' => $this->fx->tableTwo->getKey()]);

    $response->assertOk()
        ->assertJsonPath('merged', false)
        ->assertJsonPath('order.restaurant_table_id', $this->fx->tableTwo->getKey());

    expect((int) Order::query()->where('uuid', $uuid)->value('restaurant_table_id'))
        ->toBe($this->fx->tableTwo->getKey());
});

it('refuses a self-transfer', function (): void {
    $uuid = tableOrder($this->fx, $this->fx->tableOne->getKey());

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$uuid}/transfer", ['table_id' => $this->fx->tableOne->getKey()])
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'transfer_refused');
});

it('merges into the target table order, summing guests and moving lines', function (): void {
    $source = tableOrder($this->fx, $this->fx->tableOne->getKey(), '2');
    $target = tableOrder($this->fx, $this->fx->tableTwo->getKey(), '1');

    $sourceId = (int) Order::query()->where('uuid', $source)->value('id');
    $targetId = (int) Order::query()->where('uuid', $target)->value('id');

    $response = $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$source}/transfer", ['table_id' => $this->fx->tableTwo->getKey()]);

    $response->assertOk()->assertJsonPath('merged', true);

    // The source is gone, its lines live on the target, guests add up.
    expect(Order::query()->where('uuid', $source)->exists())->toBeFalse()
        ->and(OrderLine::query()->where('pos_order_id', $targetId)->count())->toBe(2)
        ->and((int) Order::query()->whereKey($targetId)->value('guest_count'))->toBe(4);

    // …and the merge is reversible.
    $merge = DB::table('pos_order_merges')->where('source_order_id', $sourceId)->first();

    expect($merge)->not->toBeNull()
        ->and($merge->target_order_id)->toBe($targetId)
        ->and($merge->reverted_at)->toBeNull();
});

it('unmerges back onto the original table', function (): void {
    $source = tableOrder($this->fx, $this->fx->tableOne->getKey(), '2');
    tableOrder($this->fx, $this->fx->tableTwo->getKey(), '1');

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$source}/transfer", ['table_id' => $this->fx->tableTwo->getKey()])
        ->assertOk();

    $mergeId = (int) DB::table('pos_order_merges')->orderByDesc('id')->value('id');

    $response = $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/order-merges/{$mergeId}/unmerge");

    $response->assertOk()
        ->assertJsonPath('order.restaurant_table_id', $this->fx->tableOne->getKey());

    $restoredId = (int) $response->json('order.id');

    expect(OrderLine::query()->where('pos_order_id', $restoredId)->count())->toBe(1)
        ->and(DB::table('pos_order_merges')->where('id', $mergeId)->value('reverted_at'))->not->toBeNull();

    // A second unmerge is refused rather than duplicating the order.
    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/order-merges/{$mergeId}/unmerge")
        ->assertStatus(422);
});

it('carries the kitchen snapshot across a merge so nothing is re-fired', function (): void {
    $this->fx->withPrepDisplay();

    $source = tableOrder($this->fx, $this->fx->tableOne->getKey(), '2');
    $target = tableOrder($this->fx, $this->fx->tableTwo->getKey(), '1');

    // Fire both to the kitchen.
    foreach ([$source, $target] as $uuid) {
        $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();
    }

    $targetId = (int) Order::query()->where('uuid', $target)->value('id');

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$source}/transfer", ['table_id' => $this->fx->tableTwo->getKey()])
        ->assertOk();

    // After the merge the target has 3 units — and every one of them is already
    // known to the kitchen, so the delta must be empty (RST-056).
    $delta = $this->withHeaders($this->fx->headers())
        ->getJson("/api/pos/orders/{$target}/preparation-changes");

    $delta->assertOk()->assertJsonPath('nbr_of_changes', 0);
    expect($delta->json('changes'))->toBe([]);
});

it('sets the guest count', function (): void {
    $uuid = tableOrder($this->fx, $this->fx->tableOne->getKey());

    $this->withHeaders($this->fx->headers())
        ->patchJson("/api/pos/orders/{$uuid}/guests", ['guest_count' => 6])
        ->assertOk()
        ->assertJsonPath('order.guest_count', 6);
});

it('creates and fires a course', function (): void {
    $this->fx->withPrepDisplay();

    $uuid = tableOrder($this->fx, $this->fx->tableOne->getKey());

    $created = $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$uuid}/courses", ['name' => 'Starters']);

    $created->assertCreated()->assertJsonPath('course_index', 1);

    $courseUuid = $created->json('uuid');

    // Attach the existing line to the course.
    $orderId = (int) Order::query()->where('uuid', $uuid)->value('id');
    $courseId = (int) OrderCourse::query()->where('uuid', $courseUuid)->value('id');
    OrderLine::query()->where('pos_order_id', $orderId)->update(['restaurant_course_id' => $courseId]);

    $fired = $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$uuid}/courses/{$courseUuid}/fire");

    $fired->assertOk()
        ->assertJsonPath('course.fired', true)
        ->assertJsonPath('delta.nbr_of_changes', 2);

    expect(DB::table('prep_orders')->where('pos_order_id', $orderId)->count())->toBe(1);
});

it('fires each course of a multi-course order independently (BAN-408)', function (): void {
    $this->fx->withPrepDisplay();

    // Three lines, one per course, with distinct quantities so each course's delta is unmistakable.
    $orderUuid = (string) Str::uuid();
    $lineUuids = [(string) Str::uuid(), (string) Str::uuid(), (string) Str::uuid()];
    $qtys = ['2', '3', '4'];

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($orderUuid, [
            ['op' => 'create', 'uuid' => $lineUuids[0], 'variant_id' => $this->fx->variant->getKey(), 'qty' => $qtys[0], 'price_unit' => '10.00', 'discount' => '0'],
            ['op' => 'create', 'uuid' => $lineUuids[1], 'variant_id' => $this->fx->variant->getKey(), 'qty' => $qtys[1], 'price_unit' => '10.00', 'discount' => '0'],
            ['op' => 'create', 'uuid' => $lineUuids[2], 'variant_id' => $this->fx->variant->getKey(), 'qty' => $qtys[2], 'price_unit' => '10.00', 'discount' => '0'],
        ], ['table_id' => $this->fx->tableOne->getKey()])],
    ])->assertOk();

    $orderId = (int) Order::query()->where('uuid', $orderUuid)->value('id');

    // A course per line.
    $courseUuids = [];
    foreach (['Starters', 'Mains', 'Dessert'] as $i => $name) {
        $created = $this->withHeaders($this->fx->headers())
            ->postJson("/api/pos/orders/{$orderUuid}/courses", ['name' => $name]);
        $created->assertCreated();
        $courseUuids[$i] = $created->json('uuid');
        $courseId = (int) OrderCourse::query()->where('uuid', $courseUuids[$i])->value('id');
        OrderLine::query()->where('uuid', $lineUuids[$i])->update(['restaurant_course_id' => $courseId]);
    }

    // Fire each course in turn. Every fire must produce a *non-empty* delta of only that course's
    // line at its own quantity — the BAN-408 bug snapshotted all lines on the first fire, so courses
    // 2 and 3 came back empty and could never be fired.
    foreach ($qtys as $i => $qty) {
        $fired = $this->withHeaders($this->fx->headers())
            ->postJson("/api/pos/orders/{$orderUuid}/courses/{$courseUuids[$i]}/fire");

        $fired->assertOk()
            ->assertJsonPath('course.fired', true)
            ->assertJsonPath('delta.nbr_of_changes', (int) $qty);

        expect($fired->json('delta.changes'))->toHaveCount(1)
            ->and((int) $fired->json('delta.count'))->toBe((int) $qty);
    }

    expect(OrderCourse::query()->where('pos_order_id', $orderId)->where('fired', true)->count())->toBe(3);
});

it('an offline prep.sent for one course leaves the other courses fireable (issue #10)', function (): void {
    $this->fx->withPrepDisplay();

    // Two lines, one per course, distinct quantities.
    $orderUuid = (string) Str::uuid();
    $lineUuids = [(string) Str::uuid(), (string) Str::uuid()];

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($orderUuid, [
            ['op' => 'create', 'uuid' => $lineUuids[0], 'variant_id' => $this->fx->variant->getKey(), 'qty' => '2', 'price_unit' => '10.00', 'discount' => '0'],
            ['op' => 'create', 'uuid' => $lineUuids[1], 'variant_id' => $this->fx->variant->getKey(), 'qty' => '3', 'price_unit' => '10.00', 'discount' => '0'],
        ], ['table_id' => $this->fx->tableOne->getKey()])],
    ])->assertOk();

    $courseUuids = [];
    foreach (['Starters', 'Mains'] as $i => $name) {
        $created = $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$orderUuid}/courses", ['name' => $name]);
        $courseUuids[$i] = $created->json('uuid');
        $courseId = (int) OrderCourse::query()->where('uuid', $courseUuids[$i])->value('id');
        OrderLine::query()->where('uuid', $lineUuids[$i])->update(['restaurant_course_id' => $courseId]);
    }

    $orderId = (int) Order::query()->where('uuid', $orderUuid)->value('id');

    // Reconnect: an offline fire of course 1 arrives as a `prep.sent` command carrying its course_index.
    $prepSent = fn (): TestResponse => $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'commands' => [[
            'uuid' => (string) Str::uuid(),
            'kind' => 'prep.sent',
            'payload' => ['order_uuid' => $orderUuid, 'snapshot_version' => 0, 'course_index' => 1],
        ]],
    ]);

    $prepSent()->assertOk()->assertJsonPath('results.0.status', 'ok');
    $version = (int) DB::table('order_preparation_snapshots')->where('pos_order_id', $orderId)->value('server_version');

    // A retry of the same offline fire is idempotent: no re-snapshot, no version bump.
    $prepSent()->assertOk()->assertJsonPath('results.0.status', 'ok');
    expect((int) DB::table('order_preparation_snapshots')->where('pos_order_id', $orderId)->value('server_version'))->toBe($version);

    // Only course 1 was snapshotted: the remaining delta is exactly course 2's line (qty 3). The
    // pre-fix markAllSent would snapshot everything and this would be 0.
    $this->withHeaders($this->fx->headers())
        ->getJson("/api/pos/orders/{$orderUuid}/preparation-changes")
        ->assertOk()
        ->assertJsonPath('nbr_of_changes', 3);

    // And course 2 can still be fired online, producing its own delta.
    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$orderUuid}/courses/{$courseUuids[1]}/fire")
        ->assertOk()
        ->assertJsonPath('delta.nbr_of_changes', 3);
});

it('resolves two duplicate table drafts into one order on the table-open path (RST-058)', function (): void {
    $tableId = $this->fx->tableOne->getKey();

    $oldest = tableOrder($this->fx, $tableId, '2');

    // A partial unique index normally rejects a second draft on the table; drop it to reproduce the
    // offline race that slipped a duplicate past the guard — exactly what resolveDuplicateTableOrders
    // exists to clean up.
    DB::statement('DROP INDEX pos_orders_draft_table_unique');
    $newer = tableOrder($this->fx, $tableId, '3');

    expect(Order::query()->where('restaurant_table_id', $tableId)->where('state', 'draft')->count())->toBe(2);

    $response = $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/tables/{$tableId}/resolve-duplicates");

    $response->assertOk();

    // The oldest draft wins and now carries both lines; the newer draft is merged away.
    expect($response->json('order.uuid'))->toBe($oldest)
        ->and(Order::query()->where('restaurant_table_id', $tableId)->where('state', 'draft')->count())->toBe(1)
        ->and(Order::query()->where('uuid', $newer)->exists())->toBeFalse();

    $winnerId = (int) Order::query()->where('uuid', $oldest)->value('id');
    expect(OrderLine::query()->where('pos_order_id', $winnerId)->count())->toBe(2);
});

it('returns the sole draft (or null) when there is nothing to resolve on a table', function (): void {
    $tableId = $this->fx->tableOne->getKey();

    // No draft yet → null.
    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/tables/{$tableId}/resolve-duplicates")
        ->assertOk()
        ->assertJsonPath('order', null);

    // One draft → that draft, untouched.
    $only = tableOrder($this->fx, $tableId, '2');
    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/tables/{$tableId}/resolve-duplicates")
        ->assertOk()
        ->assertJsonPath('order.uuid', $only);
});

it('refuses to delete a fired course', function (): void {
    $this->fx->withPrepDisplay();

    $uuid = tableOrder($this->fx, $this->fx->tableOne->getKey());

    $courseUuid = $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$uuid}/courses", ['name' => 'Mains'])
        ->json('uuid');

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$uuid}/courses/{$courseUuid}/fire")
        ->assertOk();

    $this->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/orders/{$uuid}/courses/{$courseUuid}")
        ->assertStatus(422);
});

it('never lets a device address another register order', function (): void {
    $other = PosFixtures::make()->withSession()->withFloor();
    $foreign = tableOrder($other, $other->tableOne->getKey());

    $this->withHeaders($this->fx->headers())
        ->patchJson("/api/pos/orders/{$foreign}/guests", ['guest_count' => 3])
        ->assertStatus(404);
});

/**
 * RST-030…038 (BAN-449) — the room a device is allowed to rearrange.
 *
 * `index` has always scoped its read through `$config->floors()`. The four write endpoints scoped
 * nothing: they took a route-bound model and force-filled it, so a device token — issued per config
 * and the only credential these routes require — could move, recolour or delete **any table in the
 * database**, another company's included.
 *
 * That cost little while nothing called them from a till. The register's edit mode is what makes it
 * reachable, and the spec is explicit that "client-side ability checks are UX; the ingest check is
 * the control" — a manager-gated button with an unguarded endpoint behind it is not a control.
 */
function foreignFloorAndTable(): array
{
    // A second `make()` counts the venues already built and gives itself its own company.
    $other = PosFixtures::make()->withFloor();

    return [$other->floor->getKey(), $other->tableOne->getKey(), $other->tableOne->table_number];
}

it('refuses to move a table belonging to another company', function (): void {
    [$foreignFloor, $foreignTable, $number] = foreignFloorAndTable();

    $before = DB::table('restaurant_tables')->where('id', $foreignTable)->first();

    // 404, not 403: a device has no business learning that this id exists somewhere else.
    $this->withHeaders($this->fx->headers())
        ->patchJson("/api/pos/tables/{$foreignTable}", [
            'restaurant_floor_id' => $foreignFloor,
            'table_number' => $number,
            'position_x' => '999',
            'position_y' => '999',
        ])
        ->assertNotFound();

    $after = DB::table('restaurant_tables')->where('id', $foreignTable)->first();

    expect($after->position_x)->toBe($before->position_x)
        ->and($after->position_y)->toBe($before->position_y);
});

it('refuses to delete a table belonging to another company', function (): void {
    [, $foreignTable] = foreignFloorAndTable();

    $this->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/tables/{$foreignTable}")
        ->assertNotFound();

    expect(DB::table('restaurant_tables')->where('id', $foreignTable)->whereNull('deleted_at')->exists())->toBeTrue();
});

it('refuses to rename or delete a floor belonging to another company', function (): void {
    [$foreignFloor] = foreignFloorAndTable();

    $this->withHeaders($this->fx->headers())
        ->patchJson("/api/pos/floors/{$foreignFloor}", ['name' => 'Owned'])
        ->assertNotFound();

    $this->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/floors/{$foreignFloor}")
        ->assertNotFound();

    expect(DB::table('restaurant_floors')->where('id', $foreignFloor)->value('name'))->not->toBe('Owned');
});

it('refuses to file a new table onto another company floor', function (): void {
    [$foreignFloor] = foreignFloorAndTable();

    $this->withHeaders($this->fx->headers())
        ->postJson('/api/pos/tables', [
            'restaurant_floor_id' => $foreignFloor,
            'table_number' => 99,
            'seats' => 4,
            'shape' => 'square',
            'position_x' => '10', 'position_y' => '10', 'width' => '80', 'height' => '80',
        ])
        ->assertNotFound();

    // The two `withFloor()` built, and nothing of ours filed alongside them.
    expect(DB::table('restaurant_tables')->where('restaurant_floor_id', $foreignFloor)->count())->toBe(2);
});

it('still lets a manager rearrange its own room', function (): void {
    $tableId = $this->fx->tableOne->getKey();

    $this->withHeaders($this->fx->headers())
        ->patchJson("/api/pos/tables/{$tableId}", [
            'restaurant_floor_id' => $this->fx->floor->getKey(),
            'table_number' => $this->fx->tableOne->table_number,
            'position_x' => '340',
            'position_y' => '220',
        ])
        ->assertOk();

    $row = DB::table('restaurant_tables')->where('id', $tableId)->first();

    expect((float) $row->position_x)->toBe(340.0)
        ->and((float) $row->position_y)->toBe(220.0);
});
