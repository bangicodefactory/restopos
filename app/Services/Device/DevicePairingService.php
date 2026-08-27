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
        // The type is the one the code was MINTED for. It used to prefer the client's
        // `$attributes['device_type']`, which meant a pairing code created for a customer display
        // could be redeemed as a register — probed: a `customer_display` code returned a token
        // carrying `pos:sync`, `pos:session`, `pos:print`, `pos:realtime` and `pos:restaurant`.
        //
        // A lobby screen is the lowest-trust thing a venue pairs and the easiest to physically
        // reach, so its code is exactly the one an attacker would want to upgrade. The device type
        // decides the ability set, so it has to come from the side that was authorised — the
        // manager who minted the code — not from the side redeeming it.
        $kind = DeviceType::from($payload['device_type']);

        if (isset($attributes['device_type']) && (string) $attributes['device_type'] !== $kind->value) {
            throw new RuntimeException(
                'This pairing code was issued for a '.$kind->value.'. Ask for a code for the device'
                .' you are actually pairing.',
            );
        }

        $fingerprint = $this->normaliseFingerprint($attributes['hardware_fingerprint'] ?? null);

        /** @var PosDevice $device */
        $device = $this->connection->transaction(function () use ($config, $kind, $attributes, $payload, $fingerprint): PosDevice {
            // Is this the same physical machine coming back?
            //
            // A terminal is re-paired for ordinary reasons — the browser storage was cleared, the
            // tablet was reset, the token was revoked and reissued. Without this every one of those
            // minted another row, so a venue's device list filled with ghosts of machines still
            // sitting on the counter and "which of these five is the bar till?" had no answer.
            //
            // Matched within the config, never across: the same tablet moved to another register is
            // a different device there, and recognising it across venues would be a leak.
            $existing = $fingerprint === null
                ? null
                : PosDevice::query()
                    ->where('pos_config_id', $config->getKey())
                    ->where('hardware_fingerprint', $fingerprint)
                    ->first();

            $metadata = [
                'device_type' => $kind->value,
                'user_agent' => $attributes['user_agent'] ?? null,
                'hardware_fingerprint' => $fingerprint,
                'app_version' => $attributes['app_version'] ?? null,
                'paired_at' => now(),
                'last_seen_at' => now(),
                'active' => true,
            ];

            if ($existing !== null) {
                // Its identifier and uuid are kept. Both appear on printed tickets and in the audit
                // trail, and a machine that is physically the same one should not change identity in
                // the history because somebody cleared its cache.
                $existing->forceFill([
                    ...$metadata,
                    'name' => $attributes['name'] ?? $existing->name,
                ])->save();

                return $existing;
            }

            $identifier = $this->allocateIdentifier($config);

            return PosDevice::query()->create([
                ...$metadata,
                'uuid' => (string) Str::uuid(),
                'pos_config_id' => $config->getKey(),
                'device_identifier' => $identifier,
                'name' => $attributes['name'] ?? $payload['name'] ?? ucfirst($kind->value).' '.$identifier,
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
     * A fingerprint worth matching on, or null.
     *
     * An empty or whitespace-only string is what a client sends when it could not compute one, and
     * treating that as a value would match every such device to the first one that failed —
     * handing a new terminal another machine's identity and its history.
     */
    private function normaliseFingerprint(mixed $value): ?string
    {
        $fingerprint = trim((string) ($value ?? ''));

        return $fingerprint === '' ? null : $fingerprint;
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
