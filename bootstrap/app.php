<?php

declare(strict_types=1);

use App\Http\Middleware\AuthenticateDevice;
use App\Http\Middleware\EnsureDeviceAbility;
use App\Http\Middleware\HandleInertiaRequests;
use App\Http\Middleware\ResolveSelfOrderContext;
use App\Http\Middleware\TouchDeviceLastSeen;
use App\Support\Http\ErrorEnvelope;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
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

            // Laravel maps these to a status itself, *after* this callback runs, so taking them
            // over here turns a 401 into a 500 — which the accounting-export auth test caught
            // immediately. Everything Laravel converts in `prepareException` (model-not-found,
            // authorization, CSRF) has already become an `HttpException` by now and needs no entry.
            //
            // Validation is also the one deliberate exception to the envelope: `{message, errors}`
            // carries per-field detail the envelope has nowhere to put, and the client classifies a
            // 422 from the status rather than from the body.
            if ($e instanceof ValidationException || $e instanceof AuthenticationException) {
                return null;
            }

            $status = $e instanceof HttpExceptionInterface ? $e->getStatusCode() : 500;

            // Everything else used to fall through to Laravel's `{"message": …}` — or an HTML page,
            // with debug off and the wrong Accept header. A till can act on neither (BAN-442).
            if ($status >= 500) {
                // The trace goes to the log, not over the wire.
                report($e);
            }

            return response()->json([
                'error' => [
                    'code' => ErrorEnvelope::codeForThrowable($e),
                    'message' => ErrorEnvelope::messageFor($e, $status),
                ],
            ], $status);
        });
    })->create();
