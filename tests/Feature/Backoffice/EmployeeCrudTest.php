<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\EmployeeCrud;

use App\Enums\EmployeeRole;
use App\Models\Identity\Employee;
use App\Models\Pos\PosConfig;
use App\Services\Identity\EmployeeAuthService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * Hiring, removing, and the two things a member of staff carries (BOF-120…BOF-122, BAN-446).
 *
 * The staff list was whatever the seeder produced: an operator could edit a person and could not
 * add or remove one, so onboarding a starter meant a database write.
 */
beforeEach(function (): void {
    // A decoy venue first, so the acting company is not id 1.
    $this->other = PosFixtures::make();

    $this->fx = PosFixtures::make();
    // Both, because the per-register half of this ticket saves through the register settings screen.
    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_employees', 'backoffice.manage_configs'));
});

/** @param array<string, mixed> $payload */
function hire(array $payload = []): TestResponse
{
    return test()->post('/employees', [
        'name' => 'Amélie',
        'default_role' => 'cashier',
        ...$payload,
    ]);
}

it('hires someone', function (): void {
    hire(['name' => 'Nouvelle recrue'])->assertSessionHasNoErrors()->assertRedirect();

    expect(Employee::query()->where('name', 'Nouvelle recrue')->exists())->toBeTrue();
});

it('puts a new hire in the acting company, not the decoy', function (): void {
    hire(['name' => 'Ours'])->assertRedirect();

    expect((int) Employee::query()->where('name', 'Ours')->value('company_id'))
        ->toBe((int) $this->fx->company->getKey());
});

it('never stores a PIN in the clear', function (): void {
    hire(['name' => 'Avec code', 'pin' => '4817'])->assertSessionHasNoErrors()->assertRedirect();

    $row = DB::table('employees')->where('name', 'Avec code')->first();

    expect($row->pin_hash)->toBe(hash('sha256', '4817'))
        ->and(json_encode($row))->not->toContain('4817');
});

it('refuses a PIN that is one digit repeated', function (): void {
    // `min:4|max:12` accepted this, on the credential that authorises a void and an over-variance
    // session close.
    hire(['name' => 'Zéros', 'pin' => '0000'])->assertSessionHasErrors('pin');

    expect(Employee::query()->where('name', 'Zéros')->exists())->toBeFalse();
});

it('refuses a straight run of digits, in either direction', function (): void {
    hire(['name' => 'Montant', 'pin' => '1234'])->assertSessionHasErrors('pin');
    hire(['name' => 'Descendant', 'pin' => '4321'])->assertSessionHasErrors('pin');
});

it('refuses anything that is not digits, because the keypad has nothing else on it', function (): void {
    hire(['name' => 'Lettres', 'pin' => 'abcd'])->assertSessionHasErrors('pin');
});

it('accepts an ordinary PIN', function (): void {
    // The negative half. A rule that refuses everything is not a rule.
    hire(['name' => 'Correct', 'pin' => '4817'])->assertSessionHasNoErrors()->assertRedirect();

    expect(Employee::query()->where('name', 'Correct')->exists())->toBeTrue();
});

it('refuses a PIN another member of staff already uses', function (): void {
    // Not an identity problem — `verifyPin` takes the employee id first, so two people with one PIN
    // are never confused for each other. It is an accountability problem: each can sign as the
    // other, and "who voided this" is the question the trail exists to answer.
    hire(['name' => 'Premier', 'pin' => '4817'])->assertRedirect();
    hire(['name' => 'Second', 'pin' => '4817'])->assertSessionHasErrors('pin');

    expect(Employee::query()->where('name', 'Second')->exists())->toBeFalse();
});

it('does not count another company staff as a clash', function (): void {
    // The uniqueness is per venue. Two unrelated restaurants may both have a 4817.
    DB::table('employees')->where('id', $this->other->cashier->getKey())
        ->update(['pin_hash' => hash('sha256', '4817')]);

    hire(['name' => 'Nôtre', 'pin' => '4817'])->assertSessionHasNoErrors()->assertRedirect();
});

it('lets someone keep their own PIN while editing something else', function (): void {
    // The uniqueness check must ignore the record being edited, or nobody could ever rename
    // themselves without also choosing a new PIN.
    $id = $this->fx->cashier->getKey();

    test()->patch("/employees/{$id}", ['pin' => '4817'])->assertSessionHasNoErrors();
    test()->patch("/employees/{$id}", ['name' => 'Renommé', 'pin' => '4817'])
        ->assertSessionHasNoErrors();

    expect((string) Employee::query()->whereKey($id)->value('name'))->toBe('Renommé');
});

