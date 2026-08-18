<?php

declare(strict_types=1);

namespace Tests\Feature\Kitchen\CourseFire;

use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Restaurant\OrderCourse;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession()->withFloor()->withPrepDisplay();
});

/** An order on table one with `$count` lines, each a distinct quantity. */
function orderWithLines(PosFixtures $fx, int $count): array
{
    $orderUuid = (string) Str::uuid();
    $lines = [];

    for ($i = 0; $i < $count; $i++) {
        $lines[] = [
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'variant_id' => $fx->variant->getKey(),
            'qty' => (string) ($i + 2),
            'price_unit' => '10.00',
            'discount' => '0',
        ];
    }

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($orderUuid, $lines, ['table_id' => $fx->tableOne->getKey()])],
    ])->assertOk();

    return [$orderUuid, array_column($lines, 'uuid')];
}

function makeCourse(PosFixtures $fx, string $orderUuid, string $name): string
{
    return (string) test()->withHeaders($fx->headers())
        ->postJson("/api/pos/orders/{$orderUuid}/courses", ['name' => $name])
        ->assertCreated()
        ->json('uuid');
}

function putLineOnCourse(string $lineUuid, string $courseUuid): void
{
    OrderLine::query()
        ->where('uuid', $lineUuid)
        ->update(['restaurant_course_id' => (int) OrderCourse::query()->where('uuid', $courseUuid)->value('id')]);
}

function sendWholeOrder(PosFixtures $fx, string $orderUuid): TestResponse
{
    return test()->withHeaders($fx->headers())
        ->postJson("/api/pos/orders/{$orderUuid}/preparation", ['employee_id' => null]);
}

function firedByIndex(string $orderUuid): array
{
    $orderId = (int) Order::query()->where('uuid', $orderUuid)->value('id');

    return OrderCourse::query()
        ->where('pos_order_id', $orderId)
        ->orderBy('course_index')
        ->pluck('fired', 'course_index')
        ->map(static fn (mixed $fired): bool => (bool) $fired)
        ->all();
}

/**
 * RST-084, RST-085 (BAN-477) — a whole-order send has to stamp the courses it despatched.
 *
 * `fireCourse()` set `fired` because that is what it is for. A **whole-order** send went to the same
 * displays and the same printers and marked nothing — so the food was on the pass while the order
 * still said every course was waiting, the course tag never printed, and the next press of "fire"
 * found nothing to send and stamped the course anyway.
 *
 * The till stamps its own copy at the same moment, which is what makes the offline path work. This
 * is the half that makes it survive a reload: without it the server's answer disagreed and the first
 * refresh put every course back to unfired.
 */
it('marks the course a whole-order send despatched', function (): void {
    [$orderUuid, $lineUuids] = orderWithLines($this->fx, 1);

    $course = makeCourse($this->fx, $orderUuid, 'Starters');
    putLineOnCourse($lineUuids[0], $course);

    expect(firedByIndex($orderUuid))->toBe([1 => false]);

    sendWholeOrder($this->fx, $orderUuid)->assertOk();

    expect(firedByIndex($orderUuid))->toBe([1 => true]);
});

it('stamps every course the send actually carried', function (): void {
    [$orderUuid, $lineUuids] = orderWithLines($this->fx, 2);

    $starters = makeCourse($this->fx, $orderUuid, 'Starters');
    $mains = makeCourse($this->fx, $orderUuid, 'Mains');
    putLineOnCourse($lineUuids[0], $starters);
    putLineOnCourse($lineUuids[1], $mains);

    // One send, both courses on it — the waiter who fires everything at once on a quiet table.
    sendWholeOrder($this->fx, $orderUuid)->assertOk();

    expect(firedByIndex($orderUuid))->toBe([1 => true, 2 => true]);
});

it('leaves an empty course alone, because nobody fired it', function (): void {
    // The "add course" rule opens a trailing empty one. Marking it fired would tell the pass food is
    // coming that was never printed.
    [$orderUuid, $lineUuids] = orderWithLines($this->fx, 1);

    $starters = makeCourse($this->fx, $orderUuid, 'Starters');
    makeCourse($this->fx, $orderUuid, 'Mains');
    putLineOnCourse($lineUuids[0], $starters);

    sendWholeOrder($this->fx, $orderUuid)->assertOk();

    expect(firedByIndex($orderUuid))->toBe([1 => true, 2 => false]);
});

it('leaves the other courses fireable after a course-scoped fire', function (): void {
    // The existing guarantee (BAN-408) must survive the change above: firing one course must not
    // start stamping the rest.
    [$orderUuid, $lineUuids] = orderWithLines($this->fx, 2);

    $starters = makeCourse($this->fx, $orderUuid, 'Starters');
    $mains = makeCourse($this->fx, $orderUuid, 'Mains');
    putLineOnCourse($lineUuids[0], $starters);
    putLineOnCourse($lineUuids[1], $mains);

    test()->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$orderUuid}/courses/{$starters}/fire")
        ->assertOk()
        ->assertJsonPath('course.fired', true);

    expect(firedByIndex($orderUuid))->toBe([1 => true, 2 => false]);
});

it('does not stamp a course when the send had nothing to despatch', function (): void {
    [$orderUuid, $lineUuids] = orderWithLines($this->fx, 1);

    $course = makeCourse($this->fx, $orderUuid, 'Starters');
    putLineOnCourse($lineUuids[0], $course);

    sendWholeOrder($this->fx, $orderUuid)->assertOk();

    // A second send with no changes is a no-op, and a course somebody un-fired must stay that way
    // rather than being re-stamped by an empty delta.
    OrderCourse::query()->where('uuid', $course)->update(['fired' => false, 'fired_at' => null]);

    sendWholeOrder($this->fx, $orderUuid)->assertOk();

    expect(firedByIndex($orderUuid))->toBe([1 => false]);
});

it('leaves an order with no courses at all untouched', function (): void {
    // Every change carries course index 1 by default, whether a course exists or not — the update
    // must match no rows rather than inventing one.
    [$orderUuid] = orderWithLines($this->fx, 1);

    sendWholeOrder($this->fx, $orderUuid)->assertOk();

    expect(firedByIndex($orderUuid))->toBe([]);
});
