<?php

declare(strict_types=1);

// Own namespace so the `openRegister` / `otherCurrency` helpers below stay out of the global
// function table Pest shares across every test file — a name collision there is a fatal error that
// only shows up when the whole suite runs.

namespace Tests\Feature\Pos\SessionOpenValidation;

use App\Enums\CashMovementType;
use App\Enums\SessionState;
use App\Models\Identity\Company;
use App\Models\Pos\PosSession;
use App\Models\Pricing\Currency;
use App\Models\Pricing\FiscalPosition;
use App\Models\User;
use App\Services\Pos\RegisterReadiness;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-417 — a register that cannot trade must not open a session (REG-002 … REG-004).
 *
 * The failure this replaces was silent and late: a misconfigured register opened happily, took a
 * float, took orders, and fell over at the payment screen with a queue behind it. Every test here is
 * about moving that discovery to the one screen where it costs nothing.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make(['has_cash_control' => true]);
});

/** Open a session over the API with whatever the fixture register currently looks like. */
function openRegister(PosFixtures $fx, array $payload = []): TestResponse
{
    return test()->withHeaders($fx->headers())
        ->postJson('/api/pos/sessions', ['opening_float' => '0', ...$payload]);
}

// ── the gate ─────────────────────────────────────────────────────────────────

it('refuses to open a register with no payment method, and creates nothing', function (): void {
    $this->fx->config->paymentMethods()->detach();

    openRegister($this->fx)
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'register_not_ready')
        ->assertJsonPath('error.problems.0.code', RegisterReadiness::NoPaymentMethod);

    // "No session row is created" is the half that matters: a register left holding a phantom
    // opening_control session cannot be opened again once the configuration is fixed.
    expect(PosSession::query()->count())->toBe(0);
});

it('names every missing piece at once, not just the first', function (): void {
    // A manager walking back to the back office should be able to fix everything in one trip.
    $this->fx->config->paymentMethods()->detach();
    $this->fx->config->forceFill(['currency_id' => otherCurrency()->getKey()])->save();

    $codes = openRegister($this->fx)->assertStatus(422)->json('error.problems.*.code');

    expect($codes)->toContain(RegisterReadiness::NoPaymentMethod)
        ->toContain(RegisterReadiness::CurrencyMismatch);
});

it('counts an archived payment method as no payment method', function (): void {
    // Archived methods never reach the payment screen, so a register left with only archived ones
    // is indistinguishable from one with none — except that the count looks reassuring.
    $this->fx->cash->forceFill(['active' => false])->save();
    $this->fx->card->forceFill(['active' => false])->save();

    openRegister($this->fx)
        ->assertStatus(422)
        ->assertJsonPath('error.problems.0.code', RegisterReadiness::NoPaymentMethod);
});

it('counts another company payment method as no payment method', function (): void {
    // The `pos_config_payment_method` pivot carries no tenancy check of its own, so a method from
    // another company can be attached — and would book this venue's takings against that ledger.
    $other = PosFixtures::make();

    $this->fx->config->paymentMethods()->sync([$other->cash->getKey() => ['sequence' => 10]]);

    openRegister($this->fx)
        ->assertStatus(422)
        ->assertJsonPath('error.problems.0.code', RegisterReadiness::NoPaymentMethod);
});

it('refuses a register trading in a currency its company does not use', function (): void {
    // Nothing downstream re-converts: the session, its orders and the export all carry this
    // currency, so the day books at face value in the wrong unit and surfaces at the bank.
    $this->fx->config->forceFill(['currency_id' => otherCurrency()->getKey()])->save();

    openRegister($this->fx)
        ->assertStatus(422)
        ->assertJsonPath('error.problems.0.code', RegisterReadiness::CurrencyMismatch);
});

it('refuses a default fiscal position belonging to another company', function (): void {
    // `FiscalPosition::posLoadScope` only replicates the register's own company, so this default is
    // never sent to the till — every order would be priced against a mapping it does not have.
    $foreign = Company::query()->create([
        'name' => 'Elsewhere SARL', 'currency_id' => $this->fx->currency->getKey(), 'timezone' => 'UTC',
    ]);

    $position = FiscalPosition::query()->create([
        'company_id' => $foreign->getKey(), 'name' => 'Takeaway', 'sequence' => 10, 'active' => true,
    ]);

    $this->fx->config->forceFill([
        'use_fiscal_positions' => true,
        'default_fiscal_position_id' => $position->getKey(),
    ])->save();

    openRegister($this->fx)
        ->assertStatus(422)
        ->assertJsonPath('error.problems.0.code', RegisterReadiness::FiscalPositionUnresolved);
});

