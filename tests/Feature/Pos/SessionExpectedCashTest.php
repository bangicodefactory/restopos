<?php

declare(strict_types=1);

use App\Enums\OrderState;
use App\Models\Pos\Order;
use App\Models\Pos\Payment;
use App\Services\Pos\SessionService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make(['has_cash_control' => true])->withSession('100.00');
});

/** Ring up the default order paid with cash; returns [orderUuid]. */
function cashSale(PosFixtures $fx, string $amount): string
{
    $uuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [], ['state' => OrderState::Paid->value], [[
            'op' => 'create', 'uuid' => (string) Str::uuid(),
            'payment_method_id' => $fx->cash->getKey(), 'amount' => $amount,
        ]])],
    ])->assertOk()->assertJsonPath('results.0.status', 'ok');

    return $uuid;
}

it('expected cash is opening float plus cash taken minus change given (REG-204)', function (): void {
    $uuid = cashSale($this->fx, '30.00'); // 24.20 order, 5.80 change → 24.20 stays in the drawer
    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    // opening 100 + (30 tendered − change) = 100 + amount_total
    $expected = round(100.0 + (float) $order->amount_total, 2);

    $response = $this->withHeaders($this->fx->headers())
        ->getJson("/api/pos/sessions/{$this->fx->session->getKey()}/closing-data");

    $response->assertOk();
    expect(round((float) $response->json('expected_cash'), 2))->toBe($expected)
        // sanity: the change actually reduced the drawer below the raw tender
        ->and($expected)->toBeLessThan(round(100.0 + 30.0, 2));
});

it('a positive-signed change row does not inflate expected cash (defensive, REG-204)', function (): void {
    $uuid = cashSale($this->fx, '30.00');
    $order = Order::query()->where('uuid', $uuid)->firstOrFail();
    $changeGiven = (float) $order->amount_change; // 5.80

    // Corrupt the server's negative change row to a positive amount (a bad client convention or
    // legacy row). expectedCash must still count it as leaving the drawer, not entering it.
    Payment::query()->where('pos_order_id', $order->getKey())->where('is_change', true)
        ->update(['amount' => number_format($changeGiven, 4, '.', '')]);

    $expected = round(100.0 + (float) $order->amount_total, 2);

    $actual = round((float) app(SessionService::class)->expectedCash($this->fx->session), 2);

    // With the naive sum this would be inflated by 2× the change (100 + 30 + 5.80); normalisation
    // keeps it at 100 + 24.20.
    expect($actual)->toBe($expected);
});
