<?php

declare(strict_types=1);

use App\Enums\OrderState;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-484 / BOF-160 — today's sales must be visible while the till is still trading.
 *
 * The report read `session_*_summaries`, which are written only at close, so a manager checking the
 * shift mid-service saw zero. Not "roughly right" or "a bit behind" — zero, on a day that had taken
 * money all afternoon.
 *
 * The subtler half is the one these tests spend most of their assertions on: the figure must not
 * *move* when the session closes. A report that jumps at close is arguably worse than one that shows
 * nothing, because the number looked trustworthy right up until it changed.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession('100.00');
    $this->manager = User::factory()->create(['company_id' => $this->fx->company->getKey()]);
});

function sellFor(PosFixtures $fx, string $amount, string $qty = '2'): void
{
    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand((string) Str::uuid(), [[
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'variant_id' => $fx->variant->getKey(),
            'qty' => $qty,
            'price_unit' => '10.00',
            'discount' => '0',
        ]], ['state' => OrderState::Paid->value], [[
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'payment_method_id' => $fx->cash->getKey(),
            'amount' => $amount,
        ]])],
    ])->assertOk();
}

/** @return array<string, mixed> */
function salesReport(TestCase $test): array
{
    $response = $test->withHeaders([
        'X-Inertia' => 'true',
        // Inertia answers 409 when the asset version does not match, telling the client to hard
        // reload. Sending the current one keeps these tests working whether or not the frontend
        // has been built — without it they pass only on a checkout with no manifest.
        'X-Inertia-Version' => PosFixtures::inertiaVersion(),
        'X-Inertia-Partial-Component' => 'Reports/SalesDetails',
        'X-Inertia-Partial-Data' => 'byProduct,byCategory,byTax,byPaymentMethod,openSessionCount',
    ])->get('/reports/sales-details?from='.now()->subDay()->toDateString().'&to='.now()->addDay()->toDateString());

    $response->assertOk();

    return (array) (json_decode((string) $response->getContent(), true)['props'] ?? []);
}

/** The report's headline: everything sold in the period, however it is grouped. */
function totalOf(array $props, string $panel = 'byProduct'): string
{
    return array_reduce(
        $props[$panel] ?? [],
        static fn (string $carry, array $row): string => bcadd($carry, (string) $row['total_amount'], 4),
        '0',
    );
}

it('surfaces that the period includes a session still trading', function (): void {
    sellFor($this->fx, '24.20');

    $this->actingAs($this->manager);
    expect(salesReport($this)['openSessionCount'])->toBe(1);

    $sessionId = (int) $this->fx->session->getKey();
    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$sessionId}/close", ['counted_cash' => '124.20'])
        ->assertOk();

    // Once everything is frozen the figures are final, and the page should stop hedging.
    $this->actingAs($this->manager);
    expect(salesReport($this)['openSessionCount'])->toBe(0);
});

it('shows an open session sales, where it used to show zero', function (): void {
    sellFor($this->fx, '24.20');

    $this->actingAs($this->manager);
    $props = salesReport($this);

    expect(totalOf($props))->toBe('24.2000')
        ->and($props['openSessionCount'])->toBe(1);
});

it('does not change the figure when the session closes', function (): void {
    sellFor($this->fx, '24.20');
    sellFor($this->fx, '12.10', '1');

    $this->actingAs($this->manager);
    $duringService = salesReport($this);

    $sessionId = (int) $this->fx->session->getKey();
    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$sessionId}/close", ['counted_cash' => '136.30'])
        ->assertOk();

    $this->actingAs($this->manager);
    $afterClose = salesReport($this);

    // The whole acceptance criterion in one line: no double count, no drop.
    expect(totalOf($afterClose))->toBe(totalOf($duringService))
        ->and(totalOf($afterClose, 'byCategory'))->toBe(totalOf($duringService, 'byCategory'))
        ->and($afterClose['openSessionCount'])->toBe(0);

    // …and the summaries really were frozen, so the second read went down the other path.
    expect(DB::table('session_sales_summaries')->where('pos_session_id', $sessionId)->count())
        ->toBeGreaterThan(0);
});

