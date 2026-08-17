<?php

declare(strict_types=1);

use App\Enums\DeviceType;
use App\Enums\PrepLineState;
use App\Enums\PrepOrderState;
use App\Enums\PrintJobState;
use App\Events\Kitchen\KitchenTicketCreated;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Pos\PosDevice;
use App\Services\Device\DeviceTokenService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession()->withFloor()->withPrepDisplay();

    // The kitchen display is its own device, with its own narrower token.
    $this->kds = PosDevice::query()->create([
        'uuid' => (string) Str::uuid(),
        'pos_config_id' => $this->fx->config->getKey(),
        'device_identifier' => 2,
        'name' => 'Pass screen',
        'device_type' => DeviceType::PrepDisplay->value,
        'active' => true,
    ]);

    $this->kdsToken = app(DeviceTokenService::class)->issue($this->kds)['token'];
    $this->kdsHeaders = ['Authorization' => 'Bearer '.$this->kdsToken, 'Accept' => 'application/json'];
});

function kitchenOrder(PosFixtures $fx, string $qty = '2'): string
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
            'note' => 'no basil',
        ]], ['table_id' => $fx->tableOne?->getKey(), 'guest_count' => 2])],
    ])->assertOk();

    return $uuid;
}

it('computes the unsent-change delta server-side', function (): void {
    $uuid = kitchenOrder($this->fx, '2');

    $response = $this->withHeaders($this->fx->headers())
        ->getJson("/api/pos/orders/{$uuid}/preparation-changes");

    $response->assertOk()
        ->assertJsonPath('nbr_of_changes', 2)
        ->assertJsonPath('count', '2.000')
        ->assertJsonPath('snapshot_version', 0)
        ->assertJsonPath('changes.0.change_type', 'new')
        ->assertJsonPath('changes.0.internal_note', 'no basil');
});

it('sends to the kitchen, then reports nothing further to send', function (): void {
    $uuid = kitchenOrder($this->fx);

    $sent = $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation");

    $sent->assertOk()
        ->assertJsonPath('snapshot_version', 1)
        ->assertJsonCount(1, 'prep_orders');

    $this->withHeaders($this->fx->headers())
        ->getJson("/api/pos/orders/{$uuid}/preparation-changes")
        ->assertOk()
        ->assertJsonPath('nbr_of_changes', 0);

    $orderId = (int) Order::query()->where('uuid', $uuid)->value('id');
    expect(DB::table('prep_orders')->where('pos_order_id', $orderId)->count())->toBe(1)
        ->and(DB::table('prep_order_lines')->count())->toBe(1);
});

it('emits only the incremental change on a second send', function (): void {
    $uuid = kitchenOrder($this->fx, '2');

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    // Bump the quantity from 2 to 5: the kitchen must be told "+3", not "5".
    $orderId = (int) Order::query()->where('uuid', $uuid)->value('id');
    OrderLine::query()->where('pos_order_id', $orderId)->update(['quantity' => '5']);

    $delta = $this->withHeaders($this->fx->headers())
        ->getJson("/api/pos/orders/{$uuid}/preparation-changes");

    $delta->assertOk()
        ->assertJsonPath('count', '3.000')
        ->assertJsonPath('changes.0.change_type', 'new')
        ->assertJsonPath('changes.0.quantity', '3.000');
});

it('reports a removal as a negative cancellation', function (): void {
    $uuid = kitchenOrder($this->fx, '2');

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    $orderId = (int) Order::query()->where('uuid', $uuid)->value('id');
    OrderLine::query()->where('pos_order_id', $orderId)->delete();

    $delta = $this->withHeaders($this->fx->headers())
        ->getJson("/api/pos/orders/{$uuid}/preparation-changes");

    $delta->assertOk()
        ->assertJsonPath('changes.0.change_type', 'cancelled')
        ->assertJsonPath('changes.0.quantity', '-2');
});

it('reports a note-only edit as a note update', function (): void {
    $uuid = kitchenOrder($this->fx, '2');

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    $orderId = (int) Order::query()->where('uuid', $uuid)->value('id');
    OrderLine::query()->where('pos_order_id', $orderId)
        ->update(['internal_note' => json_encode([['text' => 'extra basil', 'color_index' => 0]])]);

    $this->withHeaders($this->fx->headers())
        ->getJson("/api/pos/orders/{$uuid}/preparation-changes")
        ->assertOk()
        ->assertJsonPath('changes.0.change_type', 'note_update');
});

