<?php

declare(strict_types=1);

// Own namespace so the helpers below stay out of the global function table Pest shares across every
// test file — a collision there is a fatal error that only surfaces on a full-suite run.

namespace Tests\Feature\Pos\CashMovementList;

use App\Models\Pos\CashMovement;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-420 — the drawer ledger (REG-011 … REG-013).
 *
 * Money could go into and out of the till with no way to see it afterwards, correct it, or hand
 * anyone a slip. "The drawer is 40 short" and "Karim took 40 to the bank at 15:20" are the same
 * fact told with and without this list, and only one of them ends the conversation.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession('100.00');
});

function moveCash(PosFixtures $fx, string $type, string $amount, ?string $reason = null, ?int $employeeId = null): TestResponse
{
    return test()->withHeaders($fx->headers())
        ->postJson("/api/pos/sessions/{$fx->session->getKey()}/cash-movements", array_filter([
            'movement_type' => $type,
            'amount' => $amount,
            'reason' => $reason,
            'employee_id' => $employeeId,
        ], static fn (mixed $v): bool => $v !== null));
}

function listMovements(PosFixtures $fx): TestResponse
{
    return test()->withHeaders($fx->headers())
        ->getJson("/api/pos/sessions/{$fx->session->getKey()}/cash-movements");
}

// ── the list ─────────────────────────────────────────────────────────────────

it('lists every movement of the session with its reason and who made it', function (): void {
    moveCash($this->fx, 'cash_in', '25.00', 'Change fund', $this->fx->cashier->getKey())->assertCreated();
    moveCash($this->fx, 'cash_out', '40.00', 'Bank run', $this->fx->manager->getKey())->assertCreated();

    $rows = listMovements($this->fx)->assertOk()->json('movements');

    expect($rows)->toHaveCount(2);

    expect($rows[0]['reason'])->toBe('Change fund')
        ->and($rows[0]['employee_name'])->toBe($this->fx->cashier->name)
        ->and((float) $rows[0]['amount'])->toBe(25.0);

    // Signed as stored, so the direction survives a client that only reads the number.
    expect($rows[1]['reason'])->toBe('Bank run')
        ->and($rows[1]['employee_name'])->toBe($this->fx->manager->name)
        ->and((float) $rows[1]['amount'])->toBe(-40.0);
});

it('answers with an empty list rather than a 404 on a session that has moved no cash', function (): void {
    expect(listMovements($this->fx)->assertOk()->json('movements'))->toBe([]);
});

it('never shows another register the movements of this one', function (): void {
    moveCash($this->fx, 'cash_in', '25.00', 'Change fund')->assertCreated();

    $other = PosFixtures::make()->withSession();

    test()->withHeaders($other->headers())
        ->getJson("/api/pos/sessions/{$this->fx->session->getKey()}/cash-movements")
        ->assertStatus(404);
});

it('leaves a withdrawn movement out of the ledger', function (): void {
    // The row survives for the audit trail — `deleteCashMovement` soft-deletes and logs — but a
    // movement that has been withdrawn is no longer part of the explanation of the drawer, and
    // showing it invites counting it twice.
    $uuid = (string) moveCash($this->fx, 'cash_in', '25.00', 'Mistyped')->assertCreated()->json('uuid');

    test()->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/sessions/{$this->fx->session->getKey()}/cash-movements/{$uuid}", [
            'employee_id' => $this->fx->manager->getKey(), 'pin' => '9999',
        ])->assertOk();

    expect(listMovements($this->fx)->assertOk()->json('movements'))->toBe([]);

    // …and it is still on the record, which is the half a soft delete exists for.
    expect(CashMovement::query()->withTrashed()->where('uuid', $uuid)->exists())->toBeTrue();
});

// ── delete, and what it does to the drawer ───────────────────────────────────

it('recomputes the expected drawer when a movement is removed', function (): void {
    // The AC that matters: the cashier is counting against a number, and removing a movement has to
    // move that number or they will be told they are short by exactly the amount just withdrawn.
    $uuid = (string) moveCash($this->fx, 'cash_out', '40.00', 'Bank run')->assertCreated()->json('uuid');

    $before = test()->withHeaders($this->fx->headers())
        ->getJson("/api/pos/sessions/{$this->fx->session->getKey()}/closing-data")
        ->assertOk()->json('expected_cash');

    expect((float) $before)->toBe(60.0);

    test()->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/sessions/{$this->fx->session->getKey()}/cash-movements/{$uuid}", [
            'employee_id' => $this->fx->manager->getKey(), 'pin' => '9999',
        ])->assertOk();

    $after = test()->withHeaders($this->fx->headers())
        ->getJson("/api/pos/sessions/{$this->fx->session->getKey()}/closing-data")
        ->assertOk();

    expect((float) $after->json('expected_cash'))->toBe(100.0);

    // …and the summary beside it, which is a *different* number from a different source. Expected
    // cash is summed from the movement rows, so it self-corrects; `cash_out_total` is a column on
    // the session that only moves when something writes it. Left stale, the closing pane shows a
    // ledger with no cash-out in it above a line that still says 40 went out.
    expect((float) $after->json('cash_out'))->toBe(0.0);
});

