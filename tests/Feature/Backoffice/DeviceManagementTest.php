<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\DeviceManagement;

use App\Enums\DeviceType;
use App\Jobs\TouchDeviceSeen;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Services\Device\DevicePairingService;
use App\Services\Pos\BootstrapService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * Pairing metadata, re-pair recognition and the back-office device surface (BAN-456).
 *
 * Nothing covered `pair()` before this file — which is how a pairing code minted for a customer
 * display could be redeemed as a register for as long as it could (fixed separately, covered in
 * `EscalationTest`).
 */
beforeEach(function (): void {
    $this->other = PosFixtures::make();
    $this->fx = PosFixtures::make();
});

function pairWith(PosFixtures $fx, array $attributes = []): array
{
    $service = app(DevicePairingService::class);
    $code = $service->createCode($fx->config, DeviceType::Register, 'Till');

    return $service->pair($code['code'], $attributes);
}

it('keeps the metadata it has always validated and thrown away', function (): void {
    // `PairDeviceRequest` has validated `hardware_fingerprint` and `app_version` since it was
    // written, and the controller passed neither to `pair()` — with no column to hold them anyway.
    $paired = pairWith($this->fx, [
        'name' => 'Comptoir',
        'hardware_fingerprint' => 'machine-abc',
        'app_version' => '2.4.1',
    ]);

    $device = $paired['device']->fresh();

    expect((string) $device->hardware_fingerprint)->toBe('machine-abc')
        ->and((string) $device->app_version)->toBe('2.4.1')
        ->and($device->paired_at)->not->toBeNull();
});

it('keeps the metadata when it arrives the way a real device sends it', function (): void {
    // Through the HTTP endpoint, not the service.
    //
    // The defect was *in the controller*: it validated `hardware_fingerprint` and `app_version` and
    // then did not pass them on. Every other test here calls `pair()` directly, so a sabotage that
    // removed the controller's two lines passed clean — the tests never went through the code that
    // was broken.
    $service = app(DevicePairingService::class);
    $code = $service->createCode($this->fx->config, DeviceType::Register, 'Till');

    $this->postJson('/api/devices/pair', [
        'code' => $code['code'],
        'name' => 'Comptoir',
        'hardware_fingerprint' => 'machine-http',
        'app_version' => '3.1.4',
    ])->assertSuccessful();

    $device = PosDevice::query()->where('hardware_fingerprint', 'machine-http')->first();

    expect($device)->not->toBeNull()
        ->and((string) $device->app_version)->toBe('3.1.4')
        ->and((string) $device->name)->toBe('Comptoir');
});

it('recognises the same machine coming back instead of adding a ghost', function (): void {
    // A terminal is re-paired for ordinary reasons: storage cleared, tablet reset, token revoked.
    // Each one used to mint another row, so a venue's list filled with ghosts of machines still
    // sitting on the counter.
    $first = pairWith($this->fx, ['hardware_fingerprint' => 'machine-abc', 'name' => 'Comptoir']);
    $before = PosDevice::query()->where('pos_config_id', $this->fx->config->getKey())->count();

    $second = pairWith($this->fx, ['hardware_fingerprint' => 'machine-abc']);

    expect(PosDevice::query()->where('pos_config_id', $this->fx->config->getKey())->count())
        ->toBe($before)
        ->and((int) $second['device']->getKey())->toBe((int) $first['device']->getKey());
});

it('keeps the identifier and uuid a re-paired machine already had', function (): void {
    // Both appear on printed tickets and in the audit trail. A machine that is physically the same
    // one should not change identity in the history because somebody cleared its cache.
    $first = pairWith($this->fx, ['hardware_fingerprint' => 'machine-abc']);
    $identifier = (int) $first['device']->device_identifier;
    $uuid = (string) $first['device']->uuid;

    $second = pairWith($this->fx, ['hardware_fingerprint' => 'machine-abc']);

    expect((int) $second['device']->device_identifier)->toBe($identifier)
        ->and((string) $second['device']->uuid)->toBe($uuid);
});

it('keeps the name an operator gave it when the re-pair supplies none', function (): void {
    pairWith($this->fx, ['hardware_fingerprint' => 'machine-abc', 'name' => 'Bar']);

    $second = pairWith($this->fx, ['hardware_fingerprint' => 'machine-abc']);

    expect((string) $second['device']->name)->toBe('Bar');
});

