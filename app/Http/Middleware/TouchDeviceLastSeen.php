<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Jobs\TouchDeviceSeen;
use App\Models\Pos\PosDevice;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Records device liveness *after* the response is sent, on the queue — a write
 * on every sync request would otherwise sit in the hot path (spec 03 §2.2).
 */
final class TouchDeviceLastSeen
{
    public function handle(Request $request, Closure $next): Response
    {
        return $next($request);
    }

    public function terminate(Request $request, Response $response): void
    {
        $device = $request->attributes->get(AuthenticateDevice::ATTRIBUTE);

        if (! $device instanceof PosDevice) {
            return;
        }

        $version = $request->input('client_version');

        TouchDeviceSeen::dispatch(
            (int) $device->getKey(),
            (string) $request->userAgent(),
            is_string($version) && trim($version) !== '' ? trim($version) : null,
            // A request carrying an `orders` array is a push; a catalogue read is not. That
            // distinction is the whole point of having two columns — "last seen" answers "is this
            // thing switched on", and "last synced" answers "has it actually sent what it took".
            $request->has('orders'),
        );
    }
}
