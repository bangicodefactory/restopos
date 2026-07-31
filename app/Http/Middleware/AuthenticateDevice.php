<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Models\Pos\PosDevice;
use App\Services\Device\DeviceTokenService;
use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Resolves the Sanctum device token on `/api/pos`, `/api/kitchen` and the kiosk
 * surface (spec 03 §2.2).
 *
 * On success the device is bound as the request user (so `routes/channels.php`
 * and policies see it) and exposed on the `device` / `device_token` request
 * attributes. A revoked device gets `410 Gone` — never `401` — because the till
 * must be able to tell "you were unpaired" apart from "your token is wrong",
 * and its queued orders are quarantined rather than lost.
 */
final class AuthenticateDevice
{
    public const ATTRIBUTE = 'pos_device';

    public const TOKEN_ATTRIBUTE = 'pos_device_token';

    public function __construct(private readonly DeviceTokenService $tokens) {}

    public function handle(Request $request, Closure $next): Response
    {
        $bearer = $request->bearerToken();

        if ($bearer === null || $bearer === '') {
            return $this->deny('missing_token', 'A device bearer token is required.', 401);
        }

        $token = $this->tokens->resolve($bearer);

        if ($token === null) {
            return $this->deny('invalid_token', 'Unknown or expired device token.', 401);
        }

        $device = $token->tokenable;

        if (! $device instanceof PosDevice) {
            return $this->deny('invalid_token', 'This token does not belong to a device.', 401);
        }

        if (! $device->active) {
            return $this->deny('device_revoked', 'This device has been revoked.', 410);
        }

        $request->attributes->set(self::ATTRIBUTE, $device);
        $request->attributes->set(self::TOKEN_ATTRIBUTE, $token);
        $request->setUserResolver(static fn (): PosDevice => $device);

        return $next($request);
    }

    private function deny(string $code, string $message, int $status): JsonResponse
    {
        return new JsonResponse(['error' => ['code' => $code, 'message' => $message]], $status);
    }
}
