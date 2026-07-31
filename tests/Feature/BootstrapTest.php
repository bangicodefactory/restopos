<?php

declare(strict_types=1);

use App\Enums\DeviceType;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Services\Device\DevicePairingService;
use App\Services\Device\DeviceTokenService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();
});

it('rejects a bootstrap request without a device token', function (): void {
    $this->getJson('/api/pos/bootstrap')
        ->assertStatus(401)
        ->assertJsonPath('error.code', 'missing_token');
});

it('returns the manifest with per-model counts and an etag', function (): void {
    $response = $this->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap/manifest');

    $response->assertOk()
        ->assertJsonPath('device.uuid', (string) $this->fx->device->uuid)
        ->assertJsonPath('capabilities.restaurant', true)
        ->assertJsonStructure([
            'schema_version', 'min_client_version', 'dataset_fingerprint',
            'config_revision', 'server_time', 'device', 'models', 'capabilities',
        ]);

    expect($response->headers->get('ETag'))->not->toBeEmpty();

    $models = collect($response->json('models'))->keyBy('name');
    expect($models)->toHaveKey('products')
        ->and($models['products']['count'])->toBe(2)
        ->and($models['taxes']['count'])->toBe(1)
        ->and($models['products']['paginated'])->toBeTrue();
});

it('answers 304 when the etag still matches', function (): void {
    $first = $this->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap/manifest');
    $etag = (string) $first->headers->get('ETag');

    $this->withHeaders($this->fx->headers(['If-None-Match' => $etag]))
        ->getJson('/api/pos/bootstrap/manifest')
        ->assertStatus(304);
});

it('returns a payload with data, tombstones, limits and the config', function (): void {
    $response = $this->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap');

    $response->assertOk()
        ->assertJsonStructure(['schema_version', 'server_time', 'watermark', 'limits', 'capabilities', 'pagination', 'data'])
        ->assertJsonPath('profile', 'register')
        ->assertJsonPath('data.pos_config.id', $this->fx->config->getKey())
        ->assertJsonPath('data.pos_session.id', $this->fx->session->getKey());

    expect($response->json('data.products'))->toHaveCount(2)
        ->and($response->json('data.payment_methods'))->toHaveCount(2)
        ->and($response->json('data.taxes'))->toHaveCount(1)
        ->and($response->json('pagination.products.has_more'))->toBeFalse();
});

it('ships per-device employee verifiers, never the pin hash', function (): void {
    $response = $this->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap');

    $employees = collect($response->json('data.employees'))->keyBy('id');

    expect($employees)->toHaveCount(2);

    $cashier = $employees[$this->fx->cashier->getKey()];

    expect($cashier['has_pin'])->toBeTrue()
        ->and($cashier['pin_verifier'])->toBeString()
        ->and($cashier['pin_verifier'])->toHaveLength(64)
        ->and($cashier['abilities'])->toContain('order.create')
        ->and($cashier['abilities'])->not->toContain('session.close.over_variance')
        ->and($employees[$this->fx->manager->getKey()]['abilities'])->toContain('session.close.over_variance');

    // The raw sha256 of the PIN must never appear anywhere in the payload.
    expect(json_encode($response->json()))->not->toContain(hash('sha256', '1234'));
});

it('scopes the payload to the device config and never leaks another company', function (): void {
    $other = PosFixtures::make();
    $other->product->forceFill(['name' => 'Foreign dish'])->save();

    $response = $this->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap');

    $names = collect($response->json('data.products'))->pluck('name')->all();

    expect($names)->not->toContain('Foreign dish')
        ->and($response->json('data.pos_config.id'))->toBe($this->fx->config->getKey());

    $methodIds = collect($response->json('data.payment_methods'))->pluck('id')->all();
    expect($methodIds)->not->toContain($other->cash->getKey());
});

it('paginates products with an opaque cursor', function (): void {
    $this->fx->config->forceFill(['limited_product_count' => 1])->save();

    $first = $this->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap?models=products');

    $first->assertOk();
    expect($first->json('data.products'))->toHaveCount(1)
        ->and($first->json('pagination.products.has_more'))->toBeTrue()
        ->and($first->json('pagination.products.total'))->toBe(2);

    $cursor = $first->json('pagination.products.cursor');

    $second = $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/bootstrap?models=products&cursor='.urlencode((string) $cursor));

    expect($second->json('data.products'))->toHaveCount(1)
        ->and($second->json('data.products.0.id'))->not->toBe($first->json('data.products.0.id'));
});