it('refuses a send whose snapshot version is behind the server (cross-device guard)', function (): void {
    $uuid = kitchenOrder($this->fx);

    // Another till already fired it, taking the snapshot to version 1.
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    $response = $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$uuid}/preparation", ['snapshot_version' => 0]);

    $response->assertStatus(409)
        ->assertJsonPath('error.code', 'order_outdated')
        ->assertJsonStructure(['error', 'delta']);

    expect(DB::table('sync_conflicts')->where('conflict_type', 'prep_snapshot_stale')->count())->toBe(1);
});

it('marks everything sent without printing (self-order path)', function (): void {
    $uuid = kitchenOrder($this->fx);

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$uuid}/preparation/mark-sent")
        ->assertOk()
        ->assertJsonPath('snapshot_version', 1);

    $this->withHeaders($this->fx->headers())
        ->getJson("/api/pos/orders/{$uuid}/preparation-changes")
        ->assertOk()
        ->assertJsonPath('nbr_of_changes', 0);

    expect(DB::table('prep_orders')->count())->toBe(0);
});

it('serves the kitchen board with stages, cards and line rows', function (): void {
    $uuid = kitchenOrder($this->fx);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    $token = $this->fx->display->access_token;

    $board = $this->withHeaders($this->kdsHeaders)->getJson("/api/kitchen/{$token}/orders");

    $board->assertOk()
        ->assertJsonPath('display.name', 'Pass')
        ->assertJsonCount(3, 'stages')
        ->assertJsonCount(1, 'orders')
        ->assertJsonPath('orders.0.state', PrepOrderState::Pending->value)
        ->assertJsonPath('orders.0.table_label', 'T1')
        ->assertJsonPath('orders.0.guest_count', 2);

    expect($board->json('orders.0.lines'))->toHaveCount(1)
        ->and($board->json('orders.0.lines.0.state'))->toBe(PrepLineState::Todo->value);
});

it('moves a card through the stages and aggregates the card state', function (): void {
    $uuid = kitchenOrder($this->fx);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    $token = $this->fx->display->access_token;
    $board = $this->withHeaders($this->kdsHeaders)->getJson("/api/kitchen/{$token}/orders");

    $prepOrderId = (int) $board->json('orders.0.id');
    $stages = collect($board->json('stages'))->keyBy('stage_type');

    $this->withHeaders($this->kdsHeaders)
        ->postJson("/api/kitchen/{$token}/orders/{$prepOrderId}/stage", ['stage_id' => $stages['in_progress']['id']])
        ->assertOk()
        ->assertJsonPath('state', PrepOrderState::InProgress->value);

    $ready = $this->withHeaders($this->kdsHeaders)
        ->postJson("/api/kitchen/{$token}/orders/{$prepOrderId}/stage", ['stage_id' => $stages['ready']['id']]);

    $ready->assertOk()->assertJsonPath('state', PrepOrderState::Ready->value);

    // The aggregate is mirrored onto the POS order so the register can read one field.
    expect(Order::query()->where('uuid', $uuid)->firstOrFail()->prep_state->value)->toBe('ready');

    // …and every transition is logged.
    expect(DB::table('prep_line_stage_logs')->count())->toBeGreaterThanOrEqual(2);
});

it('toggles a single line done and recalls the card', function (): void {
    $uuid = kitchenOrder($this->fx);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    $token = $this->fx->display->access_token;
    $board = $this->withHeaders($this->kdsHeaders)->getJson("/api/kitchen/{$token}/orders");

    $prepOrderId = (int) $board->json('orders.0.id');
    $lineId = (int) $board->json('orders.0.lines.0.id');

    $this->withHeaders($this->kdsHeaders)
        ->postJson("/api/kitchen/{$token}/lines/{$lineId}/state", ['state' => PrepLineState::Ready->value])
        ->assertOk()
        ->assertJsonPath('state', PrepOrderState::Ready->value);

    $recalled = $this->withHeaders($this->kdsHeaders)
        ->postJson("/api/kitchen/{$token}/orders/{$prepOrderId}/recall");

    $recalled->assertOk()->assertJsonPath('state', PrepOrderState::Pending->value);

    expect((bool) DB::table('prep_orders')->where('id', $prepOrderId)->value('is_recalled'))->toBeTrue();
});

it('rejects a display token from another config', function (): void {
    $other = PosFixtures::make()->withPrepDisplay();

    $this->withHeaders($this->kdsHeaders)
        ->getJson('/api/kitchen/'.$other->display->access_token.'/orders')
        ->assertStatus(404);
});

