<?php

declare(strict_types=1);

// Own namespace so the scanner helpers below do not pollute the global function table (Pest loads
// every test file into one process). The Pest DSL (`uses`, `it`, `expect`) and PHP built-ins
// resolve via the global-namespace fallback.

namespace Tests\Feature\RouteContract;

use Illuminate\Support\Facades\Route;
use Symfony\Component\Finder\Finder;
use Tests\TestCase;

uses(TestCase::class);

/*
|--------------------------------------------------------------------------
| Route contract (spec §2.16)
|--------------------------------------------------------------------------
|
| Every URL the client (`resources/js`) asks for must resolve to a route the
| server actually registers, with a verb that route accepts. This is the
| regression guard for the cold-start class of bug (BAN-394): the client asked
| for `GET /api/pos/{configId}/bootstrap` while the shipped route is
| device-scoped (`GET /api/pos/bootstrap`, no config id in the path), so every
| fresh register 404'd. The delta puller had the identical defect, and the
| reachability probe a third (`/api/pos/ping` vs the shipped `/api/ping`). All
| three share one root cause — client and route disagreeing on a string — and
| all three would have been caught on the first run by this test.
|
| Three contracts are checked here:
|
|   1. api paths  — every `/api/**` path the register/KDS/self-order requests
|   2. api verbs  — and that the route accepts the method used to request it
|   3. web paths  — every builder in the back-office `routes.ts` helper, whose
|                   own docblock claims it mirrors `routes/web.php`
|
| Out of scope: middleware, payload shape and response contract. A route
| existing and accepting the verb does not make the call correct — that is what
| the endpoint tests are for.
|
| Only string/template literals are scanned; a path assembled from variables is
| invisible here. `assertScannerVerbsCoverApiClient()` is what stops that gap
| widening silently.
*/

/**
 * Every registered route as `['segments' => [...], 'methods' => [...]]`, restricted to `$prefix`.
 *
 * A `{param}` segment becomes `*`; the leading prefix segment is dropped.
 *
 * @return list<array{segments: list<string>, methods: list<string>}>
 */
function routePatterns(?string $prefix): array
{
    $patterns = [];

    foreach (Route::getRoutes() as $route) {
        $uri = $route->uri();

        if ($prefix !== null) {
            if ($uri !== $prefix && ! str_starts_with($uri, $prefix.'/')) {
                continue;
            }
            $rel = ltrim(substr($uri, strlen($prefix)), '/');
        } else {
            // Web routes: everything that is *not* under `api/`.
            if ($uri === 'api' || str_starts_with($uri, 'api/')) {
                continue;
            }
            $rel = ltrim($uri, '/');
        }

        $rel = $rel === '/' ? '' : $rel;
        $raw = $rel === '' ? [] : explode('/', $rel);

        $segments = array_map(
            static fn (string $seg): string => preg_match('/^\{.+\}$/', $seg) === 1 ? '*' : $seg,
            $raw,
        );

        $methods = array_values(array_filter(
            $route->methods(),
            static fn (string $m): bool => $m !== 'HEAD',
        ));

        // An optional parameter (`{any?}`) makes one route match several arities: the PWA shells
        // are `/pos/{config}/{any?}`, which serves `/pos/3` and `/pos/3/tables` alike. Emit one
        // pattern per arity so a client path is compared against a shape the route really accepts —
        // treating the route as fixed-length rejected every shell URL the back office builds.
        $optional = 0;

        for ($i = count($raw) - 1; $i >= 0; $i--) {
            if (preg_match('/^\{.+\?\}$/', $raw[$i]) !== 1) {
                break;
            }
            $optional++;
        }

        for ($length = count($segments) - $optional; $length <= count($segments); $length++) {
            $patterns[] = [
                'segments' => array_slice($segments, 0, $length),
                'methods' => $methods,
            ];
        }
    }

    return $patterns;
}

