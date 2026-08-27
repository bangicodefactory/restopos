<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\TipConfig;

use App\Models\Catalog\Product;
use App\Models\Pos\PosConfig;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make();
    // A real permissioned user, not a super-admin: a super-admin passes every policy by
    // short-circuit and would prove nothing about the check.
    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs'));
});

function patchConfig(PosFixtures $fx, array $payload): TestResponse
{
    return test()->patch(route('pos-configs.update', $fx->config->uuid), $payload);
}

/**
 * RST-120, RST-122 (BAN-522) — the two tip settings a manager could not reach.
 *
 * Both columns have existed since the config table was written. `tip_after_payment` decides whether
 * the tip is taken after the sale is settled — the mode this whole ticket is about — and
 * `tip_product_id` names the product tips are booked against. Neither was in the controller's
 * validated set, so the only way to switch a venue into tip-after-payment mode was to edit the
 * database.
 */
it('lets a manager switch the register into tip-after-payment mode', function (): void {
    patchConfig($this->fx, ['tip_after_payment' => true])->assertRedirect();

    expect((bool) PosConfig::query()->whereKey($this->fx->config->getKey())->value('tip_after_payment'))
        ->toBeTrue();
});

it('lets a manager choose the product tips are booked against', function (): void {
    $product = $this->fx->product;

    patchConfig($this->fx, ['tip_product_id' => $product->getKey()])->assertRedirect();

    expect((int) PosConfig::query()->whereKey($this->fx->config->getKey())->value('tip_product_id'))
        ->toBe((int) $product->getKey());
});

it('lets the tip product be cleared again', function (): void {
    patchConfig($this->fx, ['tip_product_id' => $this->fx->product->getKey()])->assertRedirect();
    patchConfig($this->fx, ['tip_product_id' => null])->assertRedirect();

    expect(PosConfig::query()->whereKey($this->fx->config->getKey())->value('tip_product_id'))->toBeNull();
});

it('refuses another company product', function (): void {
    // The same rule BAN-520 settled on the ingest side of a reference like this one: a bare `exists`
    // does not care whose row it is, and this one names where a venue's tips are posted.
    $other = PosFixtures::make();

    patchConfig($this->fx, ['tip_product_id' => $other->product->getKey()])
        ->assertSessionHasErrors('tip_product_id');

    expect(PosConfig::query()->whereKey($this->fx->config->getKey())->value('tip_product_id'))->toBeNull();
});

it('refuses a product that does not exist at all', function (): void {
    patchConfig($this->fx, ['tip_product_id' => 999999])->assertSessionHasErrors('tip_product_id');
});

it('leaves the settings alone when the payload does not mention them', function (): void {
    // Every rule is `sometimes`: a save from another tab must not reset a setting it never showed.
    PosConfig::query()->whereKey($this->fx->config->getKey())->update([
        'tip_after_payment' => true,
        'tip_product_id' => $this->fx->product->getKey(),
    ]);

    patchConfig($this->fx, ['receipt_header' => 'Hello'])->assertRedirect();

    $config = PosConfig::query()->whereKey($this->fx->config->getKey())->firstOrFail();

    expect((bool) $config->tip_after_payment)->toBeTrue()
        ->and((int) $config->tip_product_id)->toBe((int) $this->fx->product->getKey());
});

it('reaches the register, which never declared these columns before', function (): void {
    // The client type had no `enable_tips` or `tip_after_payment` at all, so the register could not
    // ask whether tips were on. The whole config row is already sent — this pins that the two the
    // tip screen gates on are really in it.
    $product = Product::query()->where('company_id', $this->fx->company->getKey())->firstOrFail();

    PosConfig::query()->whereKey($this->fx->config->getKey())->update([
        'enable_tips' => true,
        'tip_after_payment' => true,
        'tip_product_id' => $product->getKey(),
    ]);

    $fx = $this->fx->withSession();
    $device = $fx->device;

    $response = test()->withHeaders($fx->headers())->getJson('/api/pos/bootstrap?profile=register');

    $response->assertOk();

    expect($response->json('data.pos_config.enable_tips'))->toBeTrue()
        ->and($response->json('data.pos_config.tip_after_payment'))->toBeTrue()
        ->and((int) $response->json('data.pos_config.tip_product_id'))->toBe((int) $product->getKey())
        ->and($device)->not->toBeNull();
});