it('queues and renders preparation print jobs, then acknowledges them', function (): void {
    $printer = DB::table('pos_printers')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Kitchen printer',
        'printer_type' => 'epson_epos',
        'print_all_categories' => true,
        'characters_per_line' => 42,
        'copies' => 1,
        'active' => true,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    DB::table('pos_config_printer')->insert([
        'pos_config_id' => $this->fx->config->getKey(),
        'pos_printer_id' => $printer,
    ]);

    $this->fx->config->forceFill(['use_preparation_printers' => true])->save();

    $uuid = kitchenOrder($this->fx);

    $sent = $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation");
    $sent->assertOk();

    expect($sent->json('print_jobs'))->toHaveCount(1);

    $jobs = $this->withHeaders($this->fx->headers())->getJson('/api/kitchen/print-jobs');

    $jobs->assertOk()->assertJsonCount(1, 'jobs');

    $job = $jobs->json('jobs.0');

    expect($job['state'])->toBe(PrintJobState::Queued->value)
        ->and($job['job_type'])->toBe('prep_new')
        ->and($job['rendered_text'])->toContain('KITCHEN PRINTER')
        ->and($job['rendered_text'])->toContain('Margherita')
        ->and($job['rendered_text'])->toContain('no basil');

    $this->withHeaders($this->fx->headers())
        ->postJson('/api/kitchen/print-jobs/'.$job['id'].'/ack', ['state' => 'printed'])
        ->assertNoContent();

    expect(DB::table('preparation_print_jobs')->where('id', $job['id'])->value('state'))
        ->toBe(PrintJobState::Printed->value);
});

/**
 * KDS-004 — a combo child has no category of its own: the category lives on the combo product the
 * cashier tapped. Routing read the child's null category, matched no station, and the item was
 * never cooked — silently, because a line that routes nowhere raises nothing.
 */
it('routes a combo child with no category to its parent station', function (): void {
    // A display scoped to one category, so routing actually has to decide something.
    $display = DB::table('prep_displays')->insertGetId([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Grill',
        'access_token' => Str::lower(Str::random(32)),
        'show_all_categories' => false,
        'active' => true,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    DB::table('pos_config_prep_display')->insert([
        'pos_config_id' => $this->fx->config->getKey(),
        'prep_display_id' => $display,
    ]);
    DB::table('pos_category_prep_display')->insert([
        'prep_display_id' => $display,
        'pos_category_id' => $this->fx->category->getKey(),
    ]);
    DB::table('prep_stages')->insert([
        'prep_display_id' => $display,
        'name' => 'To do',
        'stage_type' => 'todo',
        'sequence' => 10,
        'is_default' => true,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $parentUuid = (string) Str::uuid();
    $childUuid = (string) Str::uuid();
    $orderUuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($orderUuid, [
            [
                'op' => 'create',
                'uuid' => $parentUuid,
                'variant_id' => $this->fx->variant->getKey(),
                'qty' => '1',
                'price_unit' => '10.00',
                'discount' => '0',
            ],
            [
                // The child carries no category — exactly how a combo component arrives.
                'op' => 'create',
                'uuid' => $childUuid,
                'variant_id' => $this->fx->drinkVariant->getKey(),
                'qty' => '1',
                'price_unit' => '0.00',
                'discount' => '0',
                'combo_parent_uuid' => $parentUuid,
                'pos_category_id' => null,
            ],
        ], ['table_id' => $this->fx->tableOne?->getKey(), 'guest_count' => 2])],
    ])->assertOk();

    DB::table('pos_order_lines')->where('uuid', $childUuid)->update(['pos_category_id' => null]);

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$orderUuid}/preparation")
        ->assertOk();

    $prepOrderId = DB::table('prep_orders')->where('prep_display_id', $display)->value('id');

    expect($prepOrderId)->not->toBeNull();

    $routed = DB::table('prep_order_lines')
        ->where('prep_order_id', $prepOrderId)
        ->pluck('pos_order_line_uuid')
        ->all();

    // Both halves of the combo reach the station, not just the parent.
    expect($routed)->toContain($parentUuid)
        ->and($routed)->toContain($childUuid);

    // And the child knows who its parent is, so the board can group them.
    expect(DB::table('prep_order_lines')->where('pos_order_line_uuid', $childUuid)->value('combo_parent_uuid'))
        ->toBe($parentUuid);
});

/**
 * KDS-053 — an order note is not a line, so it routes to no category and the routed set is empty
 * for every printer. `fanOutToPrinters` bailed there, so adding "no onions" after the send produced
 * zero print jobs and the kitchen never learned about it — even though the delta is non-empty.
 */
