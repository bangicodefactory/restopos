<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\PosConfigCrud;

use App\Models\Pos\PaymentMethod;
use App\Models\Pos\PosConfig;
use App\Models\Pricing\Currency;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * Opening, copying and archiving a register (BAN-472).
 *
 * A venue could not add a second till. The set of registers was whatever the seeder produced, which
 * made onboarding a new shop impossible through the UI.
 */
beforeEach(function (): void {
    $this->other = PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs'));
});

/** @param array<string, mixed> $payload */
function open(array $payload = []): TestResponse
{
    return test()->post('/pos-configs', [
        'name' => 'Terrasse',
        'currency_id' => test()->fx->currency->getKey(),
        ...$payload,
    ]);
}

it('opens a register', function (): void {
    open()->assertSessionHasNoErrors()->assertRedirect();

    expect(PosConfig::query()->where('name', 'Terrasse')->exists())->toBeTrue();
});

it('opens it in the acting company, not the decoy', function (): void {
    open(['name' => 'Ours'])->assertRedirect();

    expect((int) PosConfig::query()->where('name', 'Ours')->value('company_id'))
        ->toBe((int) $this->fx->company->getKey());
});

it('mints an access token rather than leaving it empty or copied', function (): void {
    // The token is the broadcast channel name and the self-order entry token at once, and it is
    // unique-indexed. A blank or shared one is either a 500 on the second register or two venues
    // listening to each other's channel.
    open(['name' => 'Terrasse'])->assertRedirect();

    $token = (string) PosConfig::query()->where('name', 'Terrasse')->value('access_token');

    expect($token)->not->toBe('')
        ->and($token)->not->toBe((string) $this->fx->config->access_token);
});

it('lands on the new register settings, because that is where the rest is set', function (): void {
    $response = open(['name' => 'Terrasse']);

    $uuid = (string) PosConfig::query()->where('name', 'Terrasse')->value('uuid');

    $response->assertRedirect("/pos-configs/{$uuid}/edit");
});

it('refuses a register with no name', function (): void {
    open(['name' => ''])->assertSessionHasErrors('name');
});

it('refuses a currency that does not exist', function (): void {
    open(['currency_id' => 999999])->assertSessionHasErrors('currency_id');
});

it('refuses someone who may look but not configure', function (): void {
    $this->actingAs($this->fx->userWith('backoffice.access'));

    open(['name' => 'Pas la mienne'])->assertForbidden();

    expect(PosConfig::query()->where('name', 'Pas la mienne')->exists())->toBeFalse();
});

it('copies a register settings rather than making the operator retype eleven tabs', function (): void {
    PosConfig::query()->whereKey($this->fx->config->getKey())->update([
        'tax_display' => 'total',
        'use_cash_rounding' => true,
        'idle_return_seconds' => 90,
    ]);

    test()->post("/pos-configs/{$this->fx->config->uuid}/duplicate")
        ->assertSessionHasNoErrors()->assertRedirect();

    $copy = PosConfig::query()->where('name', $this->fx->config->name.' (2)')->first();

    expect($copy)->not->toBeNull()
        ->and((string) $copy->tax_display->value)->toBe('total')
        ->and((bool) $copy->use_cash_rounding)->toBeTrue()
        ->and((int) $copy->idle_return_seconds)->toBe(90);
});

it('gives the copy its own token and uuid', function (): void {
    test()->post("/pos-configs/{$this->fx->config->uuid}/duplicate")->assertRedirect();

    $copy = PosConfig::query()->where('name', $this->fx->config->name.' (2)')->first();

    expect((string) $copy->access_token)->not->toBe((string) $this->fx->config->access_token)
        ->and((string) $copy->uuid)->not->toBe((string) $this->fx->config->uuid);
});

