<?php

declare(strict_types=1);

use App\Enums\WeightSource;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

/**
 * XCT-058 — `pos_order_lines.weight_source` survives the wire.
 *
 * The recurring defect this project keeps finding is a column that is written, cast, validated and
 * shipped, and that **nothing reads** — `iot_scale` was one for eight tickets. A provenance column
 * the register fills in and the sync endpoint drops would be exactly the same thing with a fresh
 * coat of paint, so it is asserted at the endpoint rather than only in the client's unit tests.
 *
 * The provenance is *evidence*: 'scale' means a certified instrument produced this number and
 * 'manual' means a cashier typed it. The client is therefore allowed to state it (only the client
 * knows) but not to invent a third kind, which is what the tryFrom in OrderSyncService is for.
 */
uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();
    $this->fx->product->forceFill(['to_weight' => true])->save();
});

function pushWeighed(PosFixtures $fx, array $overrides = [], ?string $orderUuid = null, ?string $lineUuid = null): TestResponse
{
    $line = [
        'op' => 'create',
        'uuid' => $lineUuid ?? (string) Str::uuid(),
        'variant_id' => $fx->variant->getKey(),
        'qty' => '0.2',
        'price_unit' => '10.00',
        'discount' => '0',
        ...$overrides,
    ];

    return test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'client_version' => '1.0.0',
        'employee_id' => $fx->cashier->getKey(),
        'orders' => [$fx->orderCommand($orderUuid ?? (string) Str::uuid(), [$line])],
    ]);
}

function storedSource(string $lineUuid): ?string
{
    return OrderLine::query()->where('uuid', $lineUuid)->value('weight_source')?->value;
}

it('stores a scale reading as such', function (): void {
    $lineUuid = (string) Str::uuid();

    pushWeighed($this->fx, ['weight_source' => 'scale'], lineUuid: $lineUuid)
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    expect(storedSource($lineUuid))->toBe(WeightSource::Scale->value);
});

it('stores a hand-entered weight as such, distinguishably', function (): void {
    // AC4: manual entry stays possible *and* stays distinguishable. Two rows that both said
    // 'scale', or both said nothing, would satisfy neither half.
    $lineUuid = (string) Str::uuid();

    pushWeighed($this->fx, ['weight_source' => 'manual'], lineUuid: $lineUuid)->assertOk();

    expect(storedSource($lineUuid))->toBe(WeightSource::Manual->value);
});

it('leaves the provenance null on a line that claims none', function (): void {
    // The overwhelming majority of lines. Null means "not a measurement", which is different from
    // "a measurement whose origin we forgot".
    $lineUuid = (string) Str::uuid();

    pushWeighed($this->fx, [], lineUuid: $lineUuid)->assertOk();

    expect(storedSource($lineUuid))->toBeNull();
});

it('refuses a provenance the enum does not define rather than storing it', function (): void {
    // The column is cast to WeightSource, so an arbitrary string that reached the database would
    // throw on the next hydrate — the order would become unreadable rather than merely mislabelled.
    $lineUuid = (string) Str::uuid();

    pushWeighed($this->fx, ['weight_source' => 'certified-by-me'], lineUuid: $lineUuid)
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    expect(storedSource($lineUuid))->toBeNull();
    expect(OrderLine::query()->where('uuid', $lineUuid)->firstOrFail()->weight_source)->toBeNull();
});

it('carries the provenance back out on the order resource', function (): void {
    // Written but never read is the failure mode this whole ticket is about. A refund or a reprint
    // taken from another till goes through this endpoint, so if it does not come back out the
    // column is decoration.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    pushWeighed($this->fx, ['weight_source' => 'scale'], orderUuid: $orderUuid, lineUuid: $lineUuid)->assertOk();

    $order = Order::query()->where('uuid', $orderUuid)->firstOrFail();

    test()->withHeaders($this->fx->headers())
        ->getJson("/api/pos/orders/{$order->getKey()}")
        ->assertOk()
        ->assertJsonPath('lines.0.weight_source', 'scale');
});

it('lets an update correct the provenance without touching anything else', function (): void {
    // The scale was unplugged mid-sale and the cashier retyped: the line is the same line, the
    // evidence behind it is not. The update path parses the value on its own — it is deliberately
    // not in the plain copy map beside `customer_note`.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    pushWeighed($this->fx, ['weight_source' => 'scale'], orderUuid: $orderUuid, lineUuid: $lineUuid)->assertOk();

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'client_version' => '1.0.0',
        'employee_id' => $this->fx->cashier->getKey(),
        'orders' => [$this->fx->orderCommand($orderUuid, [[
            'op' => 'update',
            'uuid' => $lineUuid,
            'variant_id' => $this->fx->variant->getKey(),
            'weight_source' => 'manual',
        ]])],
    ])->assertOk();

    $line = OrderLine::query()->where('uuid', $lineUuid)->firstOrFail();

    expect($line->weight_source)->toBe(WeightSource::Manual)
        ->and((string) $line->quantity)->toBe('0.200');
});

it('does not let an update invent a provenance the enum does not define', function (): void {
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    pushWeighed($this->fx, ['weight_source' => 'scale'], orderUuid: $orderUuid, lineUuid: $lineUuid)->assertOk();

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'client_version' => '1.0.0',
        'employee_id' => $this->fx->cashier->getKey(),
        'orders' => [$this->fx->orderCommand($orderUuid, [[
            'op' => 'update',
            'uuid' => $lineUuid,
            'variant_id' => $this->fx->variant->getKey(),
            'weight_source' => 'notarised',
        ]])],
    ])->assertOk();

    expect(storedSource($lineUuid))->toBeNull();
});

it('leaves the provenance alone on an update that says nothing about it', function (): void {
    // An ordinary re-push of a draft — which the register does on every change and again at
    // payment. If the absent key read as null, every weighed line would lose its evidence within
    // seconds of being rung up.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    pushWeighed($this->fx, ['weight_source' => 'scale'], orderUuid: $orderUuid, lineUuid: $lineUuid)->assertOk();

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'client_version' => '1.0.0',
        'employee_id' => $this->fx->cashier->getKey(),
        'orders' => [$this->fx->orderCommand($orderUuid, [[
            'op' => 'update',
            'uuid' => $lineUuid,
            'variant_id' => $this->fx->variant->getKey(),
            'customer_note' => 'sliced thin',
        ]])],
    ])->assertOk();

    expect(storedSource($lineUuid))->toBe(WeightSource::Scale->value);
});
