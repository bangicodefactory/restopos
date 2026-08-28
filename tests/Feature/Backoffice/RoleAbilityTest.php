<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\RoleAbility;

use App\Models\Identity\Employee;
use App\Models\Identity\TillRole;
use App\Services\Identity\EmployeeAuthService;
use App\Support\Auth\EmployeeAbilities;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * Till roles and the ability matrix — axis 2 (BOF-118, XCT-105, BAN-451).
 *
 * The matrix was rendered from `config/pos.php` and never written, so granting a cashier the right
 * to void was a code deploy, and "the closing manager on till 3 may void" was not expressible.
 */
beforeEach(function (): void {
    $this->other = PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_employees'));
});

function role(string $slug): TillRole
{
    return TillRole::query()->where('slug', $slug)->firstOrFail();
}

function abilitiesOf(Employee $employee): array
{
    return app(EmployeeAuthService::class)->abilitiesFor(
        app(EmployeeAuthService::class)->roleSlugFor($employee, test()->fx->config),
        test()->fx->config,
    );
}

it('starts every venue on the abilities the product ships with', function (): void {
    // The migration must be invisible: a venue that upgrades has exactly what it had.
    expect(role('cashier')->grantedAbilities())
        ->toBe(EmployeeAbilities::only((array) config('pos.role_abilities.cashier')));
});

// ─────────────────────────────────────────────────────────── authoring a role

it('creates a role', function (): void {
    test()->post('/till-roles', [
        'slug' => 'shift_lead',
        'name' => 'Chef de brigade',
        'abilities' => ['order.create', 'order.void_paid'],
    ])->assertSessionHasNoErrors();

    expect(role('shift_lead')->grantedAbilities())->toBe(['order.create', 'order.void_paid']);
});

it('never mints a system role through the form', function (): void {
    // `is_system` decides whether a role can be removed at all.
    test()->post('/till-roles', ['slug' => 'shift_lead', 'name' => 'Chef', 'is_system' => true])
        ->assertSessionHasNoErrors();

    expect(role('shift_lead')->is_system)->toBeFalsy();
});

it('refuses an ability the system does not check', function (): void {
    // A typo saves cleanly, reads as granted in the matrix, and is checked by nothing — while
    // `ApprovalAuthority` would have treated it as a real permission and spent a manager's PIN.
    test()->post('/till-roles', [
        'slug' => 'shift_lead',
        'name' => 'Chef',
        'abilities' => ['order.void_paied'],
    ])->assertSessionHasErrors('abilities.0');

    expect(TillRole::query()->where('slug', 'shift_lead')->exists())->toBeFalse();
});

it('refuses a slug another role at this venue already uses', function (): void {
    test()->post('/till-roles', ['slug' => 'cashier', 'name' => 'Autre caissier'])
        ->assertSessionHasErrors('slug');
});

it('still allows a slug another venue happens to use', function (): void {
    // `Rule::unique` runs on the query builder, where `CompanyScope` cannot reach — it would refuse
    // a slug that is free here.
    TillRole::query()->create([
        'company_id' => $this->other->company->getKey(),
        'slug' => 'shift_lead',
        'name' => 'Leur chef',
        'abilities' => [],
    ]);

    test()->post('/till-roles', ['slug' => 'shift_lead', 'name' => 'Notre chef'])
        ->assertSessionHasNoErrors();
});

it('lets a system role be renamed but not re-slugged', function (): void {
    // `employees.default_role` and `AccessLevel::toRole()` both name these by slug and neither is a
    // foreign key. Renaming `manager` to `boss` would leave every manager pointing at nothing, and
    // `abilitiesFor()` would fall through to the shipping defaults — quietly restoring abilities the
    // venue had revoked.
    test()->patch('/till-roles/'.role('manager')->getKey(), ['name' => 'Responsable de salle'])
        ->assertSessionHasNoErrors();

    test()->patch('/till-roles/'.role('manager')->getKey(), ['slug' => 'boss'])
        ->assertSessionHasErrors('slug');

    expect(role('manager')->name)->toBe('Responsable de salle');
});

