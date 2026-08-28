<?php

declare(strict_types=1);

namespace Tests\Feature\Kitchen\PrepLineContent;

use App\Enums\DeviceType;
use App\Models\Pos\PosDevice;
use App\Services\Device\DeviceTokenService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/*
|--------------------------------------------------------------------------
| What a prep line carries (KDS-005, KDS-006, BAN-433)
|--------------------------------------------------------------------------
|
| Most of what BAN-433 asks for turned out to be already built — `preset_label`
| and `customer_name` are populated (BAN-431), attribute values are folded into
| the composed name, and `TicketRenderer` carries the preset at the very lines
| the ticket cites as proof it does not. Six tests in KitchenTest already guard
| those, and this file does not repeat them.
|
| What had no guard is `combo_parent_uuid`. It is populated server-side, rides
| the broadcast payload, is mapped into the KDS store and declared on the
| client type — and until BAN-433 was read by nothing at all. Now that the card
| groups by it, the value travelling intact from the sync command to the board
| payload is load-bearing: if it arrives null, a set menu goes back to being a
| flat list of unrelated items with no way to tell whose drink is whose.
*/

beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withPrepDisplay();
});

/** An order with a combo parent and one child, as the register sends it. */
function comboOrder(PosFixtures $fx): array
{
    $orderUuid = (string) Str::uuid();
    $parentUuid = (string) Str::uuid();
    $childUuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($orderUuid, [
            [
                'op' => 'create',
                'uuid' => $parentUuid,
                'variant_id' => $fx->variant->getKey(),
                'qty' => '1',
                'price_unit' => '10.00',
                'discount' => '0',
            ],
            [
                'op' => 'create',
                'uuid' => $childUuid,
                'variant_id' => $fx->drinkVariant->getKey(),
                'qty' => '1',
                'price_unit' => '0.00',
                'discount' => '0',
                'combo_parent_uuid' => $parentUuid,
            ],
        ], ['table_id' => $fx->tableOne?->getKey(), 'guest_count' => 2])],
    ])->assertOk();

    test()->withHeaders($fx->headers())->postJson("/api/pos/orders/{$orderUuid}/preparation")->assertOk();

    return ['order' => $orderUuid, 'parent' => $parentUuid, 'child' => $childUuid];
}

it('writes the combo parent onto the child prep line, and leaves the parent unparented', function (): void {
    ['parent' => $parentUuid, 'child' => $childUuid] = comboOrder($this->fx);

    $lines = DB::table('prep_order_lines')->get()->keyBy('pos_order_line_uuid');

    expect($lines)->toHaveCount(2)
        ->and($lines[$childUuid]->combo_parent_uuid)->toBe($parentUuid)
        ->and($lines[$parentUuid]->combo_parent_uuid)->toBeNull();
});

it('carries the combo parent all the way to the board payload the card groups by', function (): void {
    // The value being in the table is not the point — the card reads the payload. This is the join
    // that had never been asserted, and the reason the field could sit unread for so long.
    ['parent' => $parentUuid, 'child' => $childUuid] = comboOrder($this->fx);

    // The board is device-authenticated and needs `pos:kitchen`, which a register device does not
    // carry — so this reads it the way the KDS actually does, as a paired prep display.
    $kds = PosDevice::query()->create([
        'uuid' => (string) Str::uuid(),
        'pos_config_id' => $this->fx->config->getKey(),
        'device_identifier' => 9,
        'name' => 'KDS',
        'device_type' => DeviceType::PrepDisplay->value,
        'active' => true,
    ]);
    $token = app(DeviceTokenService::class)->issue($kds)['token'];

    $board = $this->withHeaders(['Authorization' => 'Bearer '.$token, 'Accept' => 'application/json'])
        ->getJson('/api/kitchen/'.$this->fx->display->access_token.'/orders')
        ->assertOk()
        ->json();

    $lines = collect($board['orders'] ?? [])->flatMap(fn (array $order): array => $order['lines'])
        ->keyBy('pos_order_line_uuid');

    expect($lines->has($childUuid))->toBeTrue()
        ->and($lines[$childUuid]['combo_parent_uuid'])->toBe($parentUuid)
        ->and($lines[$parentUuid]['combo_parent_uuid'])->toBeNull();
});

it('points the child at a parent that is on the same board', function (): void {
    // `groupCombos` promotes a child whose parent it cannot find, so a mismatch here would not
    // crash — it would silently ungroup every combo, which is exactly the kind of quiet failure
    // that let this field go unread. The two sides must agree on which uuid identifies a line.
    ['child' => $childUuid] = comboOrder($this->fx);

    $lines = DB::table('prep_order_lines')->get();
    $parents = $lines->pluck('combo_parent_uuid')->filter()->all();
    $identities = $lines->pluck('pos_order_line_uuid')->all();

    expect($parents)->not->toBeEmpty();

    foreach ($parents as $parent) {
        expect($identities)->toContain($parent);
    }

    expect($lines->firstWhere('pos_order_line_uuid', $childUuid))->not->toBeNull();
});
