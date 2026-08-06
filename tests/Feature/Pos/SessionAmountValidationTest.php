<?php

declare(strict_types=1);

// Own namespace so the helpers below stay out of the global function table Pest shares across every
// test file — a collision there is a fatal error that only surfaces on a full-suite run.

namespace Tests\Feature\Pos\SessionAmountValidation;

use App\Enums\OrderState;
use App\Enums\SessionState;
use App\Models\Pos\PosSession;
use App\Models\User;
use App\Services\Pos\RegisterReadiness;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-507 — every cash amount on the session endpoints, before it reaches bcmath.
 *
 * `is_numeric('1e2')` is true and `bccomp('1e2', …)` throws, so `numeric` never guarded these. The
 * same trap has now landed three times — the audit trail (BAN-413), the opening float (BAN-417),
 * and here on the closing count and the denomination values, where it was a **500 on the end-of-day
 * close**. `App\Support\Validation\Amount` exists so the fourth field copies the rule instead of
 * the bug.
 *
 * The asymmetry these pin is the interesting part: physical cash cannot be negative, and a payment
 * method's total can.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make(['has_cash_control' => true])->withSession('100.00');
});

function closeWith(PosFixtures $fx, array $payload): TestResponse
{
    return test()->withHeaders($fx->headers())
        ->postJson("/api/pos/sessions/{$fx->session->getKey()}/close", ['counted_cash' => '0', ...$payload]);
}

// ── the close ────────────────────────────────────────────────────────────────

it('refuses a counted cash bcmath cannot read, instead of crashing the close', function (): void {
    // Was a 500: `bcsub('1e2', …)` inside `close()`. The end of the trading day is the worst place
    // in the app for an unhandled error — the till cannot be closed and the drawer cannot be
    // reconciled until someone deploys a fix.
    foreach (['1e2', 'plenty', '12,50'] as $value) {
        closeWith($this->fx, ['counted_cash' => $value])->assertStatus(422);
    }

    expect(PosSession::query()->findOrFail($this->fx->session->getKey())->state)
        ->toBe(SessionState::Opened);
});

it('refuses a negative counted drawer', function (): void {
    // A drawer holds no negative cash. Anything owed *out* of it is a cash movement, not a balance.
    closeWith($this->fx, ['counted_cash' => '-50.00'])->assertStatus(422);

    expect(PosSession::query()->findOrFail($this->fx->session->getKey())->state)
        ->toBe(SessionState::Opened);
});

it('refuses a denomination value bcmath cannot read', function (): void {
    // `recordCount` multiplies this by the quantity, so it reaches bcmath by a different door.
    closeWith($this->fx, ['denominations' => [['denomination_value' => '1e2', 'quantity' => 1]]])
        ->assertStatus(422);
});

it('refuses a banknote with a negative face value', function (): void {
    closeWith($this->fx, ['denominations' => [['denomination_value' => '-50.00', 'quantity' => 1]]])
        ->assertStatus(422);

    expect(DB::table('session_cash_counts')->count())->toBe(0);
});

it('refuses a per-method count bcmath cannot read', function (): void {
    closeWith($this->fx, ['counted_by_method' => [(string) $this->fx->cash->getKey() => '1e2']])
        ->assertStatus(422);
});

// ── the asymmetry ────────────────────────────────────────────────────────────

it('accepts a negative per-method count, because a card can genuinely owe money', function (): void {
    // The scenario in full, because it is the entire reason this field has no floor while the cash
    // beside it does: a customer returns today with yesterday's receipt, and the refund is larger
    // than everything the card has taken since. The close screen pre-fills the counted amount from
    // that expectation, so a `min:0` here would refuse an ordinary close.
    $saleUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    // Yesterday: five pizzas on the card.
    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', ['orders' => [
        $this->fx->orderCommand($saleUuid, [
            ['op' => 'create', 'uuid' => $lineUuid, 'variant_id' => $this->fx->variant->getKey(),
                'qty' => '5', 'price_unit' => '10.00', 'discount' => '0'],
        ], ['state' => OrderState::Paid->value], [
            ['op' => 'create', 'uuid' => (string) Str::uuid(),
                'payment_method_id' => $this->fx->card->getKey(), 'amount' => '60.50'],
        ]),
    ]])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$this->fx->session->getKey()}/close", ['counted_cash' => '100.00'])
        ->assertOk();

    // Today: a new session, the lot refunded, and one small card sale.
    $this->fx->withSession('100.00');

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', ['orders' => [
        $this->fx->orderCommand((string) Str::uuid(), [
            ['op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
                'qty' => '-5', 'price_unit' => '10.00', 'discount' => '0', 'refunded_line_uuid' => $lineUuid],
        ], ['state' => OrderState::Paid->value, 'is_refund' => true, 'refunded_order_uuid' => $saleUuid], [
            ['op' => 'create', 'uuid' => (string) Str::uuid(),
                'payment_method_id' => $this->fx->card->getKey(), 'amount' => '-60.50'],
        ]),
    ]])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', ['orders' => [
        $this->fx->orderCommand((string) Str::uuid(), [
            ['op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
                'qty' => '1', 'price_unit' => '10.00', 'discount' => '0'],
        ], ['state' => OrderState::Paid->value], [
            ['op' => 'create', 'uuid' => (string) Str::uuid(),
                'payment_method_id' => $this->fx->card->getKey(), 'amount' => '12.10'],
        ]),
    ]])->assertOk()->assertJsonPath('results.0.status', 'ok');

    // The server itself expects a negative on that method…
    $expected = collect($this->withHeaders($this->fx->headers())
        ->getJson("/api/pos/sessions/{$this->fx->session->getKey()}/closing-data")
        ->assertOk()->json('payment_totals'))
        ->firstWhere('payment_method_id', $this->fx->card->getKey());

    expect((float) $expected['expected_amount'])->toBeLessThan(0.0);

    // …so counting it back must go through.
    closeWith($this->fx, [
        'counted_cash' => '100.00',
        'counted_by_method' => [(string) $this->fx->card->getKey() => $expected['expected_amount']],
    ])->assertOk();
});