// ───────────────────────────────────────────────────────────────── escalation

it('refuses to grant an ability that reaches into the back office', function (): void {
    // `config.manage` lets a till rewrite the register's own configuration. Someone who cannot edit
    // a register in the back office must not be able to grant that at the counter and then use it.
    test()->post('/till-roles', [
        'slug' => 'shift_lead',
        'name' => 'Chef',
        'abilities' => ['order.create', 'config.manage'],
    ])->assertSessionHasErrors('abilities');

    expect(TillRole::query()->where('slug', 'shift_lead')->exists())->toBeFalse();
});

it('allows it to someone who holds the matching permission', function (): void {
    // The negative half: the guard is about the permission, not about the ability being sacred.
    $this->actingAs($this->fx->userWith(
        'backoffice.access',
        'backoffice.manage_employees',
        'backoffice.manage_configs',
    ));

    test()->post('/till-roles', [
        'slug' => 'shift_lead',
        'name' => 'Chef',
        'abilities' => ['config.manage'],
    ])->assertSessionHasNoErrors();
});

it('still lets a role that already holds it be edited by someone who could not grant it', function (): void {
    // Checked against what is being *added*. Otherwise the manager role, which ships with
    // `config.manage`, could not be renamed or re-granted at all by an ordinary staff manager.
    $manager = role('manager');

    test()->patch('/till-roles/'.$manager->getKey(), [
        'abilities' => [...$manager->grantedAbilities(), 'order.create'],
    ])->assertSessionHasNoErrors();

    expect(role('manager')->grantedAbilities())->toContain('config.manage');
});

it('refuses role authoring to someone who may only look', function (): void {
    $this->actingAs($this->fx->userWith('backoffice.access'));

    test()->post('/till-roles', ['slug' => 'shift_lead', 'name' => 'Chef'])->assertForbidden();
});

// ────────────────────────────────────────────── what the till actually reads

it('grants a custom role its abilities at the till', function (): void {
    // The acceptance criterion. Nothing between this screen and the register is asserted anywhere
    // else, and `EmployeeAuthService` is what the ingest guard and the bootstrap payload both use.
    test()->post('/till-roles', [
        'slug' => 'shift_lead',
        'name' => 'Chef de brigade',
        'abilities' => ['order.create', 'order.void_paid'],
    ])->assertSessionHasNoErrors();

    $employee = $this->fx->cashier;
    $employee->forceFill(['default_role' => 'shift_lead'])->save();

    expect(abilitiesOf($employee->fresh()))->toContain('order.void_paid');
});

it('does not grant it to a cashier who does not hold it', function (): void {
    expect(abilitiesOf($this->fx->cashier))->not->toContain('order.void_paid');
});

it('reads the venue role rather than the shipping default', function (): void {
    // The table is the source now. Revoking here has to actually revoke: falling back to the config
    // would hand the ability straight back.
    $cashier = role('cashier');

    test()->patch('/till-roles/'.$cashier->getKey(), [
        'abilities' => array_values(array_diff($cashier->grantedAbilities(), ['line.discount'])),
    ])->assertSessionHasNoErrors();

    expect(abilitiesOf($this->fx->cashier))->not->toContain('line.discount')
        ->and((array) config('pos.role_abilities.cashier'))->toContain('line.discount');
});

it('treats a role with nothing granted as nothing granted', function (): void {
    // The null-versus-empty trap. An empty list means "this role gets nothing"; falling through to
    // the defaults there would give every ability back the moment the last one was revoked.
    $cashier = role('cashier');

    test()->patch('/till-roles/'.$cashier->getKey(), ['abilities' => []])
        ->assertSessionHasNoErrors();

    expect(abilitiesOf($this->fx->cashier))->toBe([]);
});