it('carries the pivots over, since those are the tedious half', function (): void {
    $card = $this->fx->card;

    DB::table('pos_config_payment_method')->insertOrIgnore([
        'pos_config_id' => $this->fx->config->getKey(),
        'payment_method_id' => $card->getKey(),
    ]);

    test()->post("/pos-configs/{$this->fx->config->uuid}/duplicate")->assertRedirect();

    $copy = PosConfig::query()->where('name', $this->fx->config->name.' (2)')->first();

    expect(DB::table('pos_config_payment_method')
        ->where('pos_config_id', $copy->getKey())
        ->where('payment_method_id', $card->getKey())
        ->exists())->toBeTrue();
});

it('never copies a cash payment method', function (): void {
    // BOF-110. A cash method belongs to exactly one register: two tills sharing one means two
    // sessions reconciling against the same drawer, each computing its expected cash from that
    // method — so a float on one is expected in the other's count, and nobody sees it until a
    // drawer is short.
    $cash = $this->fx->cash;

    expect((bool) PaymentMethod::query()->whereKey($cash->getKey())->value('is_cash_count'))->toBeTrue();

    DB::table('pos_config_payment_method')->insertOrIgnore([
        'pos_config_id' => $this->fx->config->getKey(),
        'payment_method_id' => $cash->getKey(),
    ]);

    test()->post("/pos-configs/{$this->fx->config->uuid}/duplicate")->assertRedirect();

    $copy = PosConfig::query()->where('name', $this->fx->config->name.' (2)')->first();

    expect(DB::table('pos_config_payment_method')
        ->where('pos_config_id', $copy->getKey())
        ->where('payment_method_id', $cash->getKey())
        ->exists())->toBeFalse();
});

it('names the second copy differently again', function (): void {
    test()->post("/pos-configs/{$this->fx->config->uuid}/duplicate")->assertRedirect();
    test()->post("/pos-configs/{$this->fx->config->uuid}/duplicate")->assertRedirect();

    expect(PosConfig::query()->where('name', $this->fx->config->name.' (2)')->exists())->toBeTrue()
        ->and(PosConfig::query()->where('name', $this->fx->config->name.' (3)')->exists())->toBeTrue();
});

it('does not copy another company register', function (): void {
    test()->post("/pos-configs/{$this->other->config->uuid}/duplicate")->assertNotFound();
});

it('archives a register instead of deleting it', function (): void {
    // Every session, order and payment this register took names it, and `pos_orders.pos_config_id`
    // is `restrictOnDelete` besides — a hard delete is a 500 with nothing naming the cause.
    $id = $this->fx->config->getKey();

    test()->delete("/pos-configs/{$this->fx->config->uuid}")->assertSessionHasNoErrors()->assertRedirect();

    expect(PosConfig::query()->whereKey($id)->exists())->toBeTrue()
        ->and((bool) PosConfig::query()->whereKey($id)->value('active'))->toBeFalse();
});

it('refuses to archive a register with a session open', function (): void {
    // Closing a register mid-service strands the drawer count.
    $fx = $this->fx->withSession();

    test()->delete("/pos-configs/{$fx->config->uuid}")->assertSessionHasErrors('config');

    expect((bool) PosConfig::query()->whereKey($fx->config->getKey())->value('active'))->toBeTrue();
});

it('bumps the revision on archive so tills stop offering it', function (): void {
    $before = (int) PosConfig::query()->whereKey($this->fx->config->getKey())->value('config_revision');

    test()->delete("/pos-configs/{$this->fx->config->uuid}")->assertRedirect();

    expect((int) PosConfig::query()->whereKey($this->fx->config->getKey())->value('config_revision'))
        ->toBeGreaterThan($before);
});

it('offers the currencies the create form needs', function (): void {
    // `index()` never sent them, so the form would have rendered an empty picker.
    $this->withoutVite();

    Currency::query()->firstOrCreate(
        ['code' => 'USD'],
        ['name' => 'Dollar', 'symbol' => '$', 'decimal_places' => 2, 'rounding' => '0.01'],
    );

    $this->get('/pos-configs')
        ->assertOk()
        ->assertInertia(fn ($page) => $page->where(
            'currencies',
            fn ($currencies): bool => collect($currencies)->pluck('code')->contains('USD'),
        ));
});
