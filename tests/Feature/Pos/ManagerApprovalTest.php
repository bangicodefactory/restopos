<?php

declare(strict_types=1);

// Own namespace so the helpers below stay out of the global function table Pest shares across every
// test file — a collision there is a fatal error that only surfaces on a full-suite run.

namespace Tests\Feature\Pos\ManagerApproval;

use App\Enums\SessionState;
use App\Models\Audit\AuditLog;
use App\Models\Pos\OrderLine;
use App\Models\Pos\PosSession;
use App\Support\Audit\AuditEvent;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-430 / REG-016, REG-045 — a manager override has to survive being checked.
 *
 * The client half of this has worked for a long time: `approval.ts` prompts for a PIN, verifies it,
 * and records an `ApprovalRow`; BAN-413 then started syncing those rows onto the audit trail. What
 * nobody did was check them at the far end. The ability was a free string and the approver was
 * whatever the device said, so the trail recorded — in good faith — exactly what a patched till told
 * it to, and the discount cap the register enforces on screen was enforced *only* on screen.
 *
 * Two of the ticket's acceptance criteria were already met when this was picked up (the
 * over-variance close verifies the PIN and the ability server-side, and refuses a wrong one). They
 * are covered here anyway: they were unpinned, and an untested guard is one revert away from being
 * gone.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();
});

/** One line at €10, discounted, pushed by whoever the caller names. */
function pushDiscount(PosFixtures $fx, string $discount, ?int $employeeId, array $approvals = []): TestResponse
{
    $command = $fx->orderCommand((string) Str::uuid(), [[
        'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
        'qty' => '1', 'price_unit' => '10.00', 'discount' => $discount,
    ]]);
    $command['approvals'] = $approvals;

    return test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'employee_id' => $employeeId,
        'orders' => [$command],
    ]);
}

/** What actually landed on the only line of the most recent order. */
function storedDiscount(): string
{
    return (string) OrderLine::query()->orderByDesc('id')->value('discount_percent');
}

/** @return list<string> */
function warningCodes(TestResponse $response): array
{
    return array_column((array) $response->json('results.0.warnings'), 'code');
}

/** An approval claim, as `persistence.ts` sends one. */
function approval(string $ability, ?int $employeeId, string $verified = 'online'): array
{
    return [[
        'uuid' => (string) Str::uuid(),
        'ability' => $ability,
        'manager_employee_id' => $employeeId,
        'verified' => $verified,
        'at' => now()->toIso8601ZuluString(),
    ]];
}

// ── the discount cap ─────────────────────────────────────────────────────────

it('cuts an over-limit discount back when nobody authorised it', function (): void {
    // The hole. `pos.discount_limit_percent` is 30 and the register gates on it, but the server
    // picked `discount` straight out of the command and wrote it — so a patched till sent 100 and
    // took the sale to zero, silently, with the cap intact on every screen in the building.
    $response = pushDiscount($this->fx, '100', (int) $this->fx->cashier->getKey());

    $response->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect(storedDiscount())->toBe('30.0000')
        ->and(warningCodes($response))->toContain('discount_above_limit_refused');
});

it('lets it through when a manager actually granted it', function (): void {
    // The other half, and the reason this is a cap rather than a ban: an authorised discount is an
    // ordinary part of the job, and a fix that refused them all would be reverted by Friday.
    $response = pushDiscount(
        $this->fx,
        '90',
        (int) $this->fx->cashier->getKey(),
        approval('line.discount.above_limit', (int) $this->fx->manager->getKey()),
    );

    $response->assertOk();

    expect(storedDiscount())->toBe('90.0000')
        ->and(warningCodes($response))->not->toContain('discount_above_limit_refused');
});

it('lets a manager pushing their own order past the limit', function (): void {
    // No approval row needed: they hold `line.discount.above_limit` in their own right, and asking
    // a manager to approve themselves is the kind of ceremony people learn to route around.
    pushDiscount($this->fx, '90', (int) $this->fx->manager->getKey())->assertOk();

    expect(storedDiscount())->toBe('90.0000');
});

it('leaves an ordinary discount alone', function (): void {
    // The common case by far, and the one a clumsy fix breaks.
    $response = pushDiscount($this->fx, '10', (int) $this->fx->cashier->getKey());

    expect(storedDiscount())->toBe('10.0000')
        ->and(warningCodes($response))->toBe([]);
});

it('treats the limit itself as allowed', function (): void {
    // Exactly 30 is within a cashier's authority; only *past* it needs a manager. An off-by-one
    // here is a cashier who cannot apply the discount the poster in the window advertises.
    pushDiscount($this->fx, '30', (int) $this->fx->cashier->getKey())->assertOk();

    expect(storedDiscount())->toBe('30.0000');
});