it('removes someone who has rung nothing up', function (): void {
    hire(['name' => 'Parti'])->assertRedirect();

    $id = (int) Employee::query()->where('name', 'Parti')->value('id');

    test()->delete("/employees/{$id}")->assertSessionHasNoErrors()->assertRedirect();

    expect(Employee::query()->whereKey($id)->exists())->toBeFalse();
});

it('refuses to remove someone who has taken orders', function (): void {
    // The trail answering "who sold this" lives on pos_orders.employee_id. Deleting the row either
    // fails at the database or orphans the answer, so deactivating is the right move.
    $fx = $this->fx->withSession();

    DB::table('pos_orders')->insert([
        'uuid' => (string) Str::uuid(),
        'company_id' => $fx->company->getKey(),
        'pos_config_id' => $fx->config->getKey(),
        'pos_session_id' => $fx->session->getKey(),
        'currency_id' => $fx->currency->getKey(),
        'employee_id' => $fx->cashier->getKey(),
        'tracking_number' => 'T-1',
        'access_token' => Str::random(32),
        'state' => 'draft',
        'ordered_at' => now(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $id = $fx->cashier->getKey();

    test()->delete("/employees/{$id}")->assertSessionHasErrors('employee');

    expect(Employee::query()->whereKey($id)->exists())->toBeTrue();
});

it('sets the level an employee holds on one register and not another', function (): void {
    // BOF-122. `pos_config_employee.access_level` has existed since the table was written, with a
    // CHECK constraint and a default of `basic`, and the sync wrote bare ids — so every employee on
    // every register sat at the default and "advanced on till 2 only" could not be expressed.
    $cashier = $this->fx->cashier->getKey();

    test()->patch("/pos-configs/{$this->fx->config->uuid}", [
        'employee_ids' => [$cashier],
        'employee_access_levels' => [(string) $cashier => 'advanced'],
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect((string) DB::table('pos_config_employee')
        ->where('pos_config_id', $this->fx->config->getKey())
        ->where('employee_id', $cashier)
        ->value('access_level'))->toBe('advanced');
});

it('refuses a level that is not one of the defined ones', function (): void {
    // The column carries a CHECK constraint; without a rule this is a 500 rather than a 422.
    $cashier = $this->fx->cashier->getKey();

    test()->patch("/pos-configs/{$this->fx->config->uuid}", [
        'employee_ids' => [$cashier],
        'employee_access_levels' => [(string) $cashier => 'emperor'],
    ])->assertSessionHasErrors('employee_access_levels.'.$cashier);
});

it('never applies a level keyed to another company employee', function (): void {
    // `ownedIds` refuses the foreign id, and the level map must not re-introduce it through the
    // pivot payload.
    $theirs = $this->other->cashier->getKey();

    test()->patch("/pos-configs/{$this->fx->config->uuid}", [
        'employee_ids' => [$theirs],
        'employee_access_levels' => [(string) $theirs => 'advanced'],
    ])->assertSessionHasErrors();

    expect(DB::table('pos_config_employee')
        ->where('pos_config_id', $this->fx->config->getKey())
        ->where('employee_id', $theirs)
        ->exists())->toBeFalse();
});

it('overrides the abilities a role holds on one register', function (): void {
    // BOF-124. EmployeeAuthService has read `role_abilities` off the config since it was written and
    // the column was never created, so getAttribute answered null on every register and the override
    // has never once applied.
    test()->patch("/pos-configs/{$this->fx->config->uuid}", [
        'role_abilities' => ['cashier' => ['order.create', 'receipt.print']],
    ])->assertSessionHasNoErrors()->assertRedirect();

    $stored = PosConfig::query()->whereKey($this->fx->config->getKey())->value('role_abilities');

    expect($stored)->toBe(['cashier' => ['order.create', 'receipt.print']]);
});

it('treats an empty override as deliberate rather than as absent', function (): void {
    // `{}` grants the role nothing, which is not the same as null meaning "use the defaults". If
    // these collapsed together, revoking every ability from a role would silently restore them all.
    test()->patch("/pos-configs/{$this->fx->config->uuid}", [
        'role_abilities' => ['cashier' => []],
    ])->assertSessionHasNoErrors()->assertRedirect();

    $stored = PosConfig::query()->whereKey($this->fx->config->getKey())->value('role_abilities');

    expect($stored)->toBe(['cashier' => []])->not->toBeNull();
});

it('reaches the till, which is the only place an ability means anything', function (): void {
    $service = app(EmployeeAuthService::class);

    $before = $service->abilitiesFor(EmployeeRole::Cashier, $this->fx->config);

    test()->patch("/pos-configs/{$this->fx->config->uuid}", [
        'role_abilities' => ['cashier' => ['order.create']],
    ])->assertRedirect();

    $after = $service->abilitiesFor(EmployeeRole::Cashier, $this->fx->config->fresh());

    expect($before)->not->toBe(['order.create'])
        ->and($after)->toBe(['order.create']);
});