it('prints a note-update ticket when only the order note changed', function (): void {
    $printer = DB::table('pos_printers')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Kitchen printer',
        'printer_type' => 'epson_epos',
        'print_all_categories' => true,
        'characters_per_line' => 42,
        'copies' => 1,
        'active' => true,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    DB::table('pos_config_printer')->insert([
        'pos_config_id' => $this->fx->config->getKey(),
        'pos_printer_id' => $printer,
    ]);

    $this->fx->config->forceFill(['use_preparation_printers' => true])->save();

    $uuid = kitchenOrder($this->fx);

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    expect(DB::table('preparation_print_jobs')->where('job_type', 'prep_note_update')->count())->toBe(0);

    // The waiter comes back with "no onions" — nothing else about the order changes.
    Order::query()->where('uuid', $uuid)->update(['general_customer_note' => 'ALLERGY: no onions']);

    $delta = $this->withHeaders($this->fx->headers())
        ->getJson("/api/pos/orders/{$uuid}/preparation-changes")
        ->assertOk();

    // Precondition: no line changed, only the note.
    expect($delta->json('changes'))->toBe([])
        ->and($delta->json('order_note_changed'))->toBeTrue();

    $sent = $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation");
    $sent->assertOk();

    expect($sent->json('print_jobs'))->toHaveCount(1);

    $job = DB::table('preparation_print_jobs')->where('job_type', 'prep_note_update')->first();

    expect($job)->not->toBeNull()
        ->and((int) $job->pos_printer_id)->toBe($printer);

    // And the note is actually on the ticket the cook reads.
    $rendered = $this->withHeaders($this->fx->headers())->getJson('/api/kitchen/print-jobs')
        ->assertOk()
        ->json('jobs');

    $noteTicket = collect($rendered)->firstWhere('job_type', 'prep_note_update');

    expect($noteTicket)->not->toBeNull()
        ->and($noteTicket['rendered_text'])->toContain('ALLERGY: no onions');
});

it('does not print an order note to a station that never saw the order', function (): void {
    // A second printer scoped to a category this order never touches.
    $otherCategory = DB::table('pos_categories')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Bar',
        'path' => '/bar',
        'sequence' => 20,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $bar = DB::table('pos_printers')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Bar printer',
        'printer_type' => 'epson_epos',
        'print_all_categories' => false,
        'characters_per_line' => 42,
        'copies' => 1,
        'active' => true,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    DB::table('pos_config_printer')->insert([
        'pos_config_id' => $this->fx->config->getKey(),
        'pos_printer_id' => $bar,
    ]);
    DB::table('pos_category_pos_printer')->insert([
        'pos_printer_id' => $bar,
        'pos_category_id' => $otherCategory,
    ]);

    $this->fx->config->forceFill(['use_preparation_printers' => true])->save();

    $uuid = kitchenOrder($this->fx);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    Order::query()->where('uuid', $uuid)->update(['general_customer_note' => 'no onions']);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    // The bar never printed this order, so it has nothing to amend.
    expect(DB::table('preparation_print_jobs')->where('pos_printer_id', $bar)->count())->toBe(0);
});

/**
 * KDS-053, the display half (BAN-500).
 *
 * BAN-454 taught the printers that an order note routes to no category. The screens never got the
 * lesson, so `fanOutToDisplays` bailed on the empty routed set and a kitchen running on displays
 * alone — no preparation printers at all — never learned that "no onions" was added after the send.
 * The one above proves the printer path; these prove the screen.
 */
it('updates the card on a display already showing the order when only the note changed', function (): void {
    $uuid = kitchenOrder($this->fx);
    $displayId = $this->fx->display->getKey();

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    expect(DB::table('prep_orders')->where('prep_display_id', $displayId)->value('order_note'))->toBeNull();

    $lineCountBefore = DB::table('prep_order_lines')->count();

    // The waiter comes back with an allergy. No line changes.
    Order::query()->where('uuid', $uuid)->update(['general_customer_note' => 'ALLERGY: no onions']);

    $delta = $this->withHeaders($this->fx->headers())
        ->getJson("/api/pos/orders/{$uuid}/preparation-changes")
        ->assertOk();

    expect($delta->json('changes'))->toBe([])
        ->and($delta->json('order_note_changed'))->toBeTrue();

    $sent = $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    expect($sent->json('prep_orders'))->toHaveCount(1);

    expect(DB::table('prep_orders')->where('prep_display_id', $displayId)->value('order_note'))
        ->toBe('ALLERGY: no onions');

    // A note is not a line. Writing one here would put a phantom item on the cook's card.
    expect(DB::table('prep_order_lines')->count())->toBe($lineCountBefore);
});

it('broadcasts the note change so an open board re-reads it', function (): void {
    Event::fake([KitchenTicketCreated::class]);

    $uuid = kitchenOrder($this->fx);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    Event::assertDispatchedTimes(KitchenTicketCreated::class, 1);

    Order::query()->where('uuid', $uuid)->update(['general_customer_note' => 'no onions']);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    // The second event is the whole point: `ingestTicket` sees a card it already holds and pulls the
    // authoritative row, which is how the note reaches a screen nobody is going to refresh by hand.
    Event::assertDispatchedTimes(KitchenTicketCreated::class, 2);
});