it('lets a register override a role for itself alone', function (): void {
    // XCT-105, from the other side: the per-register override wins over the venue's own role.
    $this->fx->config->forceFill([
        'role_abilities' => ['cashier' => ['order.create', 'order.void_paid']],
    ])->save();

    expect(abilitiesOf($this->fx->cashier))->toContain('order.void_paid');
});

it('gives an employee a different role on one register only', function (): void {
    // "The closing manager on till 3 may void, nobody else may" — the sentence the ticket opens
    // with, and the reason the pivot needed a column of its own: `access_level` has three values and
    // is always set once an employee is attached, so it could neither name a custom role nor fall
    // through to one.
    test()->post('/till-roles', [
        'slug' => 'shift_lead',
        'name' => 'Chef de brigade',
        'abilities' => ['order.create', 'order.void_paid'],
    ])->assertSessionHasNoErrors();

    $employee = $this->fx->cashier;

    DB::table('pos_config_employee')->insert([
        'pos_config_id' => $this->fx->config->getKey(),
        'employee_id' => $employee->getKey(),
        'access_level' => 'basic',
        'role_slug' => 'shift_lead',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    expect(abilitiesOf($employee->fresh()))->toContain('order.void_paid');
});

it('leaves an employee on their own role where no register overrides it', function (): void {
    $employee = $this->fx->cashier;

    DB::table('pos_config_employee')->insert([
        'pos_config_id' => $this->fx->config->getKey(),
        'employee_id' => $employee->getKey(),
        'access_level' => 'basic',
        'role_slug' => null,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    expect(abilitiesOf($employee->fresh()))->not->toContain('order.void_paid');
});

it('never ships an ability the code stopped checking', function (): void {
    // A row outlives the code that gave it meaning. Shipping a stale ability would put a permission
    // in the payload that nothing checks — visible to the client's own gate, which would then allow
    // at the counter what the server refuses on sync.
    DB::table('till_roles')->where('slug', 'cashier')
        ->update(['abilities' => json_encode(['order.create', 'order.teleport'])]);

    expect(abilitiesOf($this->fx->cashier))->toBe(['order.create']);
});

// ─────────────────────────────────────────────────────────────────── deleting

it('refuses to remove a role the product ships with', function (): void {
    test()->delete('/till-roles/'.role('cashier')->getKey())->assertSessionHasErrors('role');

    expect(TillRole::query()->where('slug', 'cashier')->exists())->toBeTrue();
});

it('refuses to remove a role staff still hold', function (): void {
    test()->post('/till-roles', ['slug' => 'shift_lead', 'name' => 'Chef'])
        ->assertSessionHasNoErrors();

    $this->fx->cashier->forceFill(['default_role' => 'shift_lead'])->save();

    test()->delete('/till-roles/'.role('shift_lead')->getKey())->assertSessionHasErrors('role');
});

it('refuses to remove a role a register assigns', function (): void {
    test()->post('/till-roles', ['slug' => 'shift_lead', 'name' => 'Chef'])
        ->assertSessionHasNoErrors();

    DB::table('pos_config_employee')->insert([
        'pos_config_id' => $this->fx->config->getKey(),
        'employee_id' => $this->fx->cashier->getKey(),
        'access_level' => 'basic',
        'role_slug' => 'shift_lead',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    test()->delete('/till-roles/'.role('shift_lead')->getKey())->assertSessionHasErrors('role');
});

it('removes a role nobody holds', function (): void {
    test()->post('/till-roles', ['slug' => 'shift_lead', 'name' => 'Chef'])
        ->assertSessionHasNoErrors();

    test()->delete('/till-roles/'.role('shift_lead')->getKey())->assertSessionHasNoErrors();

    expect(TillRole::query()->where('slug', 'shift_lead')->exists())->toBeFalse();
});

// ─────────────────────────────────────────────────── the screen and the wire

it('ships the matrix the venue roles rather than the enum cases', function (): void {
    test()->withoutVite();

    test()->post('/till-roles', ['slug' => 'shift_lead', 'name' => 'Chef de brigade'])
        ->assertSessionHasNoErrors();

    test()->get('/employees')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->where('roles', fn ($rows) => collect($rows)->pluck('value')->contains('shift_lead'))
            ->has('abilityGroups')
            ->has('grantable')
            ->etc());
});

it('does not offer an ability this user could not grant', function (): void {
    test()->withoutVite();

    test()->get('/employees')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->where('grantable', fn ($rows) => collect($rows)->contains('order.create')
                && ! collect($rows)->contains('config.manage'))
            ->etc());
});

it('sends a custom role to the till under its own name', function (): void {
    // The bootstrap ships a *resolved* ability list, so the client never re-derives one — which is
    // why the offline gate needed no change. But the role string travels too, and flattening a
    // custom role onto the nearest enum case would make it read as a cashier everywhere it is shown.
    test()->post('/till-roles', [
        'slug' => 'shift_lead',
        'name' => 'Chef de brigade',
        'abilities' => ['order.create', 'order.void_paid'],
    ])->assertSessionHasNoErrors();

    $employee = $this->fx->cashier;
    $employee->forceFill(['default_role' => 'shift_lead'])->save();

    $payload = test()->withHeaders($this->fx->headers())
        ->getJson('/api/pos/bootstrap')->assertOk()->json();

    $mine = collect($payload['data']['employees'] ?? [])
        ->firstWhere('id', $employee->getKey());

    expect($mine['role'] ?? null)->toBe('shift_lead')
        ->and($mine['abilities'] ?? [])->toContain('order.void_paid');
});

it('refuses to remove a built-in role even when nobody holds it', function (): void {
    // `minimal` is seeded and unheld, which is what makes this the honest test of the `is_system`
    // guard: deleting `cashier` is refused by the "staff still hold it" check first, so that one
    // never reached this branch at all.
    expect(Employee::query()->where('default_role', 'minimal')->count())->toBe(0);

    test()->delete('/till-roles/'.role('minimal')->getKey())->assertSessionHasErrors('role');

    expect(TillRole::query()->where('slug', 'minimal')->exists())->toBeTrue();
});

it('stores each granted ability once', function (): void {
    // A payload can repeat one — the matrix sends the whole list back on every toggle — and the
    // rule validates each entry rather than the set. A duplicate would ship to the till twice.
    $cashier = role('cashier');

    test()->patch('/till-roles/'.$cashier->getKey(), [
        'abilities' => ['order.create', 'order.create', 'line.discount'],
    ])->assertSessionHasNoErrors();

    // The *stored column*, not `grantedAbilities()`. That accessor filters on read and would hide a
    // duplicate either way; the column is the record, and it is what a future reader, an export or
    // anyone opening the row directly actually sees.
    expect(json_decode(
        (string) DB::table('till_roles')->where('id', $cashier->getKey())->value('abilities'),
        true,
    ))->toBe(['order.create', 'line.discount']);
});

it('refuses a role name the venue does not have on a staff record', function (): void {
    // `employees.default_role` is a slug and not a foreign key, so nothing below this refuses it —
    // and an unknown slug falls through to the shipping defaults, handing the employee abilities the
    // venue may have revoked.
    test()->patch('/employees/'.$this->fx->cashier->getKey(), ['default_role' => 'invented'])
        ->assertSessionHasErrors('default_role');

    expect((string) Employee::query()->whereKey($this->fx->cashier->getKey())->value('default_role'))
        ->toBe('cashier');
});

it('refuses another venue role on a staff record', function (): void {
    // The cross-tenant half. `Rule::exists` would have accepted this: it runs on the query builder,
    // where `CompanyScope` cannot reach, so our employee would be given whatever *their* venue had
    // granted that slug.
    TillRole::query()->create([
        'company_id' => $this->other->company->getKey(),
        'slug' => 'leur_role',
        'name' => 'Leur rôle',
        'abilities' => ['order.void_paid'],
    ]);

    test()->patch('/employees/'.$this->fx->cashier->getKey(), ['default_role' => 'leur_role'])
        ->assertSessionHasErrors('default_role');
});
