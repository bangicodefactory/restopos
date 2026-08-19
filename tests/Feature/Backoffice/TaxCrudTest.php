<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\TaxCrud;

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
function taxActor(PosFixtures $fx, array $permissions): User
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
    $this->group = TaxGroup::query()->where('company_id', $this->fx->company->getKey())->firstOrFail();
    $this->actingAs(taxActor($this->fx, ['config.view', 'config.manage']));
});

/** @param array<string, mixed> $payload */
function addTax(int $groupId, array $payload = []): TestResponse
{
    return test()->post(route('taxes.store'), [
        'name' => 'Reduced 10%',
        'amount_type' => 'percent',
        'amount' => '10.0000',
        'tax_group_id' => $groupId,
        ...$payload,
    ]);
}

/**
 * BOF-091 (BAN-396) — creating and removing a tax, and the fields that decide what one computes.
 *
 * The editor could change a tax's name, its rate and its two compounding switches. It could **not**
 * change `amount_type`, `tax_group_id`, `has_negative_factor` or `rounding_strategy` — between them,
 * whether the tax is a percentage or a fixed sum, which heading it totals under on a receipt,
 * whether it subtracts rather than adds, and how it rounds. The only fields a seeded tax could not
 * change were the ones that decide what it does.
 */
it('adds a tax', function (): void {
    addTax((int) $this->group->getKey())->assertRedirect();

    expect(Tax::query()->where('name', 'Reduced 10%')->exists())->toBeTrue();
});

it('files it against the acting company', function (): void {
    addTax((int) $this->group->getKey())->assertRedirect();

    expect((int) Tax::query()->where('name', 'Reduced 10%')->value('company_id'))
        ->toBe((int) $this->fx->company->getKey());
});

it('sets whether the tax is a rate or a fixed sum', function (): void {
    // The engine computes a different thing for each. This was unreachable before.
    addTax((int) $this->group->getKey(), ['name' => 'Eco levy', 'amount_type' => 'fixed', 'amount' => '0.2000'])
        ->assertRedirect();

    expect(Tax::query()->where('name', 'Eco levy')->value('amount_type')->value)->toBe('fixed');
});

it('changes an existing tax from a rate to a fixed sum', function (): void {
    addTax((int) $this->group->getKey())->assertRedirect();
    $tax = Tax::query()->where('name', 'Reduced 10%')->firstOrFail();

    test()->patch(route('taxes.update', $tax->getKey()), ['amount_type' => 'fixed'])->assertRedirect();

    expect(Tax::query()->whereKey($tax->getKey())->value('amount_type')->value)->toBe('fixed');
});

it('refuses a kind the engine cannot compute', function (): void {
    addTax((int) $this->group->getKey(), ['amount_type' => 'vibes'])->assertSessionHasErrors('amount_type');
});

it('sets the rounding strategy, which decides where the pennies land', function (): void {
    addTax((int) $this->group->getKey(), ['rounding_strategy' => 'round_globally'])->assertRedirect();

    expect(Tax::query()->where('name', 'Reduced 10%')->value('rounding_strategy')->value)
        ->toBe('round_globally');
});

it('sets a tax that subtracts rather than adds', function (): void {
    addTax((int) $this->group->getKey(), ['has_negative_factor' => true])->assertRedirect();

    expect((bool) Tax::query()->where('name', 'Reduced 10%')->value('has_negative_factor'))->toBeTrue();
});

it('refuses another company tax group, which is what a receipt totals under', function (): void {
    $other = PosFixtures::make();
    $theirs = TaxGroup::query()->withoutGlobalScopes()
        ->where('company_id', $other->company->getKey())->firstOrFail();

    addTax((int) $theirs->getKey())->assertSessionHasErrors('tax_group_id');

    expect(Tax::query()->where('name', 'Reduced 10%')->exists())->toBeFalse();
});

it('removes a tax nothing points at', function (): void {
    addTax((int) $this->group->getKey())->assertRedirect();
    $tax = Tax::query()->where('name', 'Reduced 10%')->firstOrFail();

    test()->deleteJson(route('taxes.destroy', $tax->getKey()))->assertRedirect();

    expect(Tax::query()->whereKey($tax->getKey())->exists())->toBeFalse();
});