/**
 * Normalise a client path literal to prefix-relative segments (`${…}` → `*`), or null if it is not
 * a concrete request path.
 *
 * Note what this deliberately does *not* do: judge whether the path looks plausible. Callers
 * establish that a literal is a request path by *where it was found* — passed to an `ApiClient`
 * method, written as an absolute `/api/…`, or returned by a back-office URL builder — never by
 * inspecting the string. An earlier version filtered on "does the first segment match a route
 * prefix we already know", which meant a typo in that very segment (`poss/bootstrap`) made the
 * path invisible instead of failing. The commonest typo silently disabled the check written to
 * catch it.
 *
 * @return list<string>|null
 */
function normaliseClientPath(string $raw, ?string $prefix): ?array
{
    // A literal `*` marks a glob or documentation pattern (a service-worker route, a doc comment
    // like `/api/kitchen/*`), never a concrete request path — the `${…}` → `*` normalisation below
    // is the only thing that introduces a wildcard segment.
    if (str_contains($raw, '*')) {
        return null;
    }

    $path = strtok($raw, '?');                          // drop any query string
    $path = preg_replace('/\$\{[^}]*\}/', '*', $path);  // template expr → wildcard segment
    $path = ltrim((string) $path, '/');

    if ($prefix !== null && str_starts_with($path, $prefix.'/')) {
        $path = substr($path, strlen($prefix) + 1);     // absolute `/api/…` form
    }

    $path = rtrim($path, '/');

    if ($path === '') {
        return null;
    }

    return array_map(
        static fn (string $seg): string => str_contains($seg, '*') ? '*' : $seg,
        explode('/', $path),
    );
}

/**
 * How a client reference measures up against the route table.
 *
 * Returns `ok`, `no-path` (nothing of that shape is registered) or the list of methods the matching
 * route *does* accept (so the failure message can say what the caller should have used).
 *
 * @param  list<string>  $client
 * @param  list<array{segments: list<string>, methods: list<string>}>  $patterns
 * @return array{status: string, allowed: list<string>}
 */
function resolveClientPath(array $client, ?string $method, array $patterns): array
{
    $allowed = [];

    foreach ($patterns as $pattern) {
        if (count($pattern['segments']) !== count($client)) {
            continue;
        }

        $matched = true;

        foreach ($pattern['segments'] as $i => $routeSeg) {
            // A route param (`*`) accepts any client segment. Otherwise a route *literal* must equal
            // the client segment exactly — a client dynamic segment (`*`) does NOT satisfy a route
            // literal. That asymmetry is the point: without it, `pos/*/bootstrap` would borrow a
            // same-length route like `pos/orders/{order}` and the cold-start regression would pass.
            if ($routeSeg !== '*' && $routeSeg !== $client[$i]) {
                $matched = false;
                break;
            }
        }

        if (! $matched) {
            continue;
        }

        if ($method === null || in_array($method, $pattern['methods'], true)) {
            return ['status' => 'ok', 'allowed' => []];
        }

        $allowed = array_values(array_unique([...$allowed, ...$pattern['methods']]));
    }

    return $allowed === []
        ? ['status' => 'no-path', 'allowed' => []]
        : ['status' => 'wrong-method', 'allowed' => $allowed];
}

/**
 * Distinct client API references, keyed by `METHOD /path`.
 *
 * A literal counts as a request path because of **who it was passed to**, not because of how it
 * looks: the receiver must be an `ApiClient` (`api.`, `this.client.`, `runtime.api.`). That is what
 * keeps `catalog.productsById.get(id)`, `db.orders.get(uuid)` and `router.get(url)` out — all of
 * which are `.get()` calls on something that is not an HTTP client — while leaving *every* literal
 * an ApiClient receives subject to the contract, however mistyped.
 *
 * @return array<string, array{segments: list<string>, method: ?string, path: string, file: string}>
 */