it('serves the amended note to the board a cook is actually looking at', function (): void {
    // The rows above are the mechanism; this is the cook reading the screen. Fetched the way the
    // client fetches it — `store.ts` calls `api.board(display.token)` with no `since`, so a full
    // board keyed on the access token is the request that actually happens after the nudge.
    $uuid = kitchenOrder($this->fx);
    $token = $this->fx->display->access_token;

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    $this->withHeaders($this->kdsHeaders)->getJson("/api/kitchen/{$token}/orders")
        ->assertOk()
        ->assertJsonPath('orders.0.order_note', null);

    Order::query()->where('uuid', $uuid)->update(['general_customer_note' => 'ALLERGY: no onions']);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    $this->withHeaders($this->kdsHeaders)->getJson("/api/kitchen/{$token}/orders")
        ->assertOk()
        ->assertJsonCount(1, 'orders')
        ->assertJsonPath('orders.0.order_note', 'ALLERGY: no onions');
});

it('puts the note on the wire, not just in the row (review of #58)', function (): void {
    // The broadcast carried table, guests and lines but not the note — so the one thing a note-update
    // ticket exists to say was the one thing it did not say. Faked before the first send: the
    // dispatcher is constructor-injected, so a service resolved earlier keeps the real one.
    Event::fake([KitchenTicketCreated::class]);

    $uuid = kitchenOrder($this->fx);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    Order::query()->where('uuid', $uuid)->update(['general_customer_note' => 'ALLERGY: no onions']);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    Event::assertDispatched(
        KitchenTicketCreated::class,
        static fn (KitchenTicketCreated $e): bool => $e->ticket['lines'] === []
            && ($e->ticket['order_note'] ?? null) === 'ALLERGY: no onions',
    );
});