// ── the open ─────────────────────────────────────────────────────────────────

it('refuses a negative opening float', function (): void {
    // Since BAN-417 this value carries over from the previous close, so one bad number would seed
    // every session after it rather than staying where it was typed.
    $fresh = PosFixtures::make(['has_cash_control' => true]);

    test()->withHeaders($fresh->headers())
        ->postJson('/api/pos/sessions', ['opening_float' => '-5.00'])
        ->assertStatus(422);

    expect(PosSession::query()->where('pos_config_id', $fresh->config->getKey())->count())->toBe(0);
});

it('refuses a denomination the open pane could not have produced', function (): void {
    $fresh = PosFixtures::make(['has_cash_control' => true]);

    foreach (['1e2', '-50.00'] as $value) {
        test()->withHeaders($fresh->headers())
            ->postJson('/api/pos/sessions', [
                'opening_float' => '0',
                'denominations' => [['denomination_value' => $value, 'quantity' => 1]],
            ])
            ->assertStatus(422);
    }

    expect(PosSession::query()->where('pos_config_id', $fresh->config->getKey())->count())->toBe(0);
});

// ── cash movements ───────────────────────────────────────────────────────────

it('refuses a cash movement bcmath cannot read', function (): void {
    test()->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$this->fx->session->getKey()}/cash-movements", [
            'movement_type' => 'cash_in', 'amount' => '1e2',
        ])
        ->assertStatus(422);

    expect(DB::table('cash_movements')->count())->toBe(0);
});

it('still tolerates a signed magnitude on a cash movement', function (): void {
    // `cashMove` strips the sign and applies its own from the movement type. That tolerance predates
    // this ticket and clients may rely on it, so the shape was tightened without tightening it.
    test()->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$this->fx->session->getKey()}/cash-movements", [
            'movement_type' => 'cash_out', 'amount' => '-20.00',
        ])
        ->assertCreated()
        ->assertJsonPath('amount', '-20.0000');
});

// ── the manager's own close ──────────────────────────────────────────────────

it('validates the back-office close the same way as the register', function (): void {
    // This one took the raw request and handed it to bcmath — no rules at all — so the screen a
    // manager uses to close the day was the *least* protected of the two. An array typed into the
    // form was a 500 as surely as `1e2` was.
    $this->withoutVite();
    $this->actingAs(User::factory()->create(['is_super_admin' => true]));

    foreach (['1e2', 'plenty', '-50.00', ['nested']] as $value) {
        $fresh = PosFixtures::make()->withSession('100.00');

        $this->post('/sessions/'.$fresh->session->uuid.'/close', ['counted_cash' => $value])
            ->assertSessionHasErrors('counted_cash');

        expect(PosSession::query()->whereKey($fresh->session->getKey())->value('state'))
            ->toBe(SessionState::Opened);
    }
});

// ── the readiness guard ──────────────────────────────────────────────────────

it('reports a register whose company cannot be read, rather than passing it', function (): void {
    // "I could not check" is not "nothing is wrong" — not for the one guard standing between a
    // register and a day of trade booked in the wrong currency. Unreachable behind a non-nullable
    // foreign key, which is why the branch is decided here rather than left to inference.
    $config = $this->fx->config->replicate();
    $config->forceFill(['company_id' => 999_999]);

    $codes = array_column(app(RegisterReadiness::class)->problems($config), 'code');

    expect($codes)->toContain(RegisterReadiness::CurrencyMismatch);
});
