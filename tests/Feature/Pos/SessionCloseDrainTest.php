<?php

declare(strict_types=1);

// Own namespace so the helpers below stay out of the global function table Pest shares across every
// test file — a collision there is a fatal error that only surfaces on a full-suite run.

namespace Tests\Feature\Pos\SessionCloseDrain;

use App\Enums\OrderState;
use App\Enums\SessionState;
use App\Models\Pos\Order;
use App\Models\Pos\PosSession;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-425 — the server half of a hardened close (REG-017, REG-019).
 *
 * Closing a session decides which day a sale belongs to. Everything here is about a close that
 * files money in the wrong period, or refuses over an order that was never today's business.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession('100.00');
});

function closeIt(PosFixtures $fx, array $payload = []): TestResponse
{
    return test()->withHeaders($fx->headers())
        ->postJson("/api/pos/sessions/{$fx->session->getKey()}/close", ['counted_cash' => '100.00', ...$payload]);
}

/** A draft on the fixture session, optionally booked for later. */
function draftBookedFor(PosFixtures $fx, ?string $presetTime): string
{
    $uuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [], array_filter(['preset_time' => $presetTime]))],
    ])->assertOk()->assertJsonPath('results.0.status', 'ok');

    return $uuid;
}

// ── drafts booked for later ──────────────────────────────────────────────────

it('does not let tomorrow lunchtime block tonight close', function (): void {
    // A table booked for tomorrow is taken today and deliberately left open. Counting it against
    // tonight's close tells the cashier to settle an order whose customer has not arrived.
    draftBookedFor($this->fx, now()->addDay()->toIso8601String());

    closeIt($this->fx)->assertOk()->assertJsonPath('state', SessionState::Closed->value);
});

it('still blocks on an ordinary unfinished order', function (): void {
    // The guard itself has to survive: an untimed draft is tonight's loose end and still stops the
    // close until it is settled, cancelled, or explicitly forced.
    draftBookedFor($this->fx, null);

    closeIt($this->fx)->assertStatus(422)->assertJsonPath('error.code', 'session_close_refused');
});

it('still blocks on a draft whose booking has already passed', function (): void {
    // `preset_time` in the past is a table that should have been served hours ago — very much
    // tonight's business, and exactly the sort of order a close should not walk past.
    draftBookedFor($this->fx, now()->subHour()->toIso8601String());

    closeIt($this->fx)->assertStatus(422);
});

it('carries the future booking into the next session', function (): void {
    // `pos_orders.pos_session_id` is not nullable, so nothing moves at close. The reroute happens
    // when the order is next touched — which is what makes leaving it attached harmless.
    $uuid = draftBookedFor($this->fx, now()->addDay()->toIso8601String());
    $closedId = (int) $this->fx->session->getKey();

    closeIt($this->fx)->assertOk();

    $this->fx->withSession('100.00');

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid, [], ['state' => OrderState::Paid->value], [[
            'op' => 'create', 'uuid' => (string) Str::uuid(),
            'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '24.20',
        ]])],
    ])->assertOk()->assertJsonPath('results.0.status', 'ok');

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((int) $order->pos_session_id)->not->toBe($closedId)
        ->and((int) $order->pos_session_id)->toBe((int) $this->fx->session->getKey());
});

// ── a session that never traded ──────────────────────────────────────────────

it('refuses to close a session still awaiting its opening control', function (): void {
    // No sales, no sequence number, an opening float nobody confirmed. Closing it produces a
    // Z-report for a day that never happened.
    $fresh = PosFixtures::make(['has_cash_control' => true]);

    $id = test()->withHeaders($fresh->headers())
        ->postJson('/api/pos/sessions', ['opening_float' => '0'])->assertCreated()->json('id');

    test()->withHeaders($fresh->headers())
        ->postJson("/api/pos/sessions/{$id}/close", ['counted_cash' => '0'])
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'session_close_refused');

    expect(PosSession::query()->whereKey($id)->value('state'))->toBe(SessionState::OpeningControl);
});

it('abandons it when the till says that is what it means', function (): void {
    $fresh = PosFixtures::make(['has_cash_control' => true]);

    $id = test()->withHeaders($fresh->headers())
        ->postJson('/api/pos/sessions', ['opening_float' => '0'])->assertCreated()->json('id');

    test()->withHeaders($fresh->headers())
        ->postJson("/api/pos/sessions/{$id}/close", ['counted_cash' => '0', 'abandon' => true])
        ->assertOk()
        ->assertJsonPath('state', SessionState::Closed->value);
});

it('does not ask for the word on a session that has been trading', function (): void {
    // `abandon` guards the never-traded case only; an ordinary shift closes as it always did.
    closeIt($this->fx)->assertOk();
});

// ── closing notes ────────────────────────────────────────────────────────────

it('keeps the closing note the cashier typed', function (): void {
    // The column has been there all along and nothing ever sent one. It is where "till 2 was 5
    // short, Amina counted it twice" goes — the sentence that stops a variance becoming an argument
    // a week later.
    closeIt($this->fx, ['notes' => 'Drawer 5 short, recounted with Karim.'])->assertOk();

    expect(PosSession::query()->whereKey($this->fx->session->getKey())->value('closing_notes'))
        ->toBe('Drawer 5 short, recounted with Karim.');
});
