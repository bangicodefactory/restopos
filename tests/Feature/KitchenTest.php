<?php

declare(strict_types=1);

use App\Enums\DeviceType;
use App\Enums\PrepLineState;
use App\Enums\PrepOrderState;
use App\Enums\PrintJobState;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Pos\PosDevice;
use App\Services\Device\DeviceTokenService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
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
