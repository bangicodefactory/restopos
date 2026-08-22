<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\PaymentMethodCrud;

use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use App\Models\Pos\PaymentMethod;
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
function methodActor(PosFixtures $fx, array $permissions): User
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
    $this->actingAs(methodActor($this->fx, ['config.view', 'config.manage']));
});

/** @param array<string, mixed> $payload */
function addMethod(PosFixtures $fx, array $payload = []): TestResponse
{
    return test()->post(route('payment-methods.store'), [
        'name' => 'Meal vouchers',
        'method_type' => 'bank',
        'currency_id' => $fx->currency->getKey(),
        ...$payload,
    ]);
}

/**
 * BOF-110 (BAN-424) — adding and removing a payment method, and the fields the tills branch on.
 *
 * The editor could rename a method and flip its flags. It could not change `method_type`,
 * `terminal_provider` or `currency_id` — whether a tender counts into the drawer, which driver the
 * payment screen talks to, and what unit the amount is in. A seeded method could never be repointed
 * at a real terminal, and a venue could not add the card machine it owns.
 */
it('adds a method', function (): void {
    addMethod($this->fx)->assertRedirect();

    expect(PaymentMethod::query()->where('name', 'Meal vouchers')->exists())->toBeTrue();
});

it('files it against the acting company', function (): void {
    addMethod($this->fx)->assertRedirect();

    expect((int) PaymentMethod::query()->where('name', 'Meal vouchers')->value('company_id'))
        ->toBe((int) $this->fx->company->getKey());
});

it('sets the kind, which decides whether the tender counts into the drawer', function (): void {
    addMethod($this->fx, ['name' => 'Petty cash', 'method_type' => 'cash', 'is_cash_count' => true])
        ->assertRedirect();

    expect(PaymentMethod::query()->where('name', 'Petty cash')->value('method_type')->value)->toBe('cash');
});

it('points a method at a terminal, which was unreachable before', function (): void {
    addMethod($this->fx, ['terminal_provider' => 'stripe'])->assertRedirect();

    expect(PaymentMethod::query()->where('name', 'Meal vouchers')->value('terminal_provider')->value)
        ->toBe('stripe');
});

it('refuses a kind the till cannot handle', function (): void {
    addMethod($this->fx, ['method_type' => 'barter'])->assertSessionHasErrors('method_type');
});

it('refuses a terminal the register has no driver for', function (): void {
    addMethod($this->fx, ['terminal_provider' => 'carrier_pigeon'])
        ->assertSessionHasErrors('terminal_provider');
});

it('changes an existing method kind', function (): void {
    addMethod($this->fx)->assertRedirect();
    $method = PaymentMethod::query()->where('name', 'Meal vouchers')->firstOrFail();

    test()->patch(route('payment-methods.update', $method->getKey()), ['method_type' => 'customer_account'])
        ->assertRedirect();

    expect(PaymentMethod::query()->whereKey($method->getKey())->value('method_type')->value)
        ->toBe('customer_account');
});

it('freezes a method while a session is open on a register that uses it', function (): void {
    // BOF-110, and the reason is arithmetic rather than ceremony: the session's expected cash was
    // computed against this method as it stood at open. Flip `is_cash_count` at lunchtime and the
    // drawer that balanced at 11am is short at close, with nothing on the report explaining why.
    addMethod($this->fx)->assertRedirect();
    $method = PaymentMethod::query()->where('name', 'Meal vouchers')->firstOrFail();

    $this->fx->config->paymentMethods()->syncWithoutDetaching([$method->getKey()]);
    $this->fx->withSession();

    test()->patch(route('payment-methods.update', $method->getKey()), ['is_cash_count' => true])
        ->assertSessionHasErrors('name');

    expect((bool) PaymentMethod::query()->whereKey($method->getKey())->value('is_cash_count'))->toBeFalse();
});

