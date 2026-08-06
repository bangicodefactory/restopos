<?php

declare(strict_types=1);

use App\Models\Audit\AuditLog;
use App\Models\User;
use App\Support\Audit\AuditEvent;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-413 — back-office config changes on the audit trail.
 *
 * A register's settings are where the money rules live: `amount_authorized_diff` is the variance a
 * manager may wave through without a second signature, and `has_cash_control` decides whether the
 * drawer is counted at all. "Who turned cash control off, and when" is an ordinary auditor question
 * that nothing in this system could answer.
 *
 * The pivots matter as much as the columns and were the easier half to leave out, because the diff
 * that covers the scalar settings cannot see them. "Who gave this employee access to that till" and
 * "who attached a payment method" have more reach than most of the checkboxes beside them.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make();
    $this->user = User::factory()->create(['company_id' => $this->fx->company->getKey()]);

    $this->actingAs($this->user);
});

function updateConfig(PosFixtures $fx, array $payload): TestResponse
{
    // Addressed by uuid, not by `route()` — these models bind by uuid but do not override
    // `getRouteKeyName()`, so the helper builds an id URL that 404s (the BAN-499 contract).
    return test()->patch("/pos-configs/{$fx->config->uuid}", $payload);
}

it('records a change to a money-relevant setting, with before and after', function (): void {
    updateConfig($this->fx, ['has_cash_control' => true, 'amount_authorized_diff' => '25.00'])
        ->assertRedirect();

    $log = AuditLog::query()->where('event', AuditEvent::ConfigChanged)->firstOrFail();

    expect((int) $log->actor_user_id)->toBe((int) $this->user->getKey())
        ->and((int) $log->pos_config_id)->toBe((int) $this->fx->config->getKey())
        ->and($log->severity->value)->toBe('notice')
        ->and((bool) $log->changes['has_cash_control']['old'])->toBeFalse()
        ->and((bool) $log->changes['has_cash_control']['new'])->toBeTrue();
});

it('writes nothing when the form is saved with nothing changed', function (): void {
    // A settings page is opened and saved far more often than it is edited. A row per save turns
    // the config trail into a log of who looked at the page.
    updateConfig($this->fx, [
        'name' => $this->fx->config->name,
        'has_cash_control' => (bool) $this->fx->config->has_cash_control,
    ])->assertRedirect();

    expect(AuditLog::query()->where('event', AuditEvent::ConfigChanged)->count())->toBe(0);
});

it('records which payment methods were attached and which were taken away', function (): void {
    // The half that the scalar diff cannot see. Adding a payment method to a register changes what
    // that till can take money as; it is not a lesser change than renaming it.
    updateConfig($this->fx, ['payment_method_ids' => [$this->fx->cash->getKey()]])->assertRedirect();

    AuditLog::query()->delete();

    updateConfig($this->fx, [
        'payment_method_ids' => [$this->fx->cash->getKey(), $this->fx->card->getKey()],
    ])->assertRedirect();

    $log = AuditLog::query()->where('event', AuditEvent::ConfigChanged)->firstOrFail();
    $change = $log->changes['payment_method_ids'];

    expect($change['added'])->toBe([(int) $this->fx->card->getKey()])
        ->and($change['removed'])->toBe([])
        ->and($change['old'])->toBe([(int) $this->fx->cash->getKey()]);
});

it('records a payment method being removed', function (): void {
    updateConfig($this->fx, [
        'payment_method_ids' => [$this->fx->cash->getKey(), $this->fx->card->getKey()],
    ])->assertRedirect();

    AuditLog::query()->delete();

    updateConfig($this->fx, ['payment_method_ids' => [$this->fx->cash->getKey()]])->assertRedirect();

    $change = AuditLog::query()->where('event', AuditEvent::ConfigChanged)->firstOrFail()
        ->changes['payment_method_ids'];

    expect($change['removed'])->toBe([(int) $this->fx->card->getKey()])
        ->and($change['added'])->toBe([]);
});

it('does not call a reordered list a change', function (): void {
    // The form posts whatever order the UI held them in. Worth stating what this does *not* prove:
    // both sides are read back from the database, and SQLite returns pivot rows in a stable order,
    // so this would pass even against an equality check. It cannot be made to fail here. That is
    // precisely why the decision upstream is a set difference rather than a list comparison — no
    // database promises an order without an `ORDER BY`, and `sync()` deletes and re-inserts the
    // rows it keeps. This case pins the behaviour; the design is what guarantees it.
    updateConfig($this->fx, [
        'payment_method_ids' => [$this->fx->cash->getKey(), $this->fx->card->getKey()],
    ])->assertRedirect();

    AuditLog::query()->delete();

    updateConfig($this->fx, [
        'payment_method_ids' => [$this->fx->card->getKey(), $this->fx->cash->getKey()],
    ])->assertRedirect();

    expect(AuditLog::query()->where('event', AuditEvent::ConfigChanged)->count())->toBe(0);
});

it('records the caller address', function (): void {
    // `ip_address` is a column the spec asks for and the reason the request is resolved per call
    // rather than injected once.
    updateConfig($this->fx, ['name' => 'Comptoir'])->assertRedirect();

    expect(AuditLog::query()->where('event', AuditEvent::ConfigChanged)->value('ip_address'))
        ->not->toBeNull();
});