function clientApiReferences(): array
{
    $files = Finder::create()
        ->files()
        ->in(base_path('resources/js'))
        ->name(['*.ts', '*.tsx'])
        ->notName(['*.test.ts', '*.test.tsx', '*.d.ts'])
        ->exclude(['__fixtures__', '__mocks__']);

    // `api.get('…')` / `this.client.post('…')` — verb is the method name, path the first argument.
    $verbCall = '/\b(?:api|client)\.(get|post|delete)(?![A-Za-z0-9_])\s*(?:<[^>]*>)?\s*\(\s*([\'"`])([^\'"`]+)\2/';
    // `api.request('METHOD', '…')` — verb is the first argument, path the second.
    $request = '/\b(?:api|client|this)\.request(?![A-Za-z0-9_])\s*(?:<[^>]*>)?\s*\(\s*[\'"`]([A-Z]+)[\'"`]\s*,\s*([\'"`])([^\'"`]+)\2/';
    // Absolute `'/api/…'` literals (e.g. the reachability probe's `fetch`). Single/double quotes
    // only — NOT backticks: JSDoc inline code-spans use backticks (`/api/kitchen/*`) and are
    // documentation, not calls; real absolute request paths are plain quoted string literals.
    // The verb is unknowable from the literal alone, so these are path-only checks.
    $absolute = '/([\'"])(\/api\/[^\'"?\s]*)\1/';

    $refs = [];

    foreach ($files as $file) {
        $src = $file->getContents();
        $rel = str_replace('\\', '/', substr($file->getPathname(), strlen(base_path()) + 1));

        preg_match_all($verbCall, $src, $verbMatches, PREG_SET_ORDER);
        preg_match_all($request, $src, $requestMatches, PREG_SET_ORDER);
        preg_match_all($absolute, $src, $absoluteMatches, PREG_SET_ORDER);

        $found = [];
        foreach ($verbMatches as $m) {
            $found[] = [strtoupper($m[1]), $m[3]];
        }
        foreach ($requestMatches as $m) {
            $found[] = [strtoupper($m[1]), $m[3]];
        }
        foreach ($absoluteMatches as $m) {
            $found[] = [null, $m[2]];
        }

        foreach ($found as [$method, $raw]) {
            $segments = normaliseClientPath($raw, 'api');

            if ($segments === null) {
                continue;
            }

            $key = ($method ?? 'ANY').' '.implode('/', $segments);
            $refs[$key] ??= ['segments' => $segments, 'method' => $method, 'path' => $raw, 'file' => $rel];
        }
    }

    return $refs;
}

/**
 * Every path literal returned by a builder in the back-office `routes.ts` helper.
 *
 * @return array<string, string> canonical path → the literal it came from
 */
function backofficeRouteBuilders(): array
{
    $source = (string) file_get_contents(base_path('resources/js/backoffice/lib/routes.ts'));

    // `name: (args): string => '/path'` or `` => `/path/${id}` ``
    //
    // Returned with duplicates intact. Several builders legitimately share a path and differ only
    // by the verb the caller uses — `index`/`store` are both `/categories`, `update`/`destroy` both
    // `/categories/${id}` — so deduping here would under-count against the declarations in the file
    // and make the anti-rot check below cry wolf.
    preg_match_all('/=>\s*([\'"`])(\/[^\'"`]*)\1/', $source, $matches);

    return $matches[2];
}

/** How many URL builders `routes.ts` declares, however they are written. */
function backofficeBuilderCount(): int
{
    $source = (string) file_get_contents(base_path('resources/js/backoffice/lib/routes.ts'));

    return preg_match_all('/^\s+[A-Za-z]+:\s*\(/m', $source);
}

it('every api path referenced by the client resolves to a route in routes/api.php', function (): void {
    $patterns = routePatterns('api');
    expect($patterns)->not->toBeEmpty('No `api/*` routes were registered — is routes/api.php loaded?');

    $refs = clientApiReferences();

    // Sanity: the scanner must actually find the core client endpoints, or the regex has rotted.
    expect(array_keys($refs))->toContain('GET pos/bootstrap', 'GET pos/delta');

    $unresolved = [];

    foreach ($refs as $ref) {
        if (resolveClientPath($ref['segments'], null, $patterns)['status'] !== 'ok') {
            $canonical = implode('/', $ref['segments']);
            $unresolved[] = "  /api/{$canonical}   (referenced as `{$ref['path']}` in {$ref['file']})";
        }
    }

    expect($unresolved)->toBe(
        [],
        "Client references API paths with no matching route in routes/api.php:\n".implode("\n", $unresolved),
    );
});