it('adds an open session to a closed one without double counting either', function (): void {
    // The mixed case is where a naive union goes wrong: yesterday frozen, today live, in one report.
    sellFor($this->fx, '24.20');
    $closed = (int) $this->fx->session->getKey();

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$closed}/close", ['counted_cash' => '124.20'])
        ->assertOk();

    $this->fx->withSession('100.00');
    sellFor($this->fx, '12.10', '1');

    $this->actingAs($this->manager);
    $props = salesReport($this);

    expect(totalOf($props))->toBe('36.3000')
        ->and($props['openSessionCount'])->toBe(1);
});

it('ranks products by revenue, not by units sold', function (): void {
    // The regression this exists to catch: the grouping helper inferred its sort field from the
    // first summed column, which is `quantity`. The headline list then put cheap high-volume items
    // above the ones that actually earn — the opposite of what this page is opened for, and
    // invisible to any assertion about totals.
    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand((string) Str::uuid(), [
            // Ten cheap items…
            [
                'op' => 'create',
                'uuid' => (string) Str::uuid(),
                'variant_id' => $this->fx->drinkVariant->getKey(),
                'qty' => '10',
                // Priced by hand: the scenario needs a cheap high-volume line against an expensive
                // one, and since BAN-502 the server prices a `original` line from the catalogue, so
                // a fixture that wants its own numbers has to say so the way the till does.
                'price_unit' => '1.00',
                'price_type' => 'manual',
                'discount' => '0',
            ],
            // …against one expensive one.
            [
                'op' => 'create',
                'uuid' => (string) Str::uuid(),
                'variant_id' => $this->fx->variant->getKey(),
                'qty' => '1',
                'price_unit' => '90.00',
                'price_type' => 'manual',
                'discount' => '0',
            ],
        ], ['state' => OrderState::Paid->value], [[
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'payment_method_id' => $this->fx->cash->getKey(),
            'amount' => '100.00',
        ]])],
    ])->assertOk();

    $this->actingAs($this->manager);
    $rows = salesReport($this)['byProduct'];

    expect($rows)->toHaveCount(2)
        ->and((float) $rows[0]['total_amount'])->toBeGreaterThan((float) $rows[1]['total_amount'])
        ->and((float) $rows[0]['quantity'])->toBeLessThan((float) $rows[1]['quantity']);
});

it('reports tax and payment panels for an open session too', function (): void {
    sellFor($this->fx, '24.20');

    $this->actingAs($this->manager);
    $props = salesReport($this);

    expect($props['byTax'])->not->toBeEmpty()
        ->and($props['byPaymentMethod'])->toHaveCount(1)
        ->and($props['byPaymentMethod'][0]['expected_amount'])->toBe('24.2000')
        // Nobody has counted the drawer of a service still running, so a difference of zero here
        // would read as "counted and balanced" rather than "not counted".
        ->and($props['byPaymentMethod'][0]['difference_amount'])->toBe('0.0000');
});

it('still isolates tenants now that the report reads live rows', function (): void {
    // The live path is a second way into the order tables, so it is a second chance to leak. The
    // session list is still what scopes the whole report (XCT-101).
    sellFor($this->fx, '24.20');

    $stranger = PosFixtures::make()->withSession('100.00');
    sellFor($stranger, '999.00', '9');

    $this->actingAs($this->manager);

    expect(totalOf(salesReport($this)))->toBe('24.2000');
});

it('shows nothing for a period with no sessions', function (): void {
    sellFor($this->fx, '24.20');

    $this->actingAs($this->manager);

    $response = $this->withHeaders([
        'X-Inertia' => 'true',
        // Inertia answers 409 when the asset version does not match, telling the client to hard
        // reload. Sending the current one keeps these tests working whether or not the frontend
        // has been built — without it they pass only on a checkout with no manifest.
        'X-Inertia-Version' => PosFixtures::inertiaVersion(),
        'X-Inertia-Partial-Component' => 'Reports/SalesDetails',
        'X-Inertia-Partial-Data' => 'byProduct,openSessionCount',
    ])->get('/reports/sales-details?from=2000-01-01&to=2000-01-02');

    $props = (array) (json_decode((string) $response->assertOk()->getContent(), true)['props'] ?? []);

    expect($props['byProduct'])->toBe([])->and($props['openSessionCount'])->toBe(0);
});
