<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\TaxGroupCrud;

use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use App\Models\Pricing\Tax;
use App\Models\Pricing\TaxGroup;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * A real permissioned user rather than a super-admin, which bypasses the policy entirely.
 *
 * @param  list<string>  $permissions
 */
function groupActor(PosFixtures $fx, array $permissions): User
{
    $role = Role::query()->create([
        'name' => 'Config manager',
        'slug' => 'config-manager-'.Str::random(6),
        'is_system' => false,
    ]);

    foreach ($permissions as $slug) {
        $permission = Permission::query()->firstOrCreate(['slug' => $slug], ['group' => 'config']);
        DB::table('permission_role')->insertOrIgnore([
            'role_id' => $role->getKey(),
            'permission_id' => $permission->getKey(),
        ]);
    }

    $user = User::factory()->create(['company_id' => $fx->company->getKey(), 'is_super_admin' => false]);
    DB::table('role_user')->insert(['role_id' => $role->getKey(), 'user_id' => $user->getKey()]);

    return $user;
}

beforeEach(function (): void {
    // A decoy venue first, so the acting company is not id 1.
    PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs(groupActor($this->fx, ['catalog.view', 'catalog.manage_taxes']));
});

/** @param array<string, mixed> $payload */
function addGroup(array $payload = []): TestResponse
{
    return test()->post(route('tax-groups.store'), ['name' => 'Eco levy', ...$payload]);
}

/**
 * BOF-091 (BAN-396) — tax groups.
 *
 * `taxes.tax_group_id` is a required `restrictOnDelete` foreign key, so before this a venue could
 * only create taxes under whatever groups the seeder happened to leave behind. The group is the
 * heading a tax totals under on a receipt and on a session's tax summary: two taxes in one group
 * print as a single line.
 */
it('adds a group', function (): void {
    addGroup()->assertRedirect();

    expect(TaxGroup::query()->where('name', 'Eco levy')->exists())->toBeTrue();
});

it('files it against the acting company', function (): void {
    addGroup()->assertRedirect();

    expect((int) TaxGroup::query()->where('name', 'Eco levy')->value('company_id'))
        ->toBe((int) $this->fx->company->getKey());
});

it('lets a group print under a different name than it is filed under', function (): void {
    // `receipt_label` is what the customer reads; `name` is what the manager searches. A group filed
    // as "Reduced rate — food" prints as "VAT 6%".
    addGroup(['name' => 'Reduced rate — food', 'receipt_label' => 'VAT 6%'])->assertRedirect();

    expect((string) TaxGroup::query()->where('name', 'Reduced rate — food')->value('receipt_label'))
        ->toBe('VAT 6%');
});

it('renames a group', function (): void {
    addGroup()->assertRedirect();
    $group = TaxGroup::query()->where('name', 'Eco levy')->firstOrFail();

    test()->patch(route('tax-groups.update', $group->getKey()), ['name' => 'Packaging levy'])
        ->assertSessionHasNoErrors()->assertRedirect();

    expect((string) TaxGroup::query()->whereKey($group->getKey())->value('name'))->toBe('Packaging levy');
});

it('makes a tax creatable, which is the whole reason this exists', function (): void {
    // The gap the ticket names: `tax_group_id` is required on create with an `exists` check, so a
    // venue that could not make a group could not make a tax either.
    addGroup()->assertRedirect();
    $group = TaxGroup::query()->where('name', 'Eco levy')->firstOrFail();

    test()->post(route('taxes.store'), [
        'name' => 'Bottle levy',
        'amount_type' => 'fixed',
        'amount' => '0.2000',
        'tax_group_id' => $group->getKey(),
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect((int) Tax::query()->where('name', 'Bottle levy')->value('tax_group_id'))
        ->toBe((int) $group->getKey());
});

it('removes an empty group', function (): void {
    addGroup()->assertRedirect();
    $group = TaxGroup::query()->where('name', 'Eco levy')->firstOrFail();

    test()->deleteJson(route('tax-groups.destroy', $group->getKey()))->assertRedirect();

    expect(TaxGroup::query()->whereKey($group->getKey())->exists())->toBeFalse();
});

it('refuses to remove a group that still holds taxes', function (): void {
    // `taxes.tax_group_id` is `restrictOnDelete`, so without the guard the database refuses too —
    // as a 500 naming nothing.
    $group = TaxGroup::query()->where('company_id', $this->fx->company->getKey())->firstOrFail();

    expect(Tax::query()->where('tax_group_id', $group->getKey())->exists())
        ->toBeTrue('the fixture group must actually hold a tax');

    $response = test()->deleteJson(route('tax-groups.destroy', $group->getKey()))->assertStatus(422);

    expect((string) json_encode($response->json()))->toContain('still holds')
        ->and(TaxGroup::query()->whereKey($group->getKey())->exists())->toBeTrue();
});

it('refuses to remove a group a closed session report quotes', function (): void {
    // A closed session's tax figures are frozen at close and the group is the heading they are read
    // under. There is no deactivate fallback — a group has no `active` column — so the refusal says
    // to empty it instead.
    addGroup()->assertRedirect();
    $group = TaxGroup::query()->where('name', 'Eco levy')->firstOrFail();

    $fx = $this->fx->withSession();
    $tax = Tax::query()->where('company_id', $fx->company->getKey())->firstOrFail();

    DB::table('session_tax_summaries')->insert([
        'pos_session_id' => $fx->session->getKey(),
        'tax_id' => $tax->getKey(),
        'tax_group_id' => $group->getKey(),
        'is_refund' => false,
        'base_amount' => '100.0000',
        'tax_amount' => '21.0000',
        'tax_rate' => '21.0000',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $response = test()->deleteJson(route('tax-groups.destroy', $group->getKey()))->assertStatus(422);

    expect((string) json_encode($response->json()))->toContain('closed session report')
        ->and(TaxGroup::query()->whereKey($group->getKey())->exists())->toBeTrue();
});

it('never touches another company group', function (): void {
    $other = PosFixtures::make();
    $foreign = TaxGroup::query()->withoutGlobalScopes()
        ->where('company_id', $other->company->getKey())->firstOrFail();

    test()->deleteJson(route('tax-groups.destroy', $foreign->getKey()))->assertNotFound();
    test()->patch(route('tax-groups.update', $foreign->getKey()), ['name' => 'Mine now'])->assertNotFound();

    expect((string) TaxGroup::query()->withoutGlobalScopes()->whereKey($foreign->getKey())->value('name'))
        ->not->toBe('Mine now');
});

it('refuses a user who may not configure the register', function (): void {
    addGroup()->assertRedirect();
    $group = TaxGroup::query()->where('name', 'Eco levy')->firstOrFail();

    test()->actingAs(groupActor($this->fx, ['catalog.view']));

    addGroup(['name' => 'Sneaky'])->assertForbidden();
    test()->patch(route('tax-groups.update', $group->getKey()), ['name' => 'Sneaky'])->assertForbidden();
    test()->deleteJson(route('tax-groups.destroy', $group->getKey()))->assertForbidden();

    expect(TaxGroup::query()->where('name', 'Sneaky')->exists())->toBeFalse()
        ->and(TaxGroup::query()->whereKey($group->getKey())->exists())->toBeTrue();
});