it('refuses to delete a movement belonging to another session', function (): void {
    $other = PosFixtures::make()->withSession();

    $foreign = (string) moveCash($other, 'cash_in', '10.00', 'Elsewhere')->assertCreated()->json('uuid');

    // Addressed through *this* register's session, with this register's token.
    test()->withHeaders($this->fx->headers())
        ->deleteJson("/api/pos/sessions/{$this->fx->session->getKey()}/cash-movements/{$foreign}", [
            'employee_id' => $this->fx->manager->getKey(), 'pin' => '9999',
        ])->assertStatus(404);

    expect(CashMovement::query()->where('uuid', $foreign)->exists())->toBeTrue();
});

// ── whose employee ───────────────────────────────────────────────────────────

it('refuses to attribute a movement to another company employee', function (): void {
    // `employee_id` is a bare integer on both routes in and nothing checked whose it was. A movement
    // recorded against another company's employee is a falsified record before it is anything else,
    // and it becomes a *disclosure* the moment the ledger resolves that id to a name.
    $theirs = PosFixtures::make();

    test()->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$this->fx->session->getKey()}/cash-movements", [
            'movement_type' => 'cash_out',
            'amount' => '10.00',
            'reason' => 'Crafted',
            'employee_id' => $theirs->manager->getKey(),
        ])
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'cash_move_refused');

    expect(CashMovement::query()->count())->toBe(0);
});

it('never names another company employee, even on a row already in the table', function (): void {
    // The write is guarded now; rows written before it was are not. `CompanyScope` does not apply to
    // device requests by design, so the read has to say so itself.
    $theirs = PosFixtures::make();
    $theirs->manager->forceFill(['name' => 'Somebody Elsewhere'])->save();

    $uuid = (string) moveCash($this->fx, 'cash_out', '10.00', 'Historic')->assertCreated()->json('uuid');

    // Straight into the table, the way a pre-guard row got there.
    CashMovement::query()->where('uuid', $uuid)->update(['employee_id' => $theirs->manager->getKey()]);

    $rows = listMovements($this->fx)->assertOk()->json('movements');

    expect($rows[0]['employee_name'])->toBeNull()
        ->and($rows[0]['reason'])->toBe('Historic');
});

it('still names an employee of its own company', function (): void {
    moveCash($this->fx, 'cash_in', '25.00', 'Change fund', $this->fx->cashier->getKey())->assertCreated();

    expect(listMovements($this->fx)->assertOk()->json('movements.0.employee_name'))
        ->toBe($this->fx->cashier->name);
});

// ── the amount, on both ways in ──────────────────────────────────────────────

it('refuses an amount bcmath cannot read on the sync command path too', function (): void {
    // BAN-507 validated the HTTP endpoint. The sync path arrives through the generic `commands[]`
    // envelope, whose payload is typed `array` and nothing more — so `'plenty'` went into a
    // `decimal(16,4)` column and was summed into the expected drawer. Guarded in `cashMove`, which
    // is the one thing both routes go through.
    $response = test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'commands' => [[
            'uuid' => (string) Str::uuid(),
            'kind' => 'session.cash_move',
            'at' => now()->toIso8601String(),
            'payload' => [
                'uuid' => (string) Str::uuid(),
                'session_id' => $this->fx->session->getKey(),
                'movement_type' => 'cash_in',
                'amount' => 'plenty',
                'reason' => 'nonsense',
            ],
        ]],
    ])->assertOk();

    // Under `results`, not `command_results` — commands and orders share one result array, which is
    // what makes `boot.ts` mark the outbox entry quarantined and surface it in the sync drawer. An
    // assertion on the wrong key would have compared `null` against `'ok'` and passed for nothing.
    expect($response->json('results.0.status'))->toBe('rejected')
        ->and($response->json('results.0.error.code'))->toBe('command_failed');

    expect(CashMovement::query()->count())->toBe(0);
});

it('still takes an ordinary amount down the sync path', function (): void {
    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'commands' => [[
            'uuid' => (string) Str::uuid(),
            'kind' => 'session.cash_move',
            'at' => now()->toIso8601String(),
            'payload' => [
                'uuid' => (string) Str::uuid(),
                'session_id' => $this->fx->session->getKey(),
                'movement_type' => 'cash_out',
                'amount' => '20.00',
                'reason' => 'Milk run',
                'employee_id' => $this->fx->cashier->getKey(),
            ],
        ]],
    ])->assertOk();

    $rows = listMovements($this->fx)->assertOk()->json('movements');

    expect($rows)->toHaveCount(1)
        ->and((float) $rows[0]['amount'])->toBe(-20.0)
        ->and($rows[0]['employee_name'])->toBe($this->fx->cashier->name);
});
