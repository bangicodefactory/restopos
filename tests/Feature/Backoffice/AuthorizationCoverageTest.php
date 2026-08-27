<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\AuthorizationCoverage;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Route as RoutingRoute;
use Illuminate\Support\Facades\Route;
use ReflectionClass;
use ReflectionMethod;
use ReflectionNamedType;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * Every back-office write must authorize.
 *
 * `routes/web.php` puts the whole back office behind a bare `Route::middleware(['auth'])` with no
 * permission middleware, so the *only* thing between a signed-in user and any write is an
 * authorization check inside the handler. Four controllers had none:
 *
 *   - `EmployeeController::update` — probed with a user holding no roles and no permissions at all:
 *     302, cashier promoted to manager, attacker's own PIN written to the record. The PIN is the
 *     till credential and the role is what the register checks before a void, a price override or
 *     an over-variance close, so this was a walk-up escalation to manager authority *at the till*.
 *   - `DeviceController::destroy` — revoke any tenant's device and brick their register mid-service.
 *   - `PricelistController::update` — rename, re-currency or deactivate the price list a register
 *     quotes every price from.
 *   - `SelfOrderSettingsController::update` and `rotateToken` — rotating invalidates every printed
 *     table QR in the venue.
 *
 * Plus `FloorController::rotateTableToken`, the one write in an otherwise fully guarded file.
 *
 * **Write methods are taken from the router, not from method names.** Guessing by name was the first
 * attempt and it was wrong in both directions: it flagged `ReportController::salesDetails` and
 * `DashboardController::__invoke`, which are GETs, and it would have missed any write named
 * something other than store/update/destroy. The routing table already knows which verbs write.
 *
 * A handler counts as guarded if it calls `Gate::authorize`/`$this->authorize`, **or** takes a
 * FormRequest — those authorize before the method body runs. The second test below checks those
 * FormRequests actually do, so this cannot be satisfied by a request class that returns true.
 */

/** @return array{unguarded: list<string>, requests: list<string>, checked: int} */
function backofficeWrites(): array
{
    $unguarded = [];
    $requests = [];
    $checked = 0;

    /** @var RoutingRoute $route */
    foreach (Route::getRoutes() as $route) {
        $verbs = array_intersect($route->methods(), ['POST', 'PUT', 'PATCH', 'DELETE']);

        if ($verbs === []) {
            continue;
        }

        $action = $route->getActionName();

        if (! str_contains($action, 'Controllers\\Backoffice\\') || ! str_contains($action, '@')) {
            continue;
        }

        [$class, $method] = explode('@', $action, 2);

        if (! class_exists($class) || ! method_exists($class, $method)) {
            continue;
        }

        $checked++;

        $reflection = new ReflectionMethod($class, $method);
        $file = (string) $reflection->getFileName();
        $lines = file($file) ?: [];
        $body = implode('', array_slice(
            $lines,
            $reflection->getStartLine() - 1,
            $reflection->getEndLine() - $reflection->getStartLine() + 1,
        ));

        if (str_contains($body, 'Gate::authorize') || str_contains($body, '$this->authorize')) {
            continue;
        }

        $formRequest = null;

        foreach ($reflection->getParameters() as $parameter) {
            $type = $parameter->getType();

            if (! $type instanceof ReflectionNamedType || $type->isBuiltin()) {
                continue;
            }

            $name = $type->getName();

            if (is_subclass_of($name, FormRequest::class)) {
                $formRequest = $name;
            }
        }

        if ($formRequest !== null) {
            $requests[] = $formRequest;

            continue;
        }

        $unguarded[] = class_basename($class).'::'.$method;
    }

    sort($unguarded);

    return ['unguarded' => $unguarded, 'requests' => array_values(array_unique($requests)), 'checked' => $checked];
}

it('leaves no back-office write reachable without an authorization check', function (): void {
    $found = backofficeWrites();

    expect($found['checked'])->toBeGreaterThan(25, 'the router scan found almost nothing — it has drifted');

    expect($found['unguarded'])->toBe(
        [],
        'reachable by any authenticated user: '.implode(', ', $found['unguarded']),
    );
});

it('does not let a FormRequest count as a guard while rubber-stamping', function (): void {
    // The escape hatch above is only honest if `authorize()` actually decides something. A request
    // that returns true unconditionally is `authorize(): bool { return true; }` — which is Laravel's
    // own default, and therefore the shape this would silently acquire.
    $rubberStamps = [];

    foreach (backofficeWrites()['requests'] as $class) {
        $reflection = new ReflectionClass($class);

        if (! $reflection->hasMethod('authorize')) {
            $rubberStamps[] = class_basename($class).' (inherits the default authorize)';

            continue;
        }

        $method = $reflection->getMethod('authorize');
        $lines = file((string) $method->getFileName()) ?: [];
        $body = implode('', array_slice(
            $lines,
            $method->getStartLine() - 1,
            $method->getEndLine() - $method->getStartLine() + 1,
        ));

        if (preg_match('/return\s+true\s*;/', $body) === 1) {
            $rubberStamps[] = class_basename($class);
        }
    }

    expect($rubberStamps)->toBe([], 'these FormRequests authorize nothing: '.implode(', ', $rubberStamps));
});