it('does not give a card to a display that never saw the order', function (): void {
    // The bar screen is scoped to a category this order never touches. BAN-454 made the same ruling
    // for printers — a station with nothing to amend gets nothing — and the two paths should agree
    // deliberately rather than by accident.
    $otherCategory = DB::table('pos_categories')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Bar',
        'path' => '/bar',
        'sequence' => 20,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $bar = DB::table('prep_displays')->insertGetId([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Bar screen',
        'access_token' => Str::lower(Str::random(32)),
        'show_all_categories' => false,
        'active' => true,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    DB::table('pos_config_prep_display')->insert([
        'pos_config_id' => $this->fx->config->getKey(),
        'prep_display_id' => $bar,
    ]);
    DB::table('pos_category_prep_display')->insert([
        'prep_display_id' => $bar,
        'pos_category_id' => $otherCategory,
    ]);

    $uuid = kitchenOrder($this->fx);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    expect(DB::table('prep_orders')->where('prep_display_id', $bar)->count())->toBe(0);

    Order::query()->where('uuid', $uuid)->update(['general_customer_note' => 'no onions']);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    expect(DB::table('prep_orders')->where('prep_display_id', $bar)->count())->toBe(0);
});

it('routes a cancelled combo child to the station that was cooking it', function (): void {
    // Deleting a line builds its cancellation from the snapshot, so the snapshot has to carry the
    // inherited category — otherwise the cancellation routes nowhere and the station keeps cooking.
    $display = DB::table('prep_displays')->insertGetId([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Grill',
        'access_token' => Str::lower(Str::random(32)),
        'show_all_categories' => false,
        'active' => true,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    DB::table('pos_config_prep_display')->insert([
        'pos_config_id' => $this->fx->config->getKey(),
        'prep_display_id' => $display,
    ]);
    DB::table('pos_category_prep_display')->insert([
        'prep_display_id' => $display,
        'pos_category_id' => $this->fx->category->getKey(),
    ]);
    DB::table('prep_stages')->insert([
        'prep_display_id' => $display,
        'name' => 'To do',
        'stage_type' => 'todo',
        'sequence' => 10,
        'is_default' => true,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $parentUuid = (string) Str::uuid();
    $childUuid = (string) Str::uuid();
    $orderUuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($orderUuid, [
            ['op' => 'create', 'uuid' => $parentUuid, 'variant_id' => $this->fx->variant->getKey(), 'qty' => '1', 'price_unit' => '10.00', 'discount' => '0'],
            ['op' => 'create', 'uuid' => $childUuid, 'variant_id' => $this->fx->drinkVariant->getKey(), 'qty' => '1', 'price_unit' => '0.00', 'discount' => '0', 'combo_parent_uuid' => $parentUuid],
        ], ['table_id' => $this->fx->tableOne?->getKey(), 'guest_count' => 2])],
    ])->assertOk();

    DB::table('pos_order_lines')->where('uuid', $childUuid)->update(['pos_category_id' => null]);

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$orderUuid}/preparation")->assertOk();

    // The child is struck off after the send.
    DB::table('pos_order_lines')->where('uuid', $childUuid)->update(['deleted_at' => now()]);

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$orderUuid}/preparation")->assertOk();

    $prepOrderId = DB::table('prep_orders')->where('prep_display_id', $display)->value('id');

    $cancellation = DB::table('prep_order_lines')
        ->where('prep_order_id', $prepOrderId)
        ->where('pos_order_line_uuid', $childUuid)
        ->where('change_type', 'cancelled')
        ->first();

    expect($cancellation)->not->toBeNull()
        ->and($cancellation->combo_parent_uuid)->toBe($parentUuid);
});

/** A category-scoped grill station, so routing has to actually decide something. */
function grillDisplay(PosFixtures $fx): int
{
    $display = DB::table('prep_displays')->insertGetId([
        'uuid' => (string) Str::uuid(),
        'company_id' => $fx->company->getKey(),
        'name' => 'Grill',
        'access_token' => Str::lower(Str::random(32)),
        'show_all_categories' => false,
        'active' => true,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    DB::table('pos_config_prep_display')->insert([
        'pos_config_id' => $fx->config->getKey(),
        'prep_display_id' => $display,
    ]);
    DB::table('pos_category_prep_display')->insert([
        'prep_display_id' => $display,
        'pos_category_id' => $fx->category->getKey(),
    ]);
    DB::table('prep_stages')->insert([
        'prep_display_id' => $display,
        'name' => 'To do',
        'stage_type' => 'todo',
        'sequence' => 10,
        'is_default' => true,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return $display;
}

it('inherits through a combo nested inside a combo', function (): void {
    $display = grillDisplay($this->fx);

    $rootUuid = (string) Str::uuid();
    $midUuid = (string) Str::uuid();
    $leafUuid = (string) Str::uuid();
    $orderUuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($orderUuid, [
            ['op' => 'create', 'uuid' => $rootUuid, 'variant_id' => $this->fx->variant->getKey(), 'qty' => '1', 'price_unit' => '10.00', 'discount' => '0'],
            ['op' => 'create', 'uuid' => $midUuid, 'variant_id' => $this->fx->drinkVariant->getKey(), 'qty' => '1', 'price_unit' => '0.00', 'discount' => '0', 'combo_parent_uuid' => $rootUuid],
            ['op' => 'create', 'uuid' => $leafUuid, 'variant_id' => $this->fx->drinkVariant->getKey(), 'qty' => '1', 'price_unit' => '0.00', 'discount' => '0', 'combo_parent_uuid' => $midUuid],
        ], ['table_id' => $this->fx->tableOne?->getKey(), 'guest_count' => 2])],
    ])->assertOk();

    // Only the root owns a category — the walk has to climb two levels to find it.
    DB::table('pos_order_lines')->whereIn('uuid', [$midUuid, $leafUuid])->update(['pos_category_id' => null]);

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$orderUuid}/preparation")->assertOk();

    $prepOrderId = DB::table('prep_orders')->where('prep_display_id', $display)->value('id');

    $routed = DB::table('prep_order_lines')->where('prep_order_id', $prepOrderId)->pluck('pos_order_line_uuid')->all();

    expect($routed)->toContain($rootUuid)->toContain($midUuid)->toContain($leafUuid);
});

it('inherits past a parent that is not itself prepared', function (): void {
    // A combo parent flagged skip_preparation is absent from the delta entirely. Resolving ancestry
    // from the delta alone would leave its children with nothing to inherit — uncooked again.
    $display = grillDisplay($this->fx);

    $parentUuid = (string) Str::uuid();
    $childUuid = (string) Str::uuid();
    $orderUuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($orderUuid, [
            ['op' => 'create', 'uuid' => $parentUuid, 'variant_id' => $this->fx->variant->getKey(), 'qty' => '1', 'price_unit' => '10.00', 'discount' => '0'],
            ['op' => 'create', 'uuid' => $childUuid, 'variant_id' => $this->fx->drinkVariant->getKey(), 'qty' => '1', 'price_unit' => '0.00', 'discount' => '0', 'combo_parent_uuid' => $parentUuid],
        ], ['table_id' => $this->fx->tableOne?->getKey(), 'guest_count' => 2])],
    ])->assertOk();

    DB::table('pos_order_lines')->where('uuid', $childUuid)->update(['pos_category_id' => null]);
    DB::table('pos_order_lines')->where('uuid', $parentUuid)->update(['skip_preparation' => true]);

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$orderUuid}/preparation")->assertOk();

    $prepOrderId = DB::table('prep_orders')->where('prep_display_id', $display)->value('id');
    $routed = DB::table('prep_order_lines')->where('prep_order_id', $prepOrderId)->pluck('pos_order_line_uuid')->all();

    // The parent is not cooked; the child still is.
    expect($routed)->toContain($childUuid)
        ->and($routed)->not->toContain($parentUuid);
});

