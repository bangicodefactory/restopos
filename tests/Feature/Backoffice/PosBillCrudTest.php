<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\PosBillCrud;

use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use App\Models\Pos\PosBill;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * A real permissioned user rather than a super-admin: one bypasses the policy entirely, and has no
 * company of its own — the case `store` refuses.
 *
 * @param  list<string>  $permissions
 */
function billActor(PosFixtures $fx, array $permissions): User
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
    // A decoy venue first, so the acting company is not id 1 — otherwise a hardcoded company would
    // be indistinguishable from reading the acting user.
    PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs(billActor($this->fx, ['backoffice.access', 'backoffice.manage_configs']));
});

/** @param array<string, mixed> $payload */
function addBill(PosFixtures $fx, array $payload = []): TestResponse
{
    return test()->post(route('pos-bills.store'), [
        'name' => '20',
        'value' => '20.00',
        'denomination_type' => 'bill',
        'currency_id' => $fx->currency->getKey(),
        ...$payload,
    ]);
}

/**
 * BOF-111 (BAN-483) — the coin and note denominations.
 *
 * Addressed by **id**: unlike most back-office records, `pos_bills` and `pos_notes` carry no uuid
 * column, so they bind the ordinary way rather than through `HasUuid` (BAN-499).
 *
 * `pos_bills` had a table and a model and nothing to reach them, so the denominations were whatever
 * the seeder produced. The register already reads these rows in two places — the close-session count
 * sheet and the payment screen's quick-tender keys (REG-205) — so a venue trading in a currency the
 * seeder did not anticipate counted its drawer against the wrong notes with no way to correct it.
 *
 * Both consumers were already wired before this ticket and are not rebuilt here; verified against
 * `SessionScreen` and `PaymentScreen` first.
 */
it('adds a denomination', function (): void {
    addBill($this->fx)->assertRedirect();

    expect(PosBill::query()->where('name', '20')->exists())->toBeTrue();
});

it('files it against the acting company', function (): void {
    addBill($this->fx)->assertRedirect();

    expect((int) PosBill::query()->where('name', '20')->value('company_id'))
        ->toBe((int) $this->fx->company->getKey());
});

it('refuses a worthless denomination', function (): void {
    // A zero or negative note contributes nothing to a tally that looks right, and the count sheet
    // has no way to show that it did nothing.
    addBill($this->fx, ['value' => '0'])->assertSessionHasErrors('value');
    addBill($this->fx, ['value' => '-5'])->assertSessionHasErrors('value');

    expect(PosBill::query()->count())->toBe(0);
});

it('refuses a denomination kind the count sheet cannot group', function (): void {
    addBill($this->fx, ['denomination_type' => 'doubloon'])->assertSessionHasErrors('denomination_type');
});

it('orders a new denomination after the existing ones', function (): void {
    addBill($this->fx, ['name' => '10', 'value' => '10.00'])->assertRedirect();
    addBill($this->fx, ['name' => '50', 'value' => '50.00'])->assertRedirect();

    $first = (int) PosBill::query()->where('name', '10')->value('sequence');
    $second = (int) PosBill::query()->where('name', '50')->value('sequence');

    expect($second)->toBeGreaterThan($first);
});

it('edits one', function (): void {
    addBill($this->fx)->assertRedirect();
    $bill = PosBill::query()->where('name', '20')->firstOrFail();

    test()->patch(route('pos-bills.update', $bill->getKey()), ['value' => '25.00'])->assertRedirect();

    expect((float) PosBill::query()->whereKey($bill->getKey())->value('value'))->toBe(25.0);
});

it('removes one', function (): void {
    addBill($this->fx)->assertRedirect();
    $bill = PosBill::query()->where('name', '20')->firstOrFail();

    test()->delete(route('pos-bills.destroy', $bill->getKey()))->assertRedirect();

    expect(PosBill::query()->whereKey($bill->getKey())->exists())->toBeFalse();
});

it('never touches another company denomination', function (): void {
    $other = PosFixtures::make();

    $theirs = PosBill::query()->create([
        'company_id' => $other->company->getKey(),
        'currency_id' => $other->currency->getKey(),
        'name' => '500',
        'value' => '500.00',
        'denomination_type' => 'bill',
        'sequence' => 10,
        'active' => true,
    ]);

    test()->delete(route('pos-bills.destroy', $theirs->getKey()))->assertNotFound();

    expect(PosBill::query()->withoutGlobalScopes()->whereKey($theirs->getKey())->exists())->toBeTrue();
});

it('refuses a user who may not configure the register', function (): void {
    addBill($this->fx)->assertRedirect();
    $bill = PosBill::query()->where('name', '20')->firstOrFail();

    test()->actingAs(billActor($this->fx, ['backoffice.access']));

    addBill($this->fx, ['name' => '100', 'value' => '100.00'])->assertForbidden();
    test()->delete(route('pos-bills.destroy', $bill->getKey()))->assertForbidden();

    expect(PosBill::query()->where('name', '100')->exists())->toBeFalse()
        ->and(PosBill::query()->whereKey($bill->getKey())->exists())->toBeTrue();
});

it('reaches the register, which is the only reason this surface exists', function (): void {
    addBill($this->fx, ['name' => '20', 'value' => '20.00'])->assertRedirect();

    $fx = $this->fx->withSession();

    $bills = test()->withHeaders($fx->headers())->getJson('/api/pos/bootstrap')
        ->assertOk()
        ->json('data.pos_bills');

    expect(collect($bills)->pluck('name'))->toContain('20');
});

it('keeps a denomination in another currency off this register count sheet', function (): void {
    // The claim the controller's comment leans on. `currencies` is global reference data, so the
    // rule cannot scope by company — what makes a foreign-currency denomination harmless is that the
    // register filters on its own config's currency, not that it could never be created.
    $euro = (int) $this->fx->currency->getKey();

    $yen = (int) DB::table('currencies')->insertGetId([
        'code' => 'JPY', 'name' => 'Yen', 'symbol' => 'Y',
        'symbol_position' => 'before', 'decimal_places' => 0,
        'created_at' => now(), 'updated_at' => now(),
    ]);

    addBill($this->fx, ['name' => '20', 'value' => '20.00', 'currency_id' => $euro])->assertRedirect();
    addBill($this->fx, ['name' => '5000', 'value' => '5000', 'currency_id' => $yen])->assertRedirect();

    $fx = $this->fx->withSession();

    $names = collect(
        test()->withHeaders($fx->headers())->getJson('/api/pos/bootstrap')->assertOk()->json('data.pos_bills')
    )->pluck('name');

    expect($names)->toContain('20')
        ->and($names)->not->toContain('5000');
});
