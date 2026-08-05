<?php

declare(strict_types=1);

use App\Enums\OrderState;
use App\Models\Pos\PosSession;
use App\Services\Pos\SessionSummaryService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-484 / BOF-160 — the X-report computation.
 *
 * `freeze` was called from exactly one place, `SessionService::close`, so `session_*_summaries` rows
 * existed only after a session closed. A manager looking at today's sales mid-service saw zero,
 * because the report reads those tables and a service in progress has not written to them.
 *
 * The fix is not a second aggregation for open sessions. It is the *same* aggregation, split out of
 * `freeze` so both callers use it — which is what makes "the mid-shift figure matches the Z-report"
 * true by construction rather than by coincidence. These tests pin that equivalence.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession('100.00');
});

function sell(PosFixtures $fx, string $amount = '24.20', string $qty = '2'): string
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
        ]], ['state' => OrderState::Paid->value], [[
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'payment_method_id' => $fx->cash->getKey(),
            'amount' => $amount,
        ]])],
    ])->assertOk();

    return $uuid;
}

it('computes sales for a session that is still open', function (): void {
    sell($this->fx);

    $sessionId = (int) $this->fx->session->getKey();

    // Nothing is frozen yet — that is the state a manager is in mid-service.
    expect(DB::table('session_sales_summaries')->where('pos_session_id', $sessionId)->count())->toBe(0);

    $rows = app(SessionSummaryService::class)->salesSummaryRows([$sessionId]);

    expect($rows)->toHaveCount(1)
        ->and($rows[0]['total_amount'])->toBe('24.2000')
        ->and($rows[0]['quantity'])->toBe('2.000')
        ->and($rows[0]['pos_session_id'])->toBe($sessionId);
});

it('gives the same answer live as it freezes at close', function (): void {
    // The acceptance criterion, asserted directly: an X-report figure computed mid-shift must match
    // the totals computed at close for the same set of orders.
    sell($this->fx, '24.20');
    sell($this->fx, '12.10', '1');

    $sessionId = (int) $this->fx->session->getKey();
    $summaries = app(SessionSummaryService::class);

    $live = $summaries->salesSummaryRows([$sessionId]);
    $liveTax = $summaries->taxSummaryRows([$sessionId]);
    $livePayments = $summaries->paymentTotalRows([$sessionId]);

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$sessionId}/close", ['counted_cash' => '136.30'])
        ->assertOk();

    $frozen = DB::table('session_sales_summaries')->where('pos_session_id', $sessionId)->get()
        ->map(static fn (object $row): array => (array) $row)->all();

    expect($frozen)->toHaveCount(count($live));

    // Field by field, not just the total: a mismatch in `cost_amount` alone would still be a report
    // that changes the moment a manager closes the till.
    //
    // Compared by value, not by string: the frozen row comes back from a decimal column as whatever
    // the driver hands over ('3' from SQLite), while the live row is a BCMath-scaled string
    // ('3.000'). Both go through `bcadd` in the report, so the representation never reaches a user —
    // asserting on it would be testing the database driver.
    foreach ($live as $index => $row) {
        foreach (['quantity', 'base_amount', 'discount_amount', 'tax_amount', 'total_amount', 'cost_amount'] as $field) {
            expect(bccomp((string) $frozen[$index][$field], (string) $row[$field], 4))
                ->toBe(0, "sales.{$index}.{$field}: {$frozen[$index][$field]} vs {$row[$field]}");
        }
    }

    $frozenTax = DB::table('session_tax_summaries')->where('pos_session_id', $sessionId)->get()
        ->map(static fn (object $row): array => (array) $row)->all();

    expect($frozenTax)->toHaveCount(count($liveTax));

    foreach ($liveTax as $index => $row) {
        expect(bccomp((string) $frozenTax[$index]['base_amount'], (string) $row['base_amount'], 4))->toBe(0)
            ->and(bccomp((string) $frozenTax[$index]['tax_amount'], (string) $row['tax_amount'], 4))->toBe(0);
    }

    $frozenPayments = DB::table('session_payment_totals')->where('pos_session_id', $sessionId)->get();

    expect($frozenPayments)->toHaveCount(count($livePayments))
        ->and(bccomp((string) $frozenPayments[0]->expected_amount, $livePayments[0]['expected_amount'], 4))->toBe(0);
});

it('counts only paid orders, exactly as the freeze does', function (): void {
    // A draft is not a sale. If the live path counted drafts, the X-report would over-report the
    // shift and then shrink at close — the failure mode the whole split exists to rule out.
    sell($this->fx, '24.20');

    $draft = (string) Str::uuid();
    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($draft)],
    ])->assertOk();

    $rows = app(SessionSummaryService::class)->salesSummaryRows([(int) $this->fx->session->getKey()]);

    expect(array_sum(array_map(static fn (array $r): float => (float) $r['total_amount'], $rows)))->toBe(24.2);
});

it('aggregates several sessions in one query', function (): void {
    // The report asks about a period, not a session, so a per-session loop would be N queries and
    // would also make the open/closed split awkward to express.
    sell($this->fx, '24.20');
    $first = (int) $this->fx->session->getKey();

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$first}/close", ['counted_cash' => '124.20'])
        ->assertOk();

    $this->fx->withSession('100.00');
    sell($this->fx, '12.10', '1');
    $second = (int) $this->fx->session->getKey();

    $rows = app(SessionSummaryService::class)->salesSummaryRows([$first, $second]);

    expect(collect($rows)->pluck('pos_session_id')->unique()->sort()->values()->all())
        ->toBe([$first, $second]);
});

it('returns nothing for an empty session list rather than every session', function (): void {
    sell($this->fx);

    // `whereIn('pos_session_id', [])` is a valid query that matches nothing, but a missing guard
    // that skipped the `whereIn` entirely would aggregate the whole database into one report.
    expect(app(SessionSummaryService::class)->salesSummaryRows([]))->toBe([])
        ->and(app(SessionSummaryService::class)->taxSummaryRows([]))->toBe([])
        ->and(app(SessionSummaryService::class)->paymentTotalRows([]))->toBe([]);
});

it('keeps the closing popup reading the same numbers', function (): void {
    // `expectedPaymentTotals` now delegates to the multi-session method; the closing popup is its
    // other caller and must be unaffected.
    sell($this->fx, '24.20');

    $session = PosSession::query()->find($this->fx->session->getKey());
    $totals = app(SessionSummaryService::class)->expectedPaymentTotals($session);

    expect($totals)->toHaveCount(1)
        ->and($totals[0]['expected_amount'])->toBe('24.2000')
        ->and($totals[0]['payment_method_id'])->toBe($this->fx->cash->getKey());
});