it('treats two machines that report no fingerprint as two machines', function (): void {
    // The dangerous case. An empty fingerprint is what a client sends when it could not compute
    // one, and matching on it would hand every such terminal the first one's identity, its
    // identifier and its history.
    $first = pairWith($this->fx, ['hardware_fingerprint' => '']);
    $second = pairWith($this->fx, ['hardware_fingerprint' => '   ']);
    $third = pairWith($this->fx);

    expect([$first['device']->getKey(), $second['device']->getKey(), $third['device']->getKey()])
        ->toHaveCount(3)
        ->and(array_unique([
            (int) $first['device']->getKey(),
            (int) $second['device']->getKey(),
            (int) $third['device']->getKey(),
        ]))->toHaveCount(3);
});

it('does not recognise the same tablet across two venues', function (): void {
    // The same physical tablet moved to another register is a different device there. Matching
    // across configs would let one venue's pairing reach into another's device list.
    $ours = pairWith($this->fx, ['hardware_fingerprint' => 'machine-abc']);
    $theirs = pairWith($this->other, ['hardware_fingerprint' => 'machine-abc']);

    expect((int) $theirs['device']->getKey())->not->toBe((int) $ours['device']->getKey())
        ->and((int) $theirs['device']->pos_config_id)->toBe((int) $this->other->config->getKey());
});

it('lets an operator name a device without revoking it', function (): void {
    // The only way to correct a label was to revoke the device and re-pair it — a service
    // interruption on a terminal that is working fine.
    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs'));

    // Addressed by uuid: these models bind by uuid and do not override `getRouteKeyName()`, so an
    // id URL 404s (the BAN-499 contract).
    $device = $this->fx->device;

    $this->patch("/devices/{$device->uuid}", ['name' => 'Bar du haut'])
        ->assertSessionHasNoErrors()->assertRedirect();

    expect((string) PosDevice::query()->whereKey($device->getKey())->value('name'))->toBe('Bar du haut');
});

it('refuses a rename from someone who may only look', function (): void {
    $this->actingAs($this->fx->userWith('backoffice.access'));

    $device = $this->fx->device;
    $before = (string) $device->name;

    $this->patch("/devices/{$device->uuid}", ['name' => 'Pas le mien'])->assertForbidden();

    expect((string) PosDevice::query()->whereKey($device->getKey())->value('name'))->toBe($before);
});

it('ships the register own minimum client version, not only the deploy constant', function (): void {
    // The constant is deploy-wide, so raising the floor for a venue that had updated its tills
    // raised it for every venue that had not.
    config()->set('pos.api.min_client_version', '1.0.0');

    PosConfig::query()->whereKey($this->fx->config->getKey())->update(['min_client_version' => '3.2.0']);

    $payload = app(BootstrapService::class)->payload(
        $this->fx->config->fresh(),
        $this->fx->device,
        ['pos_config'],
    );

    expect((string) $payload['min_client_version'])->toBe('3.2.0');
});

it('falls back to the deploy constant when a register sets none', function (): void {
    // The negative half: a venue that never touches this must behave exactly as before.
    config()->set('pos.api.min_client_version', '1.4.0');

    $payload = app(BootstrapService::class)->payload(
        $this->fx->config->fresh(),
        $this->fx->device,
        ['pos_config'],
    );

    expect((string) $payload['min_client_version'])->toBe('1.4.0');
});

it('records the version a device is actually running, not the one it was paired on', function (): void {
    $device = $this->fx->device;

    (new TouchDeviceSeen((int) $device->getKey(), 'agent', '2.9.0'))->handle();

    expect((string) PosDevice::query()->whereKey($device->getKey())->value('app_version'))->toBe('2.9.0');
});

it('leaves the recorded version alone when a request reports none', function (): void {
    // Most requests do not carry a version. Blanking on those would make the column useless — it
    // would read as null except in the instant after a sync.
    $device = $this->fx->device;

    (new TouchDeviceSeen((int) $device->getKey(), 'agent', '2.9.0'))->handle();
    (new TouchDeviceSeen((int) $device->getKey(), 'agent', null))->handle();

    expect((string) PosDevice::query()->whereKey($device->getKey())->value('app_version'))->toBe('2.9.0');
});

it('stamps last_synced_at only when the device actually pushed something', function (): void {
    // The column has been on the table and rendered on the devices page since both were written,
    // and nothing ever wrote it — so "last synced" was blank on every device, forever.
    $device = $this->fx->device;

    (new TouchDeviceSeen((int) $device->getKey(), 'agent', null, synced: false))->handle();

    expect(PosDevice::query()->whereKey($device->getKey())->value('last_synced_at'))->toBeNull();

    (new TouchDeviceSeen((int) $device->getKey(), 'agent', null, synced: true))->handle();

    expect(PosDevice::query()->whereKey($device->getKey())->value('last_synced_at'))->not->toBeNull();
});
