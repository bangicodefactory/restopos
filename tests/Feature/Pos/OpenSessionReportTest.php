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

// ── the register's X-report (BAN-438, REG-020 / REG-022) ─────────────────────

it('hands the register a reading without closing the session', function (): void {
    // The whole point of the X. A cashier asking where the day stands must not end the day, and a
    // report endpoint that quietly froze the summaries would do exactly that.
    sell($this->fx);

    $response = test()->withHeaders($this->fx->headers())
        ->getJson("/api/pos/sessions/{$this->fx->session->getKey()}/x-report")
        ->assertOk();

    expect($response->json('sales_total'))->toBe('20.0000')
        ->and($response->json('tax_total'))->toBe('4.2000')
        ->and($response->json('order_count'))->toBe(1)
        // 100 float + 24.20 taken.
        ->and($response->json('expected_cash'))->toBe('124.2000');

    $session = PosSession::query()->whereKey($this->fx->session->getKey())->firstOrFail();

    expect($session->state->value)->toBe('opened')
        ->and($session->closed_at)->toBeNull()
        // Nothing frozen: the summaries are still the close's to write.
        ->and(DB::table('session_sales_summaries')->where('pos_session_id', $session->getKey())->count())->toBe(0);
});

it('reads the same numbers the close then freezes', function (): void {
    // The acceptance criterion, and the reason the aggregation was split out of `freeze` rather
    // than duplicated: an X at 18:00 and a Z at midnight cannot disagree about the orders they both
    // cover, because neither has arithmetic of its own.
    sell($this->fx, '24.20');
    sell($this->fx, '12.10', '1');

    $x = test()->withHeaders($this->fx->headers())
        ->getJson("/api/pos/sessions/{$this->fx->session->getKey()}/x-report")
        ->assertOk();

    test()->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$this->fx->session->getKey()}/close", [
            'counted_cash' => $x->json('expected_cash'),
        ])->assertOk();

    $frozenSales = (string) DB::table('session_sales_summaries')
        ->where('pos_session_id', $this->fx->session->getKey())->sum('base_amount');
    $frozenTax = (string) DB::table('session_tax_summaries')
        ->where('pos_session_id', $this->fx->session->getKey())->sum('tax_amount');

    expect(bccomp((string) $x->json('sales_total'), $frozenSales, 2))->toBe(0)
        ->and(bccomp((string) $x->json('tax_total'), $frozenTax, 2))->toBe(0)
        ->and((int) $x->json('order_count'))
        ->toBe((int) PosSession::query()->whereKey($this->fx->session->getKey())->value('order_count'));
});

it('counts traded orders live rather than off the sequence column', function (): void {
    // `pos_sessions.order_count` is not the traded-order count mid-shift. `SequenceService`
    // increments it for every order that takes a sequence number, and `freeze()` overwrites it at
    // close with the paid-and-done count — two different meanings in one column depending on when
    // you read it. The reading counts live, so it says the same thing at 18:00 and at midnight.
    $sold = sell($this->fx);
    sell($this->fx);

    // Both orders took a sequence number, so the column reads 2. Then one is cancelled — which the
    // back office can do to a settled order even though a device cannot (BAN-410) — and the column
    // does not move, because it counts numbers issued rather than sales made.
    DB::table('pos_orders')->where('uuid', $sold)->update(['state' => OrderState::Cancelled->value]);

    expect((int) PosSession::query()->whereKey($this->fx->session->getKey())->value('order_count'))->toBe(2);

    $live = test()->withHeaders($this->fx->headers())
        ->getJson("/api/pos/sessions/{$this->fx->session->getKey()}/x-report")->json('order_count');

    // The reading says what actually traded.
    expect($live)->toBe(1);

    test()->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$this->fx->session->getKey()}/close", ['counted_cash' => '148.4000'])
        ->assertOk();

    // And the close agrees with the reading, not with the column it overwrites.
    expect((int) PosSession::query()->whereKey($this->fx->session->getKey())->value('order_count'))
        ->toBe($live);
});

it('separates refunds from sales rather than folding them in', function (): void {
    // A service that took 900 and gave back 100 is a different day from one that took 800, and a
    // reading that cannot tell them apart is the reading nobody trusts.
    $sold = sell($this->fx, '24.20');
    $soldLine = (string) DB::table('pos_order_lines')
        ->join('pos_orders', 'pos_orders.id', '=', 'pos_order_lines.pos_order_id')
        ->where('pos_orders.uuid', $sold)
        ->value('pos_order_lines.uuid');

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand((string) Str::uuid(), [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
            'qty' => '-1', 'price_unit' => '10.00', 'discount' => '0',
            'refunded_line_uuid' => $soldLine,
        ]], [
            'state' => OrderState::Paid->value, 'is_refund' => true, 'refunded_order_uuid' => $sold,
        ], [[
            'op' => 'create', 'uuid' => (string) Str::uuid(),
            'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '-12.10',
        ]])],
    ])->assertOk()->assertJsonPath('results.0.lines.0.status', 'ok');

    $x = test()->withHeaders($this->fx->headers())
        ->getJson("/api/pos/sessions/{$this->fx->session->getKey()}/x-report")->assertOk();

    expect($x->json('sales_total'))->toBe('20.0000')
        ->and($x->json('refund_total'))->toBe('-10.0000');
});

it('refuses a reading for another venue session', function (): void {
    // Same boundary every device route carries: the session must belong to this register.
    $theirs = PosFixtures::make()->withSession();

    test()->withHeaders($this->fx->headers())
        ->getJson("/api/pos/sessions/{$theirs->session->getKey()}/x-report")
        ->assertNotFound();
});
