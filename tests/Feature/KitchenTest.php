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