it('still allows a reorder mid-session, which only moves a button', function (): void {
    addMethod($this->fx)->assertRedirect();
    $method = PaymentMethod::query()->where('name', 'Meal vouchers')->firstOrFail();

    $this->fx->config->paymentMethods()->syncWithoutDetaching([$method->getKey()]);
    $this->fx->withSession();

    test()->patch(route('payment-methods.update', $method->getKey()), ['sequence' => 99])->assertRedirect();

    expect((int) PaymentMethod::query()->whereKey($method->getKey())->value('sequence'))->toBe(99);
});

it('allows the change once no session is open', function (): void {
    // The control: it is the open session that freezes the method, not the register using it.
    addMethod($this->fx)->assertRedirect();
    $method = PaymentMethod::query()->where('name', 'Meal vouchers')->firstOrFail();

    $this->fx->config->paymentMethods()->syncWithoutDetaching([$method->getKey()]);

    test()->patch(route('payment-methods.update', $method->getKey()), ['is_cash_count' => true])
        ->assertRedirect();

    expect((bool) PaymentMethod::query()->whereKey($method->getKey())->value('is_cash_count'))->toBeTrue();
});

it('removes a method nothing has been paid through', function (): void {
    addMethod($this->fx)->assertRedirect();
    $method = PaymentMethod::query()->where('name', 'Meal vouchers')->firstOrFail();

    test()->deleteJson(route('payment-methods.destroy', $method->getKey()))->assertRedirect();

    expect(PaymentMethod::query()->whereKey($method->getKey())->exists())->toBeFalse();
});

it('refuses to remove a method money has gone through', function (): void {
    // `pos_payments.payment_method_id` is `restrictOnDelete`, so without the guard the database
    // refuses too — as a 500 with nothing naming the cause.
    $fx = $this->fx->withSession();
    $uuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        ]], ['state' => 'paid'], [[
            'op' => 'create', 'uuid' => (string) Str::uuid(),
            'payment_method_id' => $fx->card->getKey(),
            'amount' => '12.10', 'is_change' => false, 'is_refund' => false, 'payment_status' => 'done',
        ]])],
    ])->assertOk();

    $response = test()->deleteJson(route('payment-methods.destroy', $fx->card->getKey()))->assertStatus(422);

    // And it says what to do instead, because the delete can never succeed.
    expect((string) json_encode($response->json()))->toContain('Deactivate');
    expect(PaymentMethod::query()->whereKey($fx->card->getKey())->exists())->toBeTrue();
});

it('takes its register links with it', function (): void {
    addMethod($this->fx)->assertRedirect();
    $method = PaymentMethod::query()->where('name', 'Meal vouchers')->firstOrFail();
    $this->fx->config->paymentMethods()->syncWithoutDetaching([$method->getKey()]);

    test()->deleteJson(route('payment-methods.destroy', $method->getKey()))->assertRedirect();

    expect(DB::table('pos_config_payment_method')->where('payment_method_id', $method->getKey())->count())
        ->toBe(0);
});

it('never touches another company method', function (): void {
    $other = PosFixtures::make();

    test()->deleteJson(route('payment-methods.destroy', $other->card->getKey()))->assertNotFound();

    expect(PaymentMethod::query()->withoutGlobalScopes()->whereKey($other->card->getKey())->exists())
        ->toBeTrue();
});

it('refuses a user who may not configure the register', function (): void {
    addMethod($this->fx)->assertRedirect();
    $method = PaymentMethod::query()->where('name', 'Meal vouchers')->firstOrFail();

    test()->actingAs(methodActor($this->fx, ['config.view']));

    addMethod($this->fx, ['name' => 'Sneaky'])->assertForbidden();
    test()->deleteJson(route('payment-methods.destroy', $method->getKey()))->assertForbidden();

    expect(PaymentMethod::query()->where('name', 'Sneaky')->exists())->toBeFalse()
        ->and(PaymentMethod::query()->whereKey($method->getKey())->exists())->toBeTrue();
});
