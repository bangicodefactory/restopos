<?php

declare(strict_types=1);

use App\Http\Middleware\AuthenticateDevice;
use App\Http\Middleware\EnsureDeviceAbility;
use App\Http\Middleware\HandleInertiaRequests;
use App\Http\Middleware\ResolveSelfOrderContext;
use App\Http\Middleware\TouchDeviceLastSeen;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    // Registered explicitly rather than through `withRouting(channels:)` so that
    // `/broadcasting/auth` runs the **device** middleware instead of `web`:
    // registers, kitchen displays and kiosks are long-lived unattended terminals
    // holding bearer tokens, not cookie sessions (spec 03 §5.3).
    ->withBroadcasting(
        __DIR__.'/../routes/channels.php',
        attributes: ['middleware' => ['device']],
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // Back-office: Inertia shared props on every web request.
        $middleware->web(append: [
            HandleInertiaRequests::class,
        ]);

        $middleware->alias([
            'device.can' => EnsureDeviceAbility::class,
            'self-order' => ResolveSelfOrderContext::class,
        ]);

        // `device` is a *group*, not an alias: authentication first, then the
        // liveness write, which is terminable and so runs after the response has
        // already been sent.
        $middleware->group('device', [
            AuthenticateDevice::class,
            TouchDeviceLastSeen::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        /*
         * The register's outbox classifies failures by status code
         * (spec 03 §3.6.6): `auth` and `version` are blocking, `validation` is
         * per-order, everything else is retryable. So every API error must be
         * machine-readable JSON, never an HTML error page.
         */
        $exceptions->render(function (Throwable $e, Request $request) {
            if (! $request->is('api/*') && ! $request->expectsJson()) {
                return null;
            }

            if (! $e instanceof HttpExceptionInterface) {
                return null;
            }

            $status = $e->getStatusCode();

            return response()->json([
                'error' => [
                    'code' => match ($status) {
                        401 => 'unauthenticated',
                        403 => 'forbidden',
                        404 => 'not_found',
                        409 => 'conflict',
                        410 => 'gone',
                        422 => 'unprocessable',
                        429 => 'rate_limited',
                        default => 'http_error',
                    },
                    'message' => $e->getMessage() !== '' ? $e->getMessage() : 'Request failed.',
                ],
            ], $status);
        });
    })->create();