/**
 * KDS-016, end to end — the acceptance criterion itself: cancel a line, serve the rest, and the
 * card reaches "served" with no cook interaction on the cancelled row.
 *
 * The unit tests over `board.ts` cannot prove this. `prep_orders.state` is recomputed server-side
 * on every line move, persisted and broadcast, and the client assigns that state verbatim — so a
 * client-only fix is overwritten the moment the cook touches anything.
 */
it('lets a card reach served after a line is cancelled, with no cook interaction on it', function (): void {
    $lineUuid = (string) Str::uuid();
    $orderUuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($orderUuid, [
            ['op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(), 'qty' => '1', 'price_unit' => '10.00', 'discount' => '0'],
            ['op' => 'create', 'uuid' => $lineUuid, 'variant_id' => $this->fx->drinkVariant->getKey(), 'qty' => '1', 'price_unit' => '2.50', 'discount' => '0'],
        ], ['table_id' => $this->fx->tableOne?->getKey(), 'guest_count' => 2])],
    ])->assertOk();

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$orderUuid}/preparation")->assertOk();

    // The customer changes their mind about the drink after it has been sent.
    DB::table('pos_order_lines')->where('uuid', $lineUuid)->update(['deleted_at' => now()]);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$orderUuid}/preparation")->assertOk();

    $token = $this->fx->display->access_token;
    $board = $this->withHeaders($this->kdsHeaders)->getJson("/api/kitchen/{$token}/orders");
    $prepOrderId = (int) $board->json('orders.0.id');

    // The cancellation is on the card as a todo row — that is how the kitchen is told to stop.
    $cancellation = DB::table('prep_order_lines')
        ->where('prep_order_id', $prepOrderId)
        ->where('change_type', 'cancelled')
        ->first();

    expect($cancellation)->not->toBeNull()
        ->and((string) $cancellation->state)->toBe(PrepLineState::Todo->value);

    // The cook serves every line that is actually food, and touches nothing else.
    foreach (DB::table('prep_order_lines')
        ->where('prep_order_id', $prepOrderId)
        ->where('change_type', '!=', 'cancelled')
        ->pluck('id') as $lineId) {
        $this->withHeaders($this->kdsHeaders)
            ->postJson("/api/kitchen/{$token}/lines/{$lineId}/state", ['state' => PrepLineState::Served->value])
            ->assertOk();
    }

    expect(DB::table('prep_orders')->where('id', $prepOrderId)->value('state'))
        ->toBe(PrepOrderState::Served->value);

    // The cancellation row was never touched.
    expect((string) DB::table('prep_order_lines')->where('id', $cancellation->id)->value('state'))
        ->toBe(PrepLineState::Todo->value);
});

it('does not drag a cancellation along when the card is bumped or recalled', function (): void {
    // The client skips cancellations in `applyStageLocally` / `applyRecallLocally`. The server has
    // to agree: it broadcasts the authoritative line states, so a client-only skip is overwritten.
    $lineUuid = (string) Str::uuid();
    $orderUuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($orderUuid, [
            ['op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(), 'qty' => '1', 'price_unit' => '10.00', 'discount' => '0'],
            ['op' => 'create', 'uuid' => $lineUuid, 'variant_id' => $this->fx->drinkVariant->getKey(), 'qty' => '1', 'price_unit' => '2.50', 'discount' => '0'],
        ], ['table_id' => $this->fx->tableOne?->getKey(), 'guest_count' => 2])],
    ])->assertOk();

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$orderUuid}/preparation")->assertOk();

    DB::table('pos_order_lines')->where('uuid', $lineUuid)->update(['deleted_at' => now()]);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$orderUuid}/preparation")->assertOk();

    $token = $this->fx->display->access_token;
    $board = $this->withHeaders($this->kdsHeaders)->getJson("/api/kitchen/{$token}/orders");
    $prepOrderId = (int) $board->json('orders.0.id');
    $stages = collect($board->json('stages'))->keyBy('stage_type');

    $cancellationId = (int) DB::table('prep_order_lines')
        ->where('prep_order_id', $prepOrderId)
        ->where('change_type', 'cancelled')
        ->value('id');

    // Bump the whole card to ready.
    $this->withHeaders($this->kdsHeaders)
        ->postJson("/api/kitchen/{$token}/orders/{$prepOrderId}/stage", ['stage_id' => $stages['ready']['id']])
        ->assertOk()
        ->assertJsonPath('state', PrepOrderState::Ready->value);

    // "Don't make this" was not marked ready.
    expect((string) DB::table('prep_order_lines')->where('id', $cancellationId)->value('state'))
        ->toBe(PrepLineState::Todo->value);

    // Recalling reopens the food, and must not resurrect the cancellation as work either.
    $this->withHeaders($this->kdsHeaders)
        ->postJson("/api/kitchen/{$token}/orders/{$prepOrderId}/recall")
        ->assertOk();

    expect((string) DB::table('prep_order_lines')->where('id', $cancellationId)->value('state'))
        ->toBe(PrepLineState::Todo->value)
        ->and(DB::table('prep_line_stage_logs')->where('prep_order_line_id', $cancellationId)->count())
        ->toBe(0);
});

