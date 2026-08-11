<?php

declare(strict_types=1);

// Own namespace so the helpers below stay out of the global function table Pest shares across every
// test file — a collision there is a fatal error that only surfaces on a full-suite run.

namespace Tests\Feature\Pos\SessionEventLog;

use App\Enums\SessionEventType;
use App\Models\Pos\SessionEvent;
use App\Services\Pos\SessionEventRecorder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-438 / REG-024 — what happened to this till, in order.
 *
 * `audit_logs` records who did what to an *order* and `cash_movements` records money moving.
 * Neither answers the question a manager actually asks the morning after: what happened to this
 * session yesterday? Reconstructing "the float was confirmed at 08:12, someone pulled a reading at
 * 14:30, the close was forced at 23:58" from a state column and three other tables is guesswork.
 *
 * The property that matters is **exactly one row per lifecycle transition**. A close runs inside a
 * transaction that can be retried and an order push can reroute into a rescue session more than
 * once, so the guarantee lives in the recorder rather than in each caller.
 */

/** @return list<string> */
function typesFor(int $sessionId): array
{
    return SessionEvent::query()
        ->where('pos_session_id', $sessionId)
        ->orderBy('id')
        ->pluck('event_type')
        ->map(static fn (SessionEventType $type): string => $type->value)
        ->all();
}

it('records a whole shift in the order it happened', function (): void {
    $fx = PosFixtures::make(['has_cash_control' => true]);

    $id = (int) test()->withHeaders($fx->headers())
        ->postJson('/api/pos/sessions', ['opening_float' => '100.00'])->assertCreated()->json('id');

    test()->withHeaders($fx->headers())
        ->postJson("/api/pos/sessions/{$id}/opening-control", ['counted_float' => '100.00'])->assertOk();

    foreach ([['cash_in', '20.00'], ['cash_out', '5.00']] as [$type, $amount]) {
        test()->withHeaders($fx->headers())->postJson("/api/pos/sessions/{$id}/cash-movements", [
            'movement_type' => $type, 'amount' => $amount, 'reason' => 'till float',
        ])->assertCreated();
    }

    test()->withHeaders($fx->headers())->getJson("/api/pos/sessions/{$id}/x-report")->assertOk();

    test()->withHeaders($fx->headers())
        ->postJson("/api/pos/sessions/{$id}/close", ['counted_cash' => '115.00'])->assertOk();

    expect(typesFor($id))->toBe([
        SessionEventType::Opened->value,
        SessionEventType::OpeningControlConfirmed->value,
        SessionEventType::CashIn->value,
        SessionEventType::CashOut->value,
        SessionEventType::XReport->value,
        SessionEventType::Closed->value,
    ]);
});

it('records each transition exactly once', function (): void {
    // The acceptance criterion. `close()` runs in a transaction that can be retried, and a caller
    // that recorded per attempt would turn one shift into a till that ended twice.
    $fx = PosFixtures::make()->withSession('100.00');
    $id = (int) $fx->session->getKey();

    test()->withHeaders($fx->headers())
        ->postJson("/api/pos/sessions/{$id}/close", ['counted_cash' => '100.00'])->assertOk();

    // A second close is refused by the state machine, but the recorder must not depend on that.
    app(SessionEventRecorder::class)->record($fx->session, SessionEventType::Closed);

    expect(SessionEvent::query()->where('pos_session_id', $id)
        ->where('event_type', SessionEventType::Closed->value)->count())->toBe(1);
});

it('appends the actions a shift can genuinely repeat', function (): void {
    // Two readings are two readings, and two cash-outs are two cash-outs. Deduping these would lose
    // the very thing the log is for — a drawer opened four times in an hour is a pattern.
    $fx = PosFixtures::make()->withSession('100.00');
    $id = (int) $fx->session->getKey();

    foreach (range(1, 3) as $ignored) {
        test()->withHeaders($fx->headers())->getJson("/api/pos/sessions/{$id}/x-report")->assertOk();
    }

    foreach (range(1, 2) as $ignored) {
        test()->withHeaders($fx->headers())->postJson("/api/pos/sessions/{$id}/cash-movements", [
            'movement_type' => 'cash_out', 'amount' => '5.00', 'reason' => 'courier',
        ])->assertCreated();
    }

    expect(SessionEvent::query()->where('event_type', SessionEventType::XReport->value)->count())->toBe(3)
        ->and(SessionEvent::query()->where('event_type', SessionEventType::CashOut->value)->count())->toBe(2);
});

it('marks a forced close as forced, and only once', function (): void {
    // Two facts a manager reads differently: a shift that ended, and a shift that was ended over
    // something unresolved. Recording both would make every forced close look like two events.
    $fx = PosFixtures::make()->withSession('100.00');
    $id = (int) $fx->session->getKey();

    // A draft the close has to be forced past.
    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand((string) Str::uuid())],
    ])->assertOk();

    test()->withHeaders($fx->headers())
        ->postJson("/api/pos/sessions/{$id}/close", ['counted_cash' => '100.00', 'force' => true])
        ->assertOk();

    expect(typesFor($id))->toBe([SessionEventType::ForceClosed->value]);
});

it('carries enough payload to read the row a month later', function (): void {
    $fx = PosFixtures::make(['has_cash_control' => true]);

    $id = (int) test()->withHeaders($fx->headers())
        ->postJson('/api/pos/sessions', ['opening_float' => '80.00'])->assertCreated()->json('id');

    $opened = SessionEvent::query()->where('pos_session_id', $id)
        ->where('event_type', SessionEventType::Opened->value)->firstOrFail();

    expect($opened->payload['opening_float'])->toBe('80.00');

    test()->withHeaders($fx->headers())->getJson("/api/pos/sessions/{$id}/x-report")->assertOk();

    $reading = SessionEvent::query()->where('event_type', SessionEventType::XReport->value)->firstOrFail();

    // The figures as they stood at the reading — the point of recording a reading at all is being
    // able to say what it said.
    expect($reading->payload)->toHaveKeys(['sales', 'tax', 'refunds', 'expected_cash']);
});

it('records a rescue against the session that was created to catch the orders', function (): void {
    // Not against the session it rescued: that one is closed and its story has ended.
    $fx = PosFixtures::make()->withSession('0');
    $closedId = (int) $fx->session->getKey();

    test()->withHeaders($fx->headers())
        ->postJson("/api/pos/sessions/{$closedId}/close", ['counted_cash' => '0'])->assertOk();

    // An order arriving for a session that has gone.
    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand((string) Str::uuid())],
    ])->assertOk();

    $rescue = SessionEvent::query()->where('event_type', SessionEventType::Rescued->value)->first();

    expect($rescue)->not->toBeNull()
        ->and((int) $rescue->pos_session_id)->not->toBe($closedId)
        ->and($rescue->payload)->toHaveKey('rescued_from_session_id');
});
