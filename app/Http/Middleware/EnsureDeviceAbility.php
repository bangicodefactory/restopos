<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Laravel\Sanctum\PersonalAccessToken;
use Symfony\Component\HttpFoundation\Response;

/**
 * Per-route ability gate for device tokens: `device.can:pos:sync`.
 *
 * Abilities are minted per device kind in `config/pos.php` (spec 03 §2.2), so a
 * kitchen display physically cannot call the sync endpoint even if it steals a
 * register's URL.
 */
final class EnsureDeviceAbility
{
    public function handle(Request $request, Closure $next, string ...$abilities): Response
    {
        $token = $request->attributes->get(AuthenticateDevice::TOKEN_ATTRIBUTE);

        if (! $token instanceof PersonalAccessToken) {
            return $this->deny('missing_token');
        }

        foreach ($abilities as $ability) {
            if (! $token->can($ability)) {
                return $this->deny('missing_ability:'.$ability);
            }
        }

        return $next($request);
    }

    private function deny(string $code): JsonResponse
    {
        return new JsonResponse([
            'error' => ['code' => $code, 'message' => 'This device is not allowed to perform that action.'],
        ], 403);
    }
}
