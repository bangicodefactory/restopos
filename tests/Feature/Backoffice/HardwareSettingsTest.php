<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\HardwareSettings;

use App\Models\Pos\PosConfig;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * The connected-devices tab (BOF-040, BAN-476).
 *
 * The whole group rendered `disabled`, and the ticket calls it a UI unlock. It was not: none of the
 * eight columns was in `PosConfigRequest`, so removing `disabled` alone would have produced a save
 * that reports success and stores nothing — the exact shape behind four premature Dones on this
 * project.
 */
beforeEach(function (): void {
    PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs'));
});

function storedHardware(string $column): mixed
{
    return PosConfig::query()->whereKey(test()->fx->config->getKey())->value($column);
}

it('round-trips the whole connected-devices group', function (): void {
    $uuid = $this->fx->config->uuid;

    $this->patch("/pos-configs/{$uuid}", [
        'use_iot_box' => true,
        'proxy_ip' => '192.168.1.50',
        'iot_scan' => true,
        'iot_scale' => true,
        'iot_print' => true,
        'iot_cashdrawer' => true,
        'use_epos_printer' => true,
        'epos_printer_ip' => '192.168.1.60:8080',
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect((bool) storedHardware('use_iot_box'))->toBeTrue()
        ->and((string) storedHardware('proxy_ip'))->toBe('192.168.1.50')
        ->and((bool) storedHardware('iot_scan'))->toBeTrue()
        ->and((bool) storedHardware('iot_scale'))->toBeTrue()
        ->and((bool) storedHardware('iot_print'))->toBeTrue()
        ->and((bool) storedHardware('iot_cashdrawer'))->toBeTrue()
        ->and((bool) storedHardware('use_epos_printer'))->toBeTrue()
        ->and((string) storedHardware('epos_printer_ip'))->toBe('192.168.1.60:8080');
});

it('accepts a hostname, which a venue with its own DNS will use', function (): void {
    $uuid = $this->fx->config->uuid;

    $this->patch("/pos-configs/{$uuid}", ['proxy_ip' => 'iotbox.local'])
        ->assertSessionHasNoErrors();

    expect((string) storedHardware('proxy_ip'))->toBe('iotbox.local');
});

it('accepts a bracketed IPv6 address with a port', function (): void {
    $uuid = $this->fx->config->uuid;

    $this->patch("/pos-configs/{$uuid}", ['epos_printer_ip' => '[fe80::1]:9100'])
        ->assertSessionHasNoErrors();

    expect((string) storedHardware('epos_printer_ip'))->toBe('[fe80::1]:9100');
});

it('refuses a full URL where an address belongs', function (): void {
    // This is the one that matters. Both fields are addresses a browser on the till fetches from,
    // over plain HTTP with no certificate to notice a change. A URL here — with a scheme, a path or
    // embedded credentials — is a stored SSRF typed into a settings box: every till on this register
    // starts talking to it, and the operator who typed it sees nothing wrong.
    $uuid = $this->fx->config->uuid;

    foreach ([
        'http://evil.example.com/collect',
        'https://user:pass@evil.example.com',
        '192.168.1.50/../../admin',
        'printer.local?callback=x',
    ] as $attempt) {
        $this->patch("/pos-configs/{$uuid}", ['proxy_ip' => $attempt])
            ->assertSessionHasErrors('proxy_ip');
    }

    expect(storedHardware('proxy_ip'))->toBeNull();
});

it('refuses a port that is not a real one', function (): void {
    $uuid = $this->fx->config->uuid;

    $this->patch("/pos-configs/{$uuid}", ['epos_printer_ip' => '192.168.1.60:99999'])
        ->assertSessionHasErrors('epos_printer_ip');
});

it('lets an address be cleared', function (): void {
    // Unplugging the box is as ordinary as plugging it in, and a field that can only be filled is a
    // field an operator has to ask support about.
    $uuid = $this->fx->config->uuid;

    $this->patch("/pos-configs/{$uuid}", ['proxy_ip' => '192.168.1.50'])->assertSessionHasNoErrors();
    $this->patch("/pos-configs/{$uuid}", ['proxy_ip' => null])->assertSessionHasNoErrors();

    expect(storedHardware('proxy_ip'))->toBeNull();
});

it('sets the customer display background, which needed the upload pipeline first', function (): void {
    // Not buildable before BAN-393: a picker here would have offered a choice of nothing.
    Storage::fake('local');

    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs', 'backoffice.manage_media'));

    $id = $this->postJson('/media', [
        'file' => UploadedFile::fake()->image('bg.png', 200, 100),
        'collection' => 'image',
    ])->json('id');

    $uuid = $this->fx->config->uuid;

    $this->patch("/pos-configs/{$uuid}", ['customer_display_bg_media_id' => $id])
        ->assertSessionHasNoErrors();

    expect((int) storedHardware('customer_display_bg_media_id'))->toBe($id);
});
