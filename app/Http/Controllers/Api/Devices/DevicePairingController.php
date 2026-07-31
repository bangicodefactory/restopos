<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Devices;

use App\Http\Controllers\Controller;
use App\Http\Middleware\AuthenticateDevice;
use App\Http\Requests\Device\PairDeviceRequest;
use App\Http\Resources\Pos\DevicePairingResource;
use App\Models\Pos\PosDevice;
use App\Services\Device\DevicePairingService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;

/**
 * Device enrolment (spec 03 §2.2).
 *
 * The only unauthenticated write in the register API, and the only one that can
 * mint a long-lived token — hence the single-use, short-TTL pairing code and the
 * throttle on the route.
 */
final class DevicePairingController extends Controller
{
    public function __construct(private readonly DevicePairingService $pairing) {}

    /** `POST /api/devices/pair` */
    public function store(PairDeviceRequest $request): JsonResponse
    {
        try {
            $result = $this->pairing->pair((string) $request->validated('code'), [
                'name' => $request->validated('name'),
                'device_type' => $request->validated('device_type'),
                'user_agent' => $request->userAgent(),
            ]);
        } catch (RuntimeException $e) {
            return new JsonResponse(['error' => ['code' => 'invalid_pairing_code', 'message' => $e->getMessage()]], 422);
        }

        return DevicePairingResource::make($result)->response()->setStatusCode(201);
    }

    /** `GET /api/devices/me` — a cheap liveness/identity probe for the client. */
    public function show(Request $request): JsonResponse
    {
        /** @var PosDevice $device */
        $device = $request->attributes->get(AuthenticateDevice::ATTRIBUTE);

        return new JsonResponse([
            'device' => [
                'id' => (int) $device->getKey(),
                'uuid' => (string) $device->uuid,
                'name' => $device->name,
                'device_identifier' => (int) $device->device_identifier,
                'device_type' => $device->device_type->value,
                'pos_config_id' => (int) $device->pos_config_id,
            ],
            'server_time' => now()->toIso8601ZuluString('microsecond'),
            'min_client_version' => (string) config('pos.api.min_client_version'),
        ]);
    }

    /** `DELETE /api/devices/me` — a device unpairing itself (factory reset). */
    public function destroy(Request $request): JsonResponse
    {
        /** @var PosDevice $device */
        $device = $request->attributes->get(AuthenticateDevice::ATTRIBUTE);

        $this->pairing->revoke($device);

        return new JsonResponse(null, 204);
    }
}
