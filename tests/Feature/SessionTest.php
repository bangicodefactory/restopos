<?php

declare(strict_types=1);

use App\Enums\OrderState;
use App\Enums\SessionState;
use App\Models\Pos\CashMovement;
use App\Models\Pos\PosSession;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make(['has_cash_control' => true]);
});

/** Ring up a paid order so the session has something to reconcile. */
function ringUp(PosFixtures $fx, string $amount = '24.20', ?int $methodId = null): string
{
    $uuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [], ['state' => OrderState::Paid->value], [[
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'payment_method_id' => $methodId ?? $fx->cash->getKey(),
            'amount' => $amount,
        ]])],
    ])->assertOk();

    return $uuid;
}

it('opens a session in opening control when cash control is on', function (): void {
    $response = $this->withHeaders($this->fx->headers())
        ->postJson('/api/pos/sessions', [
            'opening_float' => '150.00',
            'employee_id' => $this->fx->cashier->getKey(),
            'denominations' => [
                ['denomination_value' => '50.00', 'quantity' => 3],
            ],
        ]);

    $response->assertCreated()
        ->assertJsonPath('state', SessionState::OpeningControl->value)
        ->assertJsonPath('opening_float', '150.0000')
        ->assertJsonPath('has_cash_control', true);

    $sessionId = $response->json('id');

    expect(DB::table('session_cash_counts')->where('pos_session_id', $sessionId)->where('count_type', 'opening')->count())->toBe(1)
        ->and((float) DB::table('session_cash_counts')->where('pos_session_id', $sessionId)->value('total_counted'))->toBe(150.0);

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$sessionId}/opening-control", ['counted_float' => '150.00'])
        ->assertOk()
        ->assertJsonPath('state', SessionState::Opened->value);
});

it('refuses a second open session on the same register', function (): void {
    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sessions', ['opening_float' => '0'])->assertCreated();

    $this->withHeaders($this->fx->headers())
        ->postJson('/api/pos/sessions', ['opening_float' => '0'])
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'session_open_failed');
});

it('records cash in and cash out with the right sign', function (): void {
    $this->fx->withSession();
    $id = $this->fx->session->getKey();

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$id}/cash-movements", [
            'movement_type' => 'cash_in', 'amount' => '25.00', 'reason' => 'Change fund',
        ])->assertCreated()->assertJsonPath('amount', '25.0000');

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$id}/cash-movements", [
            'movement_type' => 'cash_out', 'amount' => '10.00', 'reason' => 'Milk run',
        ])->assertCreated()->assertJsonPath('amount', '-10.0000');

    $session = PosSession::query()->findOrFail($id);

    expect((string) $session->cash_in_total)->toBe('25.0000')
        ->and((string) $session->cash_out_total)->toBe('-10.0000');
});

it('computes expected cash from the float, cash sales and movements', function (): void {
    $this->fx->withSession('100.00');
    $id = $this->fx->session->getKey();

    ringUp($this->fx, '24.20');

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$id}/cash-movements", ['movement_type' => 'cash_out', 'amount' => '20.00'])
        ->assertCreated();

    $response = $this->withHeaders($this->fx->headers())->getJson("/api/pos/sessions/{$id}/closing-data");

    $response->assertOk()
        // 100.00 float + 24.20 cash sale − 20.00 out
        ->assertJsonPath('expected_cash', '104.2000')
        ->assertJsonPath('order_count', 1);

    $totals = collect($response->json('payment_totals'))->keyBy('payment_method_id');

    expect($totals[$this->fx->cash->getKey()]['expected_amount'])->toBe('24.2000');
});

it('closes a session and records the counted difference', function (): void {
    $this->fx->withSession('100.00');
    $id = $this->fx->session->getKey();

    ringUp($this->fx, '24.20');

    // Counted 122.20 against an expected 124.20 — a two-euro shortfall.
    $response = $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$id}/close", [
            'counted_cash' => '122.20',
            'counted_by_method' => [(string) $this->fx->cash->getKey() => '122.20'],
            'employee_id' => $this->fx->cashier->getKey(),
        ]);

    $response->assertOk()
        ->assertJsonPath('state', SessionState::Closed->value)
        ->assertJsonPath('cash_balance_closing_expected', '124.2000')
        ->assertJsonPath('cash_balance_closing_counted', '122.2000')
        ->assertJsonPath('cash_difference', '-2.0000');

    // The summaries are frozen at close, from the order rows.
    expect(DB::table('session_payment_totals')->where('pos_session_id', $id)->count())->toBe(1)
        ->and(DB::table('session_sales_summaries')->where('pos_session_id', $id)->count())->toBe(1)
        ->and(DB::table('session_tax_summaries')->where('pos_session_id', $id)->count())->toBe(1);

    $tax = DB::table('session_tax_summaries')->where('pos_session_id', $id)->first();
    expect((float) $tax->base_amount)->toBe(20.0)
        ->and((float) $tax->tax_amount)->toBe(4.2);

    // A difference movement is written so the drawer ledger balances.
    expect(DB::table('cash_movements')->where('pos_session_id', $id)->where('movement_type', 'difference')->count())->toBe(1);
});