it('accepts a default fiscal position of its own company', function (): void {
    $position = FiscalPosition::query()->create([
        'company_id' => $this->fx->company->getKey(), 'name' => 'Eat in', 'sequence' => 10, 'active' => true,
    ]);

    $this->fx->config->forceFill([
        'use_fiscal_positions' => true,
        'default_fiscal_position_id' => $position->getKey(),
    ])->save();

    openRegister($this->fx)->assertCreated();
});

it('ignores the fiscal position entirely when the register does not use them', function (): void {
    // The column is unread everywhere else with the feature off; refusing to open over it would be
    // theatre, and would block a register that trades perfectly well.
    $foreign = Company::query()->create([
        'name' => 'Elsewhere SARL', 'currency_id' => $this->fx->currency->getKey(), 'timezone' => 'UTC',
    ]);

    $position = FiscalPosition::query()->create([
        'company_id' => $foreign->getKey(), 'name' => 'Takeaway', 'sequence' => 10, 'active' => true,
    ]);

    $this->fx->config->forceFill([
        'use_fiscal_positions' => false,
        'default_fiscal_position_id' => $position->getKey(),
    ])->save();

    openRegister($this->fx)->assertCreated();
});

it('keeps register_not_ready distinct from an already-open session', function (): void {
    // Two different fixes: one is a trip to the back office, the other is closing the session that
    // is already open. A single code would send the cashier to the wrong one.
    openRegister($this->fx)->assertCreated();

    openRegister($this->fx)
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'session_open_failed');
});

// ── the session number ───────────────────────────────────────────────────────

it('does not mint a session number until the opening control is confirmed', function (): void {
    $created = openRegister($this->fx, ['opening_float' => '150.00'])->assertCreated();

    expect($created->json('state'))->toBe(SessionState::OpeningControl->value)
        ->and($created->json('name'))->toBeNull();

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$created->json('id')}/opening-control", ['counted_float' => '150.00'])
        ->assertOk()
        ->assertJsonPath('name', 'Bar/00001');
});

it('an abandoned opening control does not consume a session number', function (): void {
    // The whole point of moving the mint: a number burnt on a session that never traded leaves a
    // gap in the sequence that an accountant has to explain away.
    $abandoned = openRegister($this->fx)->assertCreated()->json('id');

    // `abandon` is the point: a session that never traded is not closed like a shift, it is given
    // up on, and since BAN-425 the till has to say so (REG-017).
    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$abandoned}/close", ['counted_cash' => '0', 'abandon' => true])
        ->assertOk();

    $second = openRegister($this->fx)->assertCreated()->json('id');

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$second}/opening-control", ['counted_float' => '0'])
        ->assertOk()
        ->assertJsonPath('name', 'Bar/00001');

    expect(PosSession::query()->whereKey($abandoned)->value('name'))->toBeNull();
});

it('numbers a register that skips the opening control at create', function (): void {
    // Without cash control there is no opening control to confirm — the session is trading the
    // moment it exists, so it is numbered the moment it exists.
    $this->fx->config->forceFill(['has_cash_control' => false])->save();

    openRegister($this->fx)
        ->assertCreated()
        ->assertJsonPath('state', SessionState::Opened->value)
        ->assertJsonPath('name', 'Bar/00001');
});

it('keeps numbering consecutive across a normal day', function (): void {
    foreach (['Bar/00001', 'Bar/00002', 'Bar/00003'] as $expected) {
        $id = openRegister($this->fx)->assertCreated()->json('id');

        $this->withHeaders($this->fx->headers())
            ->postJson("/api/pos/sessions/{$id}/opening-control", ['counted_float' => '0'])
            ->assertOk()
            ->assertJsonPath('name', $expected);

        $this->withHeaders($this->fx->headers())
            ->postJson("/api/pos/sessions/{$id}/close", ['counted_cash' => '0'])
            ->assertOk();
    }
});

// ── an unnamed session is still a usable session ─────────────────────────────

it('gives the back office something to call a session with no number yet', function (): void {
    // `Sessions/Show` types `name` as a string and uses it as the phrase a manager must type back to
    // confirm the close. A null phrase can never be matched — `typed.trim() === null` is false for
    // every string — so the close button became impossible to confirm on precisely the sessions a
    // manager most needs to clear: an abandoned opening control holds the one-open-session index and
    // blocks the register until it is closed.
    $this->withoutVite();
    $this->actingAs(User::factory()->create(['is_super_admin' => true]));

    $id = openRegister($this->fx)->assertCreated()->json('id');
    $session = PosSession::query()->findOrFail($id);

    expect($session->name)->toBeNull();

    $props = $this->withHeaders(['X-Inertia' => 'true', 'X-Inertia-Version' => PosFixtures::inertiaVersion()])
        ->get('/sessions/'.$session->uuid)
        ->assertOk()
        ->json('props.session');

    expect($props['name'])->toBeString()->not->toBe('');
});

