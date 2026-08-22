<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\PaymentMethodCrud;

use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use App\Models\Pos\PaymentMethod;
use App\Models\Pos\PosConfig;
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

it('never lets one cash method sit on two registers', function (): void {
    // BOF-110's second rule. Two tills sharing a cash method means two sessions reconciling against
    // the same drawer: each computes its expected cash from that method, so a float or a movement on
    // one is expected in the other's count. Nobody sees it until a drawer is short — and then the
    // report blames the cashier. Probed before the guard: the same method sat on both and nothing
    // objected (review of #82).
    $second = PosConfig::query()->create([
        ...$this->fx->config->replicate(['uuid', 'access_token'])->getAttributes(),
        'uuid' => (string) Str::uuid(),
        'name' => 'Second till',
        'access_token' => Str::lower(Str::random(32)),
    ]);

    $this->fx->config->paymentMethods()->syncWithoutDetaching([$this->fx->cash->getKey()]);

    test()->patch(route('pos-configs.update', $second->uuid), [
        'payment_method_ids' => [$this->fx->cash->getKey()],
    ])->assertSessionHasErrors('payment_method_ids');

    expect(DB::table('pos_config_payment_method')
        ->where('payment_method_id', $this->fx->cash->getKey())->count())->toBe(1);
});

it('lets two registers share a card method, which has no drawer to double-count', function (): void {
    // The rule is about cash specifically. Card takings are reconciled against the acquirer, not a
    // physical drawer, so sharing one is ordinary.
    $second = PosConfig::query()->create([
        ...$this->fx->config->replicate(['uuid', 'access_token'])->getAttributes(),
        'uuid' => (string) Str::uuid(),
        'name' => 'Second till',
        'access_token' => Str::lower(Str::random(32)),
    ]);

    $this->fx->config->paymentMethods()->syncWithoutDetaching([$this->fx->card->getKey()]);

    test()->patch(route('pos-configs.update', $second->uuid), [
        'payment_method_ids' => [$this->fx->card->getKey()],
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect(DB::table('pos_config_payment_method')
        ->where('payment_method_id', $this->fx->card->getKey())->count())->toBe(2);
});

it('lets a register keep the cash method it already has', function (): void {
    // The check excludes the register being saved, or a register could never save its own settings
    // twice.
    $this->fx->config->paymentMethods()->syncWithoutDetaching([$this->fx->cash->getKey()]);

    // `assertSessionHasNoErrors` alongside the redirect, because a *validation failure* also
    // redirects — asserting the 302 alone passed with the self-exclusion removed, and the pivot
    // count held either way because the sync simply never ran (review of #82).
    test()->patch(route('pos-configs.update', $this->fx->config->uuid), [
        'payment_method_ids' => [$this->fx->cash->getKey()],
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect(DB::table('pos_config_payment_method')
        ->where('payment_method_id', $this->fx->cash->getKey())->count())->toBe(1);
});

// ─────────────────────────────── the rest of the columns (BAN-424, second pass)

it('sets the QR standard and its default payload', function (): void {
    // `qr_code_method` decides which QR spec the till renders — EMVCo, SEPA, Swiss, Pix, UPI. A
    // method left on `none` produces no QR at all, and neither field was reachable before.
    addMethod($this->fx, [
        'name' => 'Scan to pay',
        'method_type' => 'qr_code',
        'qr_code_method' => 'emv',
        'default_qr_payload' => '00020101021126',
    ])->assertSessionHasNoErrors()->assertRedirect();

    $method = PaymentMethod::query()->where('name', 'Scan to pay')->firstOrFail();

    expect($method->qr_code_method->value)->toBe('emv')
        ->and((string) $method->default_qr_payload)->toBe('00020101021126');
});

it('refuses a QR standard the till cannot render', function (): void {
    addMethod($this->fx, ['qr_code_method' => 'semaphore'])->assertSessionHasErrors('qr_code_method');
});

it('stores the terminal configuration and keeps it out of the page', function (): void {
    // `terminal_config` is `encrypted:array` and in the model's `$hidden`: it holds the terminal's
    // pairing secret. It has to be settable and must never come back — an Inertia prop is page
    // source, browser history, and whatever error reporter is watching the props.
    addMethod($this->fx, [
        'name' => 'Front terminal',
        'terminal_provider' => 'stripe',
        'terminal_config' => ['pairing_id' => 'tmr_9f3', 'endpoint' => 'https://terminal.local'],
    ])->assertSessionHasNoErrors()->assertRedirect();

    $method = PaymentMethod::query()->where('name', 'Front terminal')->firstOrFail();

    expect($method->terminal_config)->toBe(['pairing_id' => 'tmr_9f3', 'endpoint' => 'https://terminal.local'])
        // Encrypted at rest, so the raw column is not the payload either.
        ->and((string) DB::table('payment_methods')->where('id', $method->getKey())->value('terminal_config'))
        ->not->toContain('tmr_9f3');

    $props = (string) json_encode(
        test()->get(route('payment-methods.index'))->assertOk()->viewData('page')['props'],
    );

    // One needle per call. `toContain` is variadic, so a second argument is read as another needle,
    // not as a message — and under `->not` the assertion then passes because the "message" is
    // absent. Caught by sabotage: putting `terminal_config` straight back into the payload left this
    // test green.
    expect($props)->not->toContain('tmr_9f3');
    expect($props)->toContain('has_terminal_config');
});

it('says whether a terminal configuration exists, which is all the page needs', function (): void {
    addMethod($this->fx, ['name' => 'Bare method'])->assertRedirect();
    addMethod($this->fx, [
        'name' => 'Wired method',
        'terminal_config' => ['pairing_id' => 'tmr_1'],
    ])->assertRedirect();

    $props = test()->get(route('payment-methods.index'))->viewData('page')['props'];
    $byName = collect($props['methods'])->keyBy('name');

    expect($byName['Bare method']['has_terminal_config'])->toBeFalse()
        ->and($byName['Wired method']['has_terminal_config'])->toBeTrue();
});

it('refuses a terminal configuration that is not a set of keys', function (): void {
    addMethod($this->fx, ['terminal_config' => 'pairing_id=tmr_9f3'])
        ->assertSessionHasErrors('terminal_config');
});

it('points a method at a payment provider, which is what the self-order intent needs', function (): void {
    // The ticket's acceptance criterion: `SelfOrderService::createPaymentIntent` throws "The online
    // payment method has no provider" when `payment_provider_id` is null, and before BAN-424 there
    // was no door through which to set one.
    $provider = DB::table('payment_providers')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Stripe', 'code' => 'stripe', 'state' => 'test',
        'created_at' => now(), 'updated_at' => now(),
    ]);

    addMethod($this->fx, [
        'name' => 'Pay online',
        'method_type' => 'online',
        'payment_provider_id' => $provider,
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect((int) PaymentMethod::query()->where('name', 'Pay online')->value('payment_provider_id'))
        ->toBe((int) $provider);
});

it('refuses an image the venue has no media for', function (): void {
    // Accepted by the endpoint so the column is not the barrier, but validated: there is no media
    // upload route in the app, so any id that arrives is one nobody could have chosen.
    addMethod($this->fx, ['image_media_id' => 999999])->assertSessionHasErrors('image_media_id');
});

it('carries the currencies the page needs to offer a choice', function (): void {
    // The currency control was locked because nothing on the page could name a currency — it
    // rendered the raw id in a disabled number box.
    $props = test()->get(route('payment-methods.index'))->viewData('page')['props'];

    expect($props['currencies'])->not->toBeEmpty()
        ->and($props['currencies'][0])->toHaveKeys(['id', 'code', 'name']);
});