it('refuses an over-threshold variance without a manager approval', function (): void {
    $this->fx->config->forceFill(['set_maximum_difference' => true, 'amount_authorized_diff' => '1.00'])->save();
    $this->fx->withSession('100.00');
    $id = $this->fx->session->getKey();

    $refused = $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$id}/close", ['counted_cash' => '90.00']);

    $refused->assertStatus(422)
        ->assertJsonPath('error.code', 'session_close_refused')
        ->assertJsonStructure(['error', 'closing_data']);

    expect(PosSession::query()->findOrFail($id)->state->value)->toBe(SessionState::Opened->value);

    // …and goes through with one — recording *which* manager authorised it (REG-016).
    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$id}/close", [
            'counted_cash' => '90.00',
            'manager_employee_id' => $this->fx->manager->getKey(),
            'manager_pin' => '9999',
        ])
        ->assertOk()
        ->assertJsonPath('cash_difference', '-10.0000')
        ->assertJsonPath('over_variance_approved_by_employee_id', $this->fx->manager->getKey());

    expect((int) PosSession::query()->whereKey($id)->value('over_variance_approved_by_employee_id'))
        ->toBe($this->fx->manager->getKey());
});

it('rejects a cashier pin as a manager approval', function (): void {
    $this->fx->config->forceFill(['set_maximum_difference' => true, 'amount_authorized_diff' => '1.00'])->save();
    $this->fx->withSession('100.00');
    $id = $this->fx->session->getKey();

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$id}/close", [
            'counted_cash' => '90.00',
            'manager_employee_id' => $this->fx->cashier->getKey(),
            'manager_pin' => '1234',
        ])
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'session_close_refused');
});

it('refuses to close over draft orders unless forced', function (): void {
    $this->fx->withSession();
    $id = $this->fx->session->getKey();

    $this->withHeaders($this->fx->headers())
        ->postJson('/api/pos/sync', ['orders' => [$this->fx->orderCommand((string) Str::uuid())]])
        ->assertOk();

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$id}/close", ['counted_cash' => '0'])
        ->assertStatus(422);

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$id}/close", ['counted_cash' => '0', 'force' => true])
        ->assertOk()
        ->assertJsonPath('closing_forced', true);
});

it('builds an accounting export from the frozen summaries', function (): void {
    $this->fx->withSession('0');
    $id = $this->fx->session->getKey();

    ringUp($this->fx, '24.20');

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$id}/close", ['counted_cash' => '24.20'])
        ->assertOk();

    $response = $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$id}/accounting-export");

    $response->assertCreated()
        ->assertJsonPath('state', 'generated')
        ->assertJsonPath('total_sales', '20.0000')
        ->assertJsonPath('total_tax', '4.2000')
        ->assertJsonPath('total_payments', '24.2000')
        // sales + tax − payments must net to zero.
        ->assertJsonPath('imbalance_amount', '0.0000');
});

it('never lets a device touch another register session', function (): void {
    $other = PosFixtures::make()->withSession();

    $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/sessions/'.$other->session->getKey().'/closing-data')
        ->assertStatus(404);
});

it('deletes a cash movement only for an employee holding cash.in_out.delete (REG-011)', function (): void {
    $this->fx->withSession();
    $sessionId = $this->fx->session->getKey();

    // Cash movements are addressed by uuid (HasUuid route binding).
    $movementUuid = (string) $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$sessionId}/cash-movements", [
            'movement_type' => 'cash_in',
            'amount' => '25.00',
            'employee_id' => $this->fx->cashier->getKey(),
        ])->assertCreated()->json('uuid');

    // A cashier proves identity but does not hold the ability — refused, movement survives.
    $this->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/sessions/{$sessionId}/cash-movements/{$movementUuid}", ['employee_id' => $this->fx->cashier->getKey(), 'pin' => '1234'])
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'forbidden');
    expect(CashMovement::query()->where('uuid', $movementUuid)->exists())->toBeTrue();

    // Passing the manager's id WITHOUT their PIN must not bypass the gate (the id is public).
    $this->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/sessions/{$sessionId}/cash-movements/{$movementUuid}", ['employee_id' => $this->fx->manager->getKey()])
        ->assertStatus(403);
    $this->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/sessions/{$sessionId}/cash-movements/{$movementUuid}", ['employee_id' => $this->fx->manager->getKey(), 'pin' => '0000'])
        ->assertStatus(403);
    expect(CashMovement::query()->where('uuid', $movementUuid)->exists())->toBeTrue();

    // A manager with the correct PIN holds cash.in_out.delete — deleted, session cash totals refreshed.
    $this->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/sessions/{$sessionId}/cash-movements/{$movementUuid}", ['employee_id' => $this->fx->manager->getKey(), 'pin' => '9999'])
        ->assertOk();
    expect(CashMovement::query()->where('uuid', $movementUuid)->exists())->toBeFalse();
});