it('cuts one back on an edit as well as on a create', function (): void {
    // The route the register actually uses: a line is created, then edited. Enforcing only on
    // create leaves the whole thing open to a push with two commands in it.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'employee_id' => $this->fx->cashier->getKey(),
        'orders' => [$this->fx->orderCommand($orderUuid, [[
            'op' => 'create', 'uuid' => $lineUuid, 'variant_id' => $this->fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        ]])],
    ])->assertOk();

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'employee_id' => $this->fx->cashier->getKey(),
        'orders' => [$this->fx->orderCommand($orderUuid, [[
            'op' => 'update', 'uuid' => $lineUuid, 'discount' => '95',
        ]])],
    ])->assertOk();

    expect((string) OrderLine::query()->where('uuid', $lineUuid)->value('discount_percent'))->toBe('30.0000');
});

// ── the approvals themselves ─────────────────────────────────────────────────

it('refuses an approval signed by somebody who lacks the ability', function (): void {
    // The forgery this exists to catch, and it is the cheap one: the cashier signs their own
    // override. Before this the row went onto the trail naming them as the approving manager, so
    // the report a manager reaches for when money is missing agreed with whoever took it.
    $response = pushDiscount(
        $this->fx,
        '90',
        (int) $this->fx->cashier->getKey(),
        approval('line.discount.above_limit', (int) $this->fx->cashier->getKey()),
    );

    $response->assertOk();

    expect(storedDiscount())->toBe('30.0000')
        ->and(warningCodes($response))->toContain('approval_refused')
        ->and(AuditLog::query()->where('event', AuditEvent::EmployeeOverride)->exists())->toBeFalse();

    $refusal = AuditLog::query()->where('event', AuditEvent::EmployeeOverrideRefused)->firstOrFail();

    expect($refusal->changes['reason']['new'])->toBe('approver_lacks_ability')
        // Hung on the till that asked, never on the manager it named.
        ->and((int) $refusal->actor_employee_id)->toBe((int) $this->fx->cashier->getKey());
});

it('refuses an ability nothing in the system defines', function (): void {
    // `order.discount` and `order.line.delete` are not abilities — and the shipped tests for the
    // audit trail used both, which is how this was found. A claim naming a permission that does not
    // exist is a client no build of ours produces.
    $response = pushDiscount(
        $this->fx,
        '90',
        (int) $this->fx->cashier->getKey(),
        approval('nuclear.launch', (int) $this->fx->manager->getKey()),
    );

    expect(warningCodes($response))->toContain('approval_refused')
        ->and(AuditLog::query()->where('event', AuditEvent::EmployeeOverrideRefused)->value('changes'))
        ->toMatchArray(['reason' => ['old' => null, 'new' => 'unknown_ability']]);
});

it('refuses an approver from another venue', function (): void {
    // A real manager, a real ability, and a company that has nothing to do with this till. The
    // employee lookup is scoped to the config, so their id is simply not a candidate here.
    $other = PosFixtures::make();

    $response = pushDiscount(
        $this->fx,
        '90',
        (int) $this->fx->cashier->getKey(),
        approval('line.discount.above_limit', (int) $other->manager->getKey()),
    );

    expect(storedDiscount())->toBe('30.0000')
        ->and(warningCodes($response))->toContain('approval_refused')
        ->and(AuditLog::query()->where('event', AuditEvent::EmployeeOverrideRefused)->value('changes'))
        ->toMatchArray(['reason' => ['old' => null, 'new' => 'unknown_approver']]);
});

it('refuses an approval with no approver at all', function (): void {
    $response = pushDiscount(
        $this->fx,
        '90',
        (int) $this->fx->cashier->getKey(),
        approval('line.discount.above_limit', null),
    );

    expect(storedDiscount())->toBe('30.0000')
        ->and(warningCodes($response))->toContain('approval_refused');
});

it('still records a genuine override once, on the trail, with its verification', function (): void {
    // BAN-413's contract, re-pinned now that the claim is checked: one row, the real approver, and
    // whether the PIN was checked online or against a cached hash.
    pushDiscount(
        $this->fx,
        '90',
        (int) $this->fx->cashier->getKey(),
        approval('line.discount.above_limit', (int) $this->fx->manager->getKey(), 'offline'),
    )->assertOk();

    $log = AuditLog::query()->where('event', AuditEvent::EmployeeOverride)->firstOrFail();

    expect((int) $log->actor_employee_id)->toBe((int) $this->fx->manager->getKey())
        ->and($log->changes['ability']['new'])->toBe('line.discount.above_limit')
        ->and($log->changes['verified']['new'])->toBe('offline')
        // Offline could only be checked against a cached hash, so it is not a quiet notice.
        ->and($log->severity->value)->toBe('warning');
});