/**
 * KDS-055 / KDS-005 (BAN-485) — the service mode, on the card and on the ticket.
 *
 * `prep_orders.preset_label` and `customer_name` were inserted as literal `null`, and the board has
 * rendered both since it was built: `TicketCard` falls back through
 * `table_label ?? preset_label ?? "takeaway"` and shows the customer as a badge. Every counter order
 * therefore read as a generic takeaway with nobody's name on it — a declared contract with no
 * supplier, which is this repo's most common defect shape.
 */
function takeawayPreset(PosFixtures $fx, string $name = 'Takeaway'): int
{
    return DB::table('pos_presets')->insertGetId([
        'company_id' => $fx->company->getKey(),
        'name' => $name,
        'service_at' => 'counter',
        'identification' => 'none',
        'sequence' => 10,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

it('puts the service mode and the customer on the kitchen card', function (): void {
    $preset = takeawayPreset($this->fx);
    $customer = DB::table('customers')->insertGetId([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Amina B.',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $uuid = (string) Str::uuid();
    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid, [], [
            'preset_id' => $preset,
            'customer_id' => $customer,
        ])],
    ])->assertOk();

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    $card = DB::table('prep_orders')->first();

    expect($card->preset_label)->toBe('Takeaway')
        ->and($card->customer_name)->toBe('Amina B.');
});

it('keeps the service mode current when the order is amended', function (): void {
    // The update branch of `upsertPrepOrder` refreshes table and guests; it has to refresh these
    // two as well, or a takeaway converted to a dine-in keeps the label it was fired under.
    $preset = takeawayPreset($this->fx);

    $uuid = (string) Str::uuid();
    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid, [], ['preset_id' => $preset])],
    ])->assertOk();

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    $dineIn = takeawayPreset($this->fx, 'Dine in');
    Order::query()->where('uuid', $uuid)->update(['pos_preset_id' => $dineIn]);

    Order::query()->where('uuid', $uuid)->update(['general_customer_note' => 'no onions']);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    expect(DB::table('prep_orders')->first()->preset_label)->toBe('Dine in');
});

it('leaves the labels null on an order with neither a preset nor a customer', function (): void {
    $uuid = kitchenOrder($this->fx);
    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    $card = DB::table('prep_orders')->first();

    // Not the empty string: `TicketCard` falls back on `?? `, which an empty string defeats.
    expect($card->preset_label)->toBeNull()
        ->and($card->customer_name)->toBeNull();
});

it('prints the service mode on the ticket a cook reads', function (): void {
    $printer = DB::table('pos_printers')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Kitchen printer',
        'printer_type' => 'epson_epos',
        'print_all_categories' => true,
        'characters_per_line' => 42,
        'copies' => 1,
        'active' => true,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    DB::table('pos_config_printer')->insert([
        'pos_config_id' => $this->fx->config->getKey(),
        'pos_printer_id' => $printer,
    ]);
    $this->fx->config->forceFill(['use_preparation_printers' => true])->save();

    $preset = takeawayPreset($this->fx);
    $customer = DB::table('customers')->insertGetId([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Amina B.',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $uuid = (string) Str::uuid();
    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid, [], ['preset_id' => $preset, 'customer_id' => $customer])],
    ])->assertOk();

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    $rendered = $this->withHeaders($this->fx->headers())->getJson('/api/kitchen/print-jobs')
        ->assertOk()
        ->json('jobs.0.rendered_text');

    // A takeaway and a dine-in used to print identically, distinguishable only by a missing Table
    // line — the pass inferring the service mode from an absence.
    expect($rendered)->toContain('TAKEAWAY')
        ->and($rendered)->toContain('Amina B.');
});
