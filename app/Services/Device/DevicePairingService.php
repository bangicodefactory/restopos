<?php

declare(strict_types=1);

namespace App\Services\Device;

use App\Enums\DeviceType;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use Illuminate\Contracts\Cache\Repository as Cache;
use Illuminate\Contracts\Config\Repository as Config;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Str;
use RuntimeException;

/**
 * The pairing-code flow (spec 03 §2.2).
 *
 * A manager generates a short, single-use, 10-minute code in the back-office;
 * the fresh device posts it to `POST /api/devices/pair` and receives its Sanctum
 * token, its derived device secret and its `device_identifier` — the small
 * integer that namespaces the device's offline order references (spec §6.1).
 *
 * Codes live in the cache, not in a table: they are ephemeral, single-use and
 * the schema has no home for them.
 */
final readonly class DevicePairingService
{
    public function __construct(
        private Cache $cache,
        private Config $config,
        private ConnectionInterface $connection,
        private DeviceTokenService $tokens,
    ) {}

    /**
     * Create a pairing code for a config. Returned to the back-office as text
     * and as a QR payload.
     *
     * @return array{code: string, expires_at: string, ttl_seconds: int}
     */
    public function createCode(PosConfig $config, DeviceType $kind, ?string $name = null, ?int $createdByUserId = null): array
    {
        $ttl = (int) $this->config->get('pos.pairing.ttl_seconds', 600);
        $code = $this->generateCode();

        $this->cache->put($this->cacheKey($code), [
            'pos_config_id' => $config->getKey(),
            'device_type' => $kind->value,
            'name' => $name,
            'created_by_user_id' => $createdByUserId,
        ], $ttl);

        return [
            'code' => $code,
            'expires_at' => now()->addSeconds($ttl)->toIso8601String(),
            'ttl_seconds' => $ttl,
        ];
    }

    /** Peek at a code without consuming it. */
    public function isValid(string $code): bool
    {
        return $this->cache->has($this->cacheKey($this->normalise($code)));
    }

    /**
     * Consume a code and enrol the device.
     *
     * @param  array{name?: string|null, user_agent?: string|null, device_type?: string|null}  $attributes
     * @return array{device: PosDevice, config: PosConfig, token: string, abilities: list<string>, device_secret: string}
     */
    public function pair(string $code, array $attributes = []): array
    {
        $key = $this->cacheKey($this->normalise($code));
        /** @var array{pos_config_id: int, device_type: string, name: ?string, created_by_user_id: ?int}|null $payload */
        $payload = $this->cache->get($key);

        if ($payload === null) {
            throw new RuntimeException('Pairing code is invalid or has expired.');
        }

        $this->cache->forget($key);

        $config = PosConfig::query()->findOrFail($payload['pos_config_id']);
        $kind = DeviceType::tryFrom((string) ($attributes['device_type'] ?? $payload['device_type']))
            ?? DeviceType::from($payload['device_type']);

        /** @var PosDevice $device */
        $device = $this->connection->transaction(function () use ($config, $kind, $attributes, $payload): PosDevice {
            $identifier = $this->allocateIdentifier($config);

            return PosDevice::query()->create([
                'uuid' => (string) Str::uuid(),
                'pos_config_id' => $config->getKey(),
                'device_identifier' => $identifier,
                'name' => $attributes['name'] ?? $payload['name'] ?? ucfirst($kind->value).' '.$identifier,
                'device_type' => $kind->value,
                'user_agent' => $attributes['user_agent'] ?? null,
                'last_seen_at' => now(),
                'active' => true,
            ]);
        });

        $issued = $this->tokens->issue($device);

        return [
            'device' => $device,
            'config' => $config,
            'token' => $issued['token'],
            'abilities' => $issued['abilities'],
            'device_secret' => $this->tokens->deviceSecret($device),
        ];
    }

    /**
     * Retire a device: its tokens die immediately and the identifier is never
     * re-used, so a re-paired terminal cannot collide with its own history.
     */
    public function revoke(PosDevice $device): void
    {
        $this->tokens->revokeAll($device);
        $device->forceFill(['active' => false])->save();
    }

    /**
     * `device_identifier` is allocated under a row lock on the config so two
     * simultaneous pairings can never share a reference namespace (spec §6.1).
     */
    private function allocateIdentifier(PosConfig $config): int
    {
        PosConfig::query()->whereKey($config->getKey())->lockForUpdate()->first();

        $max = (int) PosDevice::query()
            ->where('pos_config_id', $config->getKey())
            ->max('device_identifier');

        return $max + 1;
    }

    private function generateCode(): string
    {
        $alphabet = (string) $this->config->get('pos.pairing.alphabet', '23456789ABCDEFGHJKLMNPQRSTUVWXYZ');
        $length = (int) $this->config->get('pos.pairing.code_length', 8);

        do {
            $code = '';
            for ($i = 0; $i < $length; $i++) {
                $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
            }
        } while ($this->cache->has($this->cacheKey($code)));

        return $code;
    }

    private function normalise(string $code): string
    {
        return strtoupper(trim($code));
    }

    private function cacheKey(string $code): string
    {
        return (string) $this->config->get('pos.pairing.cache_prefix', 'pos:pairing:').$code;
    }
}
