<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\Escalation;

use App\Enums\DeviceType;
use App\Models\Identity\Employee;
use App\Models\Pos\PosDevice;
use App\Models\Pricing\Pricelist;
use App\Models\User;
use App\Services\Device\DevicePairingService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use RuntimeException;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * The two privilege escalations found while planning the rest of Phase 4.
 *
 * Both were reachable on master and both cross a trust boundary rather than merely widening a
 * permission — which is why they are here rather than inside the feature tickets that would
 * eventually have touched the same files.
 */
beforeEach(function (): void {
    $this->other = PosFixtures::make();
    $this->fx = PosFixtures::make();
});

/** A signed-in back-office user holding no roles and no permissions whatsoever. */
function nobody(PosFixtures $fx): User
{
    return User::factory()->create(['company_id' => $fx->company->getKey(), 'is_super_admin' => false]);
}

it('does not let any signed-in user promote an employee to manager', function (): void {
    // Probed on master: 302, `default_role` went cashier → manager, and `pin_hash` became the hash
    // of the value the caller supplied. Role and PIN together are the till's manager credential, so
    // this turned any back-office login into manager authority at the register.
    $this->actingAs(nobody($this->fx));

    $id = $this->fx->cashier->getKey();

    $this->patch("/employees/{$id}", ['default_role' => 'manager', 'pin' => '9999'])
        ->assertForbidden();

    $after = Employee::query()->whereKey($id)->value('default_role');

    expect((string) ($after?->value ?? $after))->toBe('cashier')
        ->and(Employee::query()->whereKey($id)->value('pin_hash'))->not->toBe(hash('sha256', '9999'));
});

it('still lets someone who manages staff do it', function (): void {
    // The negative half — the guard is about permission, not about freezing the field.
    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_employees'));

    $id = $this->fx->cashier->getKey();

    $this->patch("/employees/{$id}", ['default_role' => 'manager'])->assertRedirect();

    $after = Employee::query()->whereKey($id)->value('default_role');

    expect((string) ($after?->value ?? $after))->toBe('manager');
});

it('does not let a pairing code be redeemed as a different kind of device', function (): void {
    // A code minted for a customer display returned a token carrying pos:sync, pos:session,
    // pos:print, pos:realtime and pos:restaurant — a full register. The lobby screen is the
    // lowest-trust device a venue pairs and the easiest to physically reach, so its code is exactly
    // the one worth upgrading.
    $service = app(DevicePairingService::class);
    $code = $service->createCode($this->fx->config, DeviceType::CustomerDisplay, 'Lobby screen');

    $registersBefore = PosDevice::query()->where('device_type', DeviceType::Register->value)->count();

    expect(fn () => $service->pair($code['code'], ['device_type' => 'register']))
        ->toThrow(RuntimeException::class);

    // No register was minted, and the code was not silently consumed into a display either.
    expect(PosDevice::query()->where('device_type', DeviceType::Register->value)->count())
        ->toBe($registersBefore);
});

it('still pairs the device the code was actually issued for', function (): void {
    $service = app(DevicePairingService::class);
    $code = $service->createCode($this->fx->config, DeviceType::CustomerDisplay, 'Lobby screen');

    $paired = $service->pair($code['code'], ['device_type' => 'customer_display']);

    expect($paired['device']->device_type)->toBe(DeviceType::CustomerDisplay);
});

it('pairs on a code that names no type at all, which is the normal client', function (): void {
    // Most clients send only a name. Refusing those would have been a silent regression that no
    // other test covers, because nothing else exercises `pair()`.
    $service = app(DevicePairingService::class);
    $code = $service->createCode($this->fx->config, DeviceType::Register, 'Till 2');

    $paired = $service->pair($code['code'], ['name' => 'Till 2']);

    expect($paired['device']->device_type)->toBe(DeviceType::Register);
});

it('does not list another venue devices', function (): void {
    // `pos_devices` has a `pos_config_id` and no `company_id`, so it carries no `BelongsToCompany`
    // and got no global scope — the list showed every tenant's devices, their names, their user
    // agents and when each was last seen.
    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs'));

    $this->withoutVite();

    // The other venue has a paired device of its own (PosFixtures pairs one per venue), so this
    // asserts against a list that genuinely had something to leak.
    $theirConfigId = (int) $this->other->config->getKey();

    $this->get('/devices')
        ->assertOk()
        ->assertInertia(fn ($page) => $page->where(
            'devices',
            fn ($devices): bool => collect($devices)
                ->pluck('pos_config_id')
                ->doesntContain($theirConfigId),
        ));
});

it('does not let any signed-in user rewrite a price list', function (): void {
    // The register quotes every price from its default pricelist, and this let anyone rename it,
    // change its currency or deactivate it.
    $this->actingAs(nobody($this->fx));

    $pricelist = Pricelist::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'currency_id' => $this->fx->currency->getKey(),
        'name' => 'Standard',
    ]);

    $id = $pricelist->getKey();

    $this->patch("/pricelists/{$id}", ['name' => 'Mine now'])->assertForbidden();

    expect((string) Pricelist::query()->whereKey($pricelist->getKey())->value('name'))->toBe('Standard');
});

it('does not let any signed-in user rotate the self-order token', function (): void {
    // Rotating invalidates every table QR already printed and stuck to a table.
    $this->actingAs(nobody($this->fx));

    $before = (string) $this->fx->config->access_token;

    $this->post("/self-order/{$this->fx->config->uuid}/rotate-token")->assertForbidden();

    expect((string) $this->fx->config->fresh()->access_token)->toBe($before);
});
