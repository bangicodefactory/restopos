<?php

declare(strict_types=1);

namespace App\Services\Device;

use App\Enums\DeviceType;
use App\Models\Pos\PosDevice;
use Illuminate\Contracts\Config\Repository as Config;
use Illuminate\Contracts\Encryption\Encrypter;
use Illuminate\Support\Str;
use Laravel\Sanctum\PersonalAccessToken;

/**
 * Issues, resolves and revokes the Sanctum device tokens used by registers,
 * kitchen displays, kiosks and customer displays (spec 03 §2.2).
 *
 * A device token is `"{tokenId}|{plaintext}"`; only the sha256 of the plaintext
 * is stored. Abilities are per {@see DeviceType} and come from `config/pos.php`.
 *
 * The **device secret** returned alongside the token is *derived*, not stored:
 * `HMAC-SHA256(app_key, "restopos:device-secret:{uuid}")`. It never changes for
 * a given device, survives a database restore, and lets the server recompute
 * the same per-device employee verifiers on every bootstrap (spec 03 §2.3).
 */
final readonly class DeviceTokenService
{
    public function __construct(
        private Config $config,
        private Encrypter $encrypter,
    ) {}

    /**
     * Mint a fresh personal access token for the device.
     *
     * @return array{token: string, abilities: list<string>, id: int}
     */
    public function issue(PosDevice $device): array
    {
        $abilities = $this->abilitiesFor($device->device_type);
        $plain = Str::random(48);

        $token = PersonalAccessToken::forceCreate([
            'tokenable_type' => $device->getMorphClass(),
            'tokenable_id' => $device->getKey(),
            'name' => 'device:'.$device->uuid,
            'token' => hash('sha256', $plain),
            'abilities' => $abilities,
            'expires_at' => null,
        ]);

        return [
            'token' => $token->getKey().'|'.$plain,
            'abilities' => $abilities,
            'id' => (int) $token->getKey(),
        ];
    }

    /** Resolve a bearer string to its token record, or null when unknown/expired. */
    public function resolve(string $bearer): ?PersonalAccessToken
    {
        $token = PersonalAccessToken::findToken($bearer);

        if ($token === null) {
            return null;
        }

        if ($token->expires_at !== null && $token->expires_at->isPast()) {
            return null;
        }

        return $token;
    }

    /** Drop every token of a device — used by back-office revocation. */
    public function revokeAll(PosDevice $device): int
    {
        return PersonalAccessToken::query()
            ->where('tokenable_type', $device->getMorphClass())
            ->where('tokenable_id', $device->getKey())
            ->delete();
    }

    /**
     * The per-device HMAC key used for offline employee verifiers (spec §2.3).
     * Hex-encoded so it can travel through JSON and `crypto.subtle.importKey`.
     */
    public function deviceSecret(PosDevice $device): string
    {
        return hash_hmac('sha256', 'restopos:device-secret:'.$device->uuid, $this->appKey());
    }

    /** @return list<string> */
    public function abilitiesFor(DeviceType $kind): array
    {
        /** @var array<string, list<string>> $map */
        $map = (array) $this->config->get('pos.abilities', []);

        return $map[$kind->value] ?? ['pos:realtime'];
    }

    private function appKey(): string
    {
        $key = (string) $this->config->get('app.key', '');

        if (str_starts_with($key, 'base64:')) {
            $decoded = base64_decode(substr($key, 7), true);

            return $decoded === false ? $key : $decoded;
        }

        // Falls back to the encrypter's key when APP_KEY is not base64 encoded.
        return $key !== '' ? $key : (string) $this->encrypter::class;
    }
}
