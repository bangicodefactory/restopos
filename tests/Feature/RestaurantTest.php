<?php

declare(strict_types=1);

use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Restaurant\OrderCourse;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
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