it('every api call uses a method its route accepts', function (): void {
    // A path that exists is not a contract: `POST`ing to a `GET`-only route 405s just as fatally as
    // a 404, and the register classifies both as retryable rather than as a bug.
    $patterns = routePatterns('api');
    $refs = clientApiReferences();

    $mismatched = [];

    foreach ($refs as $ref) {
        if ($ref['method'] === null) {
            continue; // Bare `/api/…` literal: no verb to check.
        }

        $result = resolveClientPath($ref['segments'], $ref['method'], $patterns);

        if ($result['status'] === 'wrong-method') {
            $canonical = implode('/', $ref['segments']);
            $allowed = implode('|', $result['allowed']);
            $mismatched[] = "  {$ref['method']} /api/{$canonical} — route accepts {$allowed}   (in {$ref['file']})";
        }
    }

    expect($mismatched)->toBe(
        [],
        "Client calls an API route with a method it does not accept:\n".implode("\n", $mismatched),
    );
});

it('the scanner knows every verb the ApiClient exposes', function (): void {
    // The scanner reads `.get(`, `.post(` and `.request('VERB',`. If the client grows a `patch()`
    // or `delete()` helper, those calls become invisible to this contract and the guard above
    // quietly stops guarding. Fail here instead, pointing at the regex that needs widening.
    $source = (string) file_get_contents(base_path('resources/js/shared/sync/http.ts'));

    // The generic parameter is optional. An earlier version required a `<` before the paren, so a
    // non-generic `delete(path: string)` slipped past — the guard against the scanner going blind
    // had gone blind in the same way.
    preg_match_all('/^\s{4}(?:async\s+)?([a-z][A-Za-z0-9]*)\s*(?:<[^>]*>)?\s*\(/m', $source, $matches);

    $known = ['get', 'post', 'delete', 'request', 'constructor'];
    $unknown = array_values(array_diff(array_unique($matches[1]), $known));

    expect($unknown)->toBe(
        [],
        'ApiClient exposes verb helper(s) the route-contract scanner does not read: '
            .implode(', ', $unknown).'. Widen $verbCall in clientApiReferences().',
    );
});

it('every back-office URL builder resolves to a route in routes/web.php', function (): void {
    // `routes.ts` says of itself: "URL builders for every back-office route in routes/web.php … a
    // typo here is a compile error at the call site instead of a 404 in production". TypeScript
    // proves the *builder* is called correctly; only this proves the builder is right.
    //
    // Path-only: the verb lives at the `router.patch(...)` call site, not in the builder.
    $patterns = routePatterns(null);

    $builders = backofficeRouteBuilders();

    // Anti-rot, matching the api scanner's: a regex that has stopped matching passes silently, and
    // "not empty" is satisfied by one surviving builder while the other fifty go unchecked. Pin the
    // count against the declarations in the file, and name two paths that must be found.
    expect(count($builders))->toBe(
        backofficeBuilderCount(),
        'The routes.ts scanner matched '.count($builders).' of '.backofficeBuilderCount()
            .' declared builders — has the file changed shape?',
    );

    expect($builders)->toContain('/login', '/pos-configs');

    $unresolved = [];

    foreach (array_unique($builders) as $literal) {
        $segments = normaliseClientPath($literal, null);

        if ($segments === null) {
            continue; // `/` — the dashboard, which has no segments to match.
        }

        if (resolveClientPath($segments, null, $patterns)['status'] !== 'ok') {
            $unresolved[] = "  {$literal}";
        }
    }

    expect($unresolved)->toBe(
        [],
        "Back-office routes.ts builds URLs with no matching route in routes/web.php:\n"
            .implode("\n", $unresolved),
    );
});
