<?php

declare(strict_types=1);

namespace App\Http\Resources\Pos;

use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * The one-time pairing answer (spec 03 §2.2).
 *
 * `token` and `device_secret` are shown **once** and never re-issued. The client
 * stores them in IndexedDB — not `localStorage`, which is synchronous,
 * string-only, more readily scraped by injected script, and cleared by the same
 * "clear site data" flows the service worker survives.
 *
 * @property array<string, mixed> $resource
 */
final class DevicePairingResource extends JsonResource
{
    public static $wrap = null;

    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        /** @var array{device: PosDevice, config: PosConfig, token: string, abilities: list<string>, device_secret: string} $data */
        $data = $this->resource;
        $device = $data['device'];
        $config = $data['config'];

        return [
            'device' => [
                'id' => (int) $device->getKey(),
                'uuid' => (string) $device->uuid,
                'name' => $device->name,
                'device_identifier' => (int) $device->device_identifier,
                'device_type' => (string) ($device->device_type?->value ?? $device->device_type),
            ],
            'config' => [
                'id' => (int) $config->getKey(),
                'name' => (string) $config->name,
                'access_token' => (string) $config->access_token,
                'is_restaurant' => (bool) $config->is_restaurant,
                'currency_id' => (int) $config->currency_id,
            ],
            'token' => $data['token'],
            'abilities' => $data['abilities'],
            'device_secret' => $data['device_secret'],
            'server_time' => now()->toIso8601ZuluString('microsecond'),
            'min_client_version' => (string) config('pos.api.min_client_version'),
            'schema_version' => (int) config('pos.api.schema_version'),
        ];
    }
}