it('gives the session report the same fallback', function (): void {
    $this->withoutVite();
    $this->actingAs(User::factory()->create(['is_super_admin' => true]));

    $id = openRegister($this->fx)->assertCreated()->json('id');

    $props = $this->withHeaders(['X-Inertia' => 'true', 'X-Inertia-Version' => PosFixtures::inertiaVersion()])
        ->get('/reports/session?session_id='.$id)
        ->assertOk()
        ->json('props.session');

    expect($props['name'])->toBeString()->not->toBe('');
});

// ── the drawer ledger ────────────────────────────────────────────────────────

it('records the opening float even on a register that does not count its drawer', function (): void {
    // Gating the ledger row on `has_cash_control` was harmless only while such a register always
    // opened at zero — which stopped being true when the expected float started carrying over.
    // Nothing sums `opening_float`, so expected cash was never wrong; the movements list a manager
    // reads simply could not account for the opening balance.
    $this->fx->config->forceFill(['has_cash_control' => false])->save();

    $id = openRegister($this->fx, ['opening_float' => '135.50'])->assertCreated()->json('id');

    $rows = DB::table('cash_movements')
        ->where('pos_session_id', $id)
        ->where('movement_type', CashMovementType::OpeningFloat->value)
        ->pluck('amount');

    expect($rows)->toHaveCount(1)
        ->and((float) $rows->first())->toBe(135.5);
});

it('writes no opening-float row for a register that opens at nothing', function (): void {
    // The other half of the rule: a zero float moved no money, and a ledger row saying so is noise.
    $this->fx->config->forceFill(['has_cash_control' => false])->save();

    $id = openRegister($this->fx)->assertCreated()->json('id');

    expect(DB::table('cash_movements')->where('pos_session_id', $id)->count())->toBe(0);
});

it('refuses an opening float bcmath cannot read', function (): void {
    // `is_numeric('1e2')` is true and `bccomp('1e2', …)` throws — the difference between a rejected
    // payload and a 500 (BAN-413). Rejected at the boundary rather than guarded downstream.
    openRegister($this->fx, ['opening_float' => '1e2'])->assertStatus(422);
    openRegister($this->fx, ['opening_float' => 'plenty'])->assertStatus(422);

    expect(PosSession::query()->count())->toBe(0);
});

// ── the expected float ───────────────────────────────────────────────────────

it('tells the register what the drawer should hold before a session exists', function (): void {
    // REG-004. The open pane cannot work this out for itself — it lives in the previous close.
    $first = openRegister($this->fx, ['opening_float' => '100.00'])->assertCreated()->json('id');

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$first}/opening-control", ['counted_float' => '100.00'])
        ->assertOk();

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$first}/close", ['counted_cash' => '135.50'])
        ->assertOk();

    $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/sessions/current')
        ->assertOk()
        ->assertJsonPath('session', null)
        ->assertJsonPath('opening.expected_float', '135.5000')
        ->assertJsonPath('opening.problems', []);
});

it('carries the expected float onto the session it opens', function (): void {
    $first = openRegister($this->fx, ['opening_float' => '100.00'])->assertCreated()->json('id');

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$first}/opening-control", ['counted_float' => '100.00'])
        ->assertOk();

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$first}/close", ['counted_cash' => '135.50'])
        ->assertOk();

    // The counted float and what was expected of it, side by side under the names the client reads.
    openRegister($this->fx, ['opening_float' => '120.00'])
        ->assertCreated()
        ->assertJsonPath('opening_float', '120.0000')
        ->assertJsonPath('expected_opening_float', '135.5000');
});

it('warns the register about its configuration before the drawer is counted', function (): void {
    // The refusal at open is the gate; this is the point of it. Telling someone at 07:55 that there
    // is no payment method is worth more than telling them at 12:30.
    $this->fx->config->paymentMethods()->detach();

    $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/sessions/current')
        ->assertOk()
        ->assertJsonPath('opening.problems.0.code', RegisterReadiness::NoPaymentMethod);
});

/** A second currency, so a register can be pointed away from its company's. */
function otherCurrency(): Currency
{
    return Currency::query()->create([
        'code' => 'XOF', 'name' => 'Franc CFA', 'symbol' => 'F',
        'decimal_places' => 0, 'rounding' => 1, 'active' => true,
    ]);
}