it('refuses to remove a tax still applied to a product', function (): void {
    // `product_tax.tax_id` is `restrictOnDelete`, so without the guard the database refuses too —
    // as a SQLSTATE 23000 reaching the manager as a 500 with no clue which product is in the way.
    addTax((int) $this->group->getKey())->assertRedirect();
    $tax = Tax::query()->where('name', 'Reduced 10%')->firstOrFail();

    DB::table('product_tax')->insert([
        'product_id' => $this->fx->product->getKey(),
        'tax_id' => $tax->getKey(),
    ]);

    test()->deleteJson(route('taxes.destroy', $tax->getKey()))->assertStatus(422);

    expect(Tax::query()->whereKey($tax->getKey())->exists())->toBeTrue();
});

it('refuses to remove a tax still applied to a variant', function (): void {
    // A separate pivot from the product one, and separately restricting.
    addTax((int) $this->group->getKey())->assertRedirect();
    $tax = Tax::query()->where('name', 'Reduced 10%')->firstOrFail();

    DB::table('product_variant_tax')->insert([
        'product_variant_id' => $this->fx->variant->getKey(),
        'tax_id' => $tax->getKey(),
    ]);

    test()->deleteJson(route('taxes.destroy', $tax->getKey()))->assertStatus(422);

    expect(Tax::query()->whereKey($tax->getKey())->exists())->toBeTrue();
});

it('never removes a tax that appears on a closed session report', function (): void {
    // The one that cannot be resolved by unlinking anything: a Z-report's frozen tax figures. Delete
    // the tax and the report loses the row explaining its own total.
    $fx = $this->fx->withSession();
    addTax((int) $this->group->getKey())->assertRedirect();
    $tax = Tax::query()->where('name', 'Reduced 10%')->firstOrFail();

    DB::table('session_tax_summaries')->insert([
        'pos_session_id' => $fx->session->getKey(),
        'tax_id' => $tax->getKey(),
        'tax_group_id' => $this->group->getKey(),
        'is_refund' => false,
        'base_amount' => '100.0000',
        'tax_amount' => '10.0000',
        'tax_rate' => '10.0000',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $response = test()->deleteJson(route('taxes.destroy', $tax->getKey()))->assertStatus(422);

    // And it says what to do instead, because there is no way to make this delete succeed.
    expect((string) json_encode($response->json()))->toContain('Deactivate');
    expect(Tax::query()->whereKey($tax->getKey())->exists())->toBeTrue();
});

it('lets a tax be deactivated instead, which is what removing one usually means', function (): void {
    addTax((int) $this->group->getKey())->assertRedirect();
    $tax = Tax::query()->where('name', 'Reduced 10%')->firstOrFail();

    test()->patch(route('taxes.update', $tax->getKey()), ['active' => false])->assertRedirect();

    expect((bool) Tax::query()->whereKey($tax->getKey())->value('active'))->toBeFalse();
});

it('never touches another company tax', function (): void {
    $other = PosFixtures::make();

    test()->deleteJson(route('taxes.destroy', $other->tax->getKey()))->assertNotFound();

    expect(Tax::query()->withoutGlobalScopes()->whereKey($other->tax->getKey())->exists())->toBeTrue();
});

it('refuses a user who may not configure the register', function (): void {
    addTax((int) $this->group->getKey())->assertRedirect();
    $tax = Tax::query()->where('name', 'Reduced 10%')->firstOrFail();

    test()->actingAs(taxActor($this->fx, ['config.view']));

    addTax((int) $this->group->getKey(), ['name' => 'Sneaky'])->assertForbidden();
    test()->deleteJson(route('taxes.destroy', $tax->getKey()))->assertForbidden();

    expect(Tax::query()->where('name', 'Sneaky')->exists())->toBeFalse()
        ->and(Tax::query()->whereKey($tax->getKey())->exists())->toBeTrue();
});