it('serves the lazy product and customer search endpoints', function (): void {
    $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/products?search=marg')
        ->assertOk()
        ->assertJsonPath('model', 'products')
        ->assertJsonCount(1, 'records');

    $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/customers?search=nobody')
        ->assertOk()
        ->assertJsonPath('model', 'customers')
        ->assertJsonCount(0, 'records');
});

it('returns a delta with changed rows and tombstones', function (): void {
    $since = now()->subMinute()->toIso8601String();

    $this->fx->drink->forceFill(['active' => false])->save();
    $this->fx->product->forceFill(['name' => 'Margherita (new)'])->save();

    $response = $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/delta?since='.urlencode($since).'&models=products');

    $response->assertOk();

    expect($response->json('tombstones.products'))->toContain($this->fx->drink->getKey())
        ->and(collect($response->json('data.products'))->pluck('name'))->toContain('Margherita (new)');
});

it('bumps the dataset fingerprint when the config changes', function (): void {
    $before = $this->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap/manifest')->json('dataset_fingerprint');

    $this->fx->config->bumpRevision();

    $after = $this->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap/manifest')->json('dataset_fingerprint');

    expect($after)->not->toBe($before);
});

it('rejects a revoked device with 410 rather than 401', function (): void {
    $this->fx->device->forceFill(['active' => false])->save();

    $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/bootstrap')
        ->assertStatus(410)
        ->assertJsonPath('error.code', 'device_revoked');
});

it('pairs a device with a back-office code and refuses to reuse it', function (): void {
    /** @var PosConfig $config */
    $config = $this->fx->config;

    $code = app(DevicePairingService::class)
        ->createCode($config, DeviceType::Register, 'Terrace terminal')['code'];

    $response = $this->postJson('/api/devices/pair', [
        'code' => $code,
        'device_type' => 'register',
        'name' => 'Terrace terminal',
    ]);

    $response->assertCreated()
        ->assertJsonStructure(['device', 'config', 'token', 'abilities', 'device_secret'])
        ->assertJsonPath('device.device_identifier', 2)
        ->assertJsonPath('config.id', $config->getKey());

    expect($response->json('abilities'))->toContain('pos:sync');

    // Single use.
    $this->postJson('/api/devices/pair', ['code' => $code])->assertStatus(422);
});

it('verifies an employee pin online and reports the granted ability', function (): void {
    $this->withHeaders($this->fx->headers())
        ->postJson('/api/pos/employees/verify', [
            'employee_id' => $this->fx->manager->getKey(),
            'pin' => '9999',
            'ability' => 'session.close.over_variance',
        ])
        ->assertOk()
        ->assertJsonPath('granted', true)
        ->assertJsonPath('employee.role', 'manager');

    $this->withHeaders($this->fx->headers())
        ->postJson('/api/pos/employees/verify', [
            'employee_id' => $this->fx->cashier->getKey(),
            'pin' => '0000',
        ])
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'invalid_credentials');
});

it('gates endpoints on the token abilities of the device kind', function (): void {
    $display = PosDevice::query()->create([
        'uuid' => (string) Str::uuid(),
        'pos_config_id' => $this->fx->config->getKey(),
        'device_identifier' => 9,
        'name' => 'Kitchen screen',
        'device_type' => DeviceType::PrepDisplay->value,
        'active' => true,
    ]);

    $token = app(DeviceTokenService::class)->issue($display)['token'];

    // A kitchen display holds `pos:catalog` but not `pos:sync`.
    $this->withHeaders(['Authorization' => 'Bearer '.$token, 'Accept' => 'application/json'])
        ->getJson('/api/pos/bootstrap/manifest')
        ->assertOk();

    $this->withHeaders(['Authorization' => 'Bearer '.$token, 'Accept' => 'application/json'])
        ->postJson('/api/pos/sync', ['orders' => [$this->fx->orderCommand((string) Str::uuid())]])
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'missing_ability:pos:sync');
});