it('refuses an approval already spent on another order', function (): void {
    // An approval is a manager authorising *one* thing. `approval.ts` has always known that - it
    // stores each row against an `order_uuid` - but nothing made the server agree, so the row was a
    // bearer token: get one 90% discount signed off, keep it, and replay it on every order for the
    // rest of the shift.
    //
    // Worse, it was invisible. `recordApprovals()` skips a uuid already on the trail, so the dedupe
    // that stops one override being counted forty times was hiding thirty-nine.
    $claim = approval('line.discount.above_limit', (int) $this->fx->manager->getKey());

    pushDiscount($this->fx, '90', (int) $this->fx->cashier->getKey(), $claim)->assertOk();

    expect(storedDiscount())->toBe('90.0000');

    // The same signed approval, a different sale.
    $second = pushDiscount($this->fx, '90', (int) $this->fx->cashier->getKey(), $claim);

    expect(storedDiscount())->toBe('30.0000')
        ->and(warningCodes($second))->toContain('approval_refused')
        ->and(AuditLog::query()->where('event', AuditEvent::EmployeeOverrideRefused)->value('changes'))
        ->toMatchArray(['reason' => ['old' => null, 'new' => 'approval_replayed']]);
});

it('lets an order re-send its own approval as often as it likes', function (): void {
    // The other side of that, and the one that must not break: the register pushes an order on
    // every edit and again at payment, carrying its approvals each time. Treating the second push
    // as a replay would cut the discount back on a sale the manager did authorise.
    $claim = approval('line.discount.above_limit', (int) $this->fx->manager->getKey());

    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    foreach (range(1, 3) as $ignored) {
        $command = $this->fx->orderCommand($orderUuid, [[
            'op' => 'create', 'uuid' => $lineUuid, 'variant_id' => $this->fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '90',
        ]]);
        $command['approvals'] = $claim;

        test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
            'employee_id' => $this->fx->cashier->getKey(),
            'orders' => [$command],
        ])->assertOk()->assertJsonPath('results.0.status', 'ok');
    }

    expect((string) OrderLine::query()->where('uuid', $lineUuid)->value('discount_percent'))->toBe('90.0000')
        // Still one override, not three.
        ->and(AuditLog::query()->where('event', AuditEvent::EmployeeOverride)->count())->toBe(1)
        ->and(AuditLog::query()->where('event', AuditEvent::EmployeeOverrideRefused)->count())->toBe(0);
});

// ── the over-variance close ──────────────────────────────────────────────────

it('closes over the authorised variance when a manager PIN checks out', function (): void {
    $fx = PosFixtures::make(['set_maximum_difference' => true, 'amount_authorized_diff' => '1.00'])
        ->withSession('100.00');

    test()->withHeaders($fx->headers())
        ->postJson("/api/pos/sessions/{$fx->session->getKey()}/close", [
            'counted_cash' => '50.00',
            'manager_employee_id' => $fx->manager->getKey(),
            'manager_pin' => '9999',
        ])
        ->assertOk();

    $session = PosSession::query()->whereKey($fx->session->getKey())->firstOrFail();

    expect($session->state)->toBe(SessionState::Closed)
        ->and((int) $session->over_variance_approved_by_employee_id)->toBe((int) $fx->manager->getKey());
});

it('refuses the same close on a wrong PIN and changes nothing', function (): void {
    $fx = PosFixtures::make(['set_maximum_difference' => true, 'amount_authorized_diff' => '1.00'])
        ->withSession('100.00');

    test()->withHeaders($fx->headers())
        ->postJson("/api/pos/sessions/{$fx->session->getKey()}/close", [
            'counted_cash' => '50.00',
            'manager_employee_id' => $fx->manager->getKey(),
            'manager_pin' => '0000',
        ])
        ->assertStatus(422);

    expect(PosSession::query()->whereKey($fx->session->getKey())->firstOrFail()->state)
        ->toBe(SessionState::Opened);
});

it('refuses it for an employee who cannot approve variances', function (): void {
    // A correct PIN is not the question — the cashier's own PIN is correct. `session.close
    // .over_variance` is a manager ability, and holding a PIN is not holding a permission.
    $fx = PosFixtures::make(['set_maximum_difference' => true, 'amount_authorized_diff' => '1.00'])
        ->withSession('100.00');

    test()->withHeaders($fx->headers())
        ->postJson("/api/pos/sessions/{$fx->session->getKey()}/close", [
            'counted_cash' => '50.00',
            'manager_employee_id' => $fx->cashier->getKey(),
            'manager_pin' => '1234',
        ])
        ->assertStatus(422);

    expect(PosSession::query()->whereKey($fx->session->getKey())->firstOrFail()->state)
        ->toBe(SessionState::Opened);
});
